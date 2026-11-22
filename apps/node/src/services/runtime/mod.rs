pub mod ports;

use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::Duration,
};

use anyhow::Result;
use tokio::{process::Child, time::Instant};
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{CoreSource, HostInfo, Instance, InstanceState, RuntimeStatus, Snapshot},
};

use crate::{
    extensions::Cores,
    infra::{config::Settings, installer},
};

pub struct Managed {
    pub config: Instance,
    pub epoch: Uuid,
    child: Child,
}

struct FailedInstance {
    config: Instance,
    state: InstanceState,
    error: String,
    attempts: u32,
    next_retry: Instant,
}

pub struct Supervisor {
    cores: Cores,
    root: PathBuf,
    core_management: bool,
    instances: BTreeMap<Uuid, Managed>,
    failed: BTreeMap<Uuid, FailedInstance>,
    pub revision: Option<String>,
}

impl Supervisor {
    pub(crate) fn new(cores: Cores, root: PathBuf, core_management: bool) -> Self {
        Self {
            cores,
            root,
            core_management,
            instances: BTreeMap::new(),
            failed: BTreeMap::new(),
            revision: None,
        }
    }

    pub fn host_info(&self) -> HostInfo {
        installer::host_info(self.core_management)
    }

    pub fn reload_cores(&mut self, settings: &Settings) -> Result<()> {
        self.cores.reload(settings)
    }

    pub fn core_source(&self, core: Core) -> Option<CoreSource> {
        self.cores.source(core)
    }

    pub fn has_running_core(&mut self, core: Core) -> bool {
        self.instances
            .values_mut()
            .any(|item| item.config.core == core && matches!(item.child.try_wait(), Ok(None)))
    }

    pub async fn capabilities(&self) -> Vec<yuzuki_protocol::v1::Capability> {
        self.cores.capabilities().await
    }

    pub fn instances(&self) -> impl Iterator<Item = &Managed> {
        self.instances.values()
    }

    /// Inspect running children, transition any unexpectedly exited processes into
    /// fault-isolated `failed` state with bounded backoff retry, and return statuses
    /// for all desired instances without dropping the control connection.
    pub fn statuses(&mut self) -> Vec<RuntimeStatus> {
        let mut exited = Vec::new();
        for (&id, item) in &mut self.instances {
            match item.child.try_wait() {
                Ok(None) => {}
                Ok(Some(exit)) => {
                    exited.push((id, format!("core process exited ({exit})")));
                }
                Err(error) => {
                    exited.push((id, format!("unable to inspect process state: {error}")));
                }
            }
        }
        for (id, reason) in exited {
            if let Some(item) = self.instances.remove(&id) {
                tracing::warn!(%id, core = %item.config.core, %reason, "managed core instance exited");
                self.record_failure(item.config, InstanceState::Stopped, reason, 1);
            }
        }

        let mut list = Vec::with_capacity(self.instances.len() + self.failed.len());
        for &id in self.instances.keys() {
            list.push(RuntimeStatus {
                instance_id: id,
                running: true,
                state: InstanceState::Running,
                error: None,
            });
        }
        for (&id, item) in &self.failed {
            list.push(RuntimeStatus {
                instance_id: id,
                running: false,
                state: item.state,
                error: Some(item.error.clone()),
            });
        }
        list.sort_by_key(|status| status.instance_id);
        list
    }

    pub async fn restart_instance(&mut self, id: Uuid) -> Result<()> {
        let config = if let Some(mut existing) = self.instances.remove(&id) {
            let _ = existing.child.kill().await;
            let _ = existing.child.wait().await;
            existing.config
        } else if let Some(failed) = self.failed.remove(&id) {
            failed.config
        } else {
            return Ok(());
        };
        if let Err((state, err)) = self.validate_and_start(config.clone()).await {
            self.record_failure(config, state, err.clone(), 1);
            anyhow::bail!("{err}");
        }
        Ok(())
    }

    pub fn reset_retries_for_core(&mut self, core: Core) {
        let now = Instant::now();
        for item in self.failed.values_mut() {
            if item.config.core == core {
                item.next_retry = now;
                item.attempts = 0;
            }
        }
    }

    /// Retry failed or stopped instances whose backoff timer has elapsed.
    pub async fn retry_due(&mut self) -> bool {
        let now = Instant::now();
        let due_ids: Vec<Uuid> = self
            .failed
            .iter()
            .filter(|(_, item)| item.next_retry <= now)
            .map(|(&id, _)| id)
            .collect();
        let mut changed = false;
        for id in due_ids {
            let Some(item) = self.failed.remove(&id) else {
                continue;
            };
            let next_attempts = item.attempts.saturating_add(1);
            match self.validate_and_start(item.config.clone()).await {
                Ok(()) => {
                    tracing::info!(%id, core = %item.config.core, "recovered core instance");
                    changed = true;
                }
                Err((state, err)) => {
                    if state != item.state || err != item.error {
                        changed = true;
                    }
                    self.record_failure(item.config, state, err, next_attempts);
                }
            }
        }
        changed
    }

    pub async fn stop(&mut self) {
        for (_, mut instance) in std::mem::take(&mut self.instances) {
            let _ = instance.child.kill().await;
            let _ = instance.child.wait().await;
        }
        self.failed.clear();
        self.revision = None;
    }

    /// Apply a desired snapshot with per-instance fault isolation.
    ///
    /// A single misconfigured instance or missing core binary only marks that
    /// instance as `Failed` / `MissingCore` and never tears down healthy
    /// instances or breaks the Board control session.
    pub async fn apply(&mut self, snapshot: Snapshot) -> Vec<RuntimeStatus> {
        let mut desired = BTreeMap::new();
        for instance in snapshot.instances {
            desired.insert(instance.id, instance);
        }

        let mut keep = BTreeSet::new();
        for (&id, instance) in &desired {
            if let Some(current) = self.instances.get_mut(&id)
                && current.config == *instance
                && matches!(current.child.try_wait(), Ok(None))
            {
                keep.insert(id);
            }
        }

        // Stop instances removed from snapshot or whose configuration changed.
        let to_stop: Vec<Uuid> = self
            .instances
            .keys()
            .filter(|id| !keep.contains(id))
            .copied()
            .collect();
        for id in to_stop {
            if let Some(mut current) = self.instances.remove(&id) {
                let _ = current.child.kill().await;
                let _ = current.child.wait().await;
            }
        }

        // Remove failed records that are no longer desired or whose config changed.
        self.failed.retain(|id, item| {
            desired
                .get(id)
                .is_some_and(|next| *next == item.config && !keep.contains(id))
        });

        for (id, instance) in desired {
            if keep.contains(&id) {
                self.failed.remove(&id);
                continue;
            }
            if let Err((state, err)) = self.validate_and_start(instance.clone()).await {
                tracing::warn!(%id, core = %instance.core, ?state, error = %err, "instance failed to start");
                self.record_failure(instance, state, err, 1);
            } else {
                self.failed.remove(&id);
            }
        }

        self.revision = Some(snapshot.revision);
        self.statuses()
    }

    fn record_failure(
        &mut self,
        config: Instance,
        state: InstanceState,
        error: String,
        attempts: u32,
    ) {
        let delay_secs = match attempts {
            0 | 1 => 5,
            2 => 15,
            3 => 30,
            _ => 60,
        };
        let sanitized: String = error
            .chars()
            .filter(|c| !c.is_control() || *c == ' ')
            .take(360)
            .collect();
        self.failed.insert(
            config.id,
            FailedInstance {
                config,
                state,
                error: sanitized,
                attempts,
                next_retry: Instant::now() + Duration::from_secs(delay_secs),
            },
        );
    }

    async fn validate_and_start(
        &mut self,
        config: Instance,
    ) -> std::result::Result<(), (InstanceState, String)> {
        let id = config.id;
        let runtime = match self.cores.get(config.core) {
            Ok(runtime) => runtime,
            Err(error) => return Err((InstanceState::MissingCore, error.to_string())),
        };
        if let Err(error) = runtime
            .validate(&config, &self.root.join("validate").join(id.to_string()))
            .await
        {
            return Err((InstanceState::Failed, format!("validation failed: {error}")));
        }
        let child = match runtime
            .start(&config, &self.root.join("instances").join(id.to_string()))
            .await
        {
            Ok(child) => child,
            Err(error) => return Err((InstanceState::Failed, format!("startup failed: {error}"))),
        };
        self.instances.insert(
            id,
            Managed {
                config,
                child,
                epoch: Uuid::new_v4(),
            },
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::config::CoreManagementSettings;
    use serde_json::json;

    #[tokio::test]
    async fn apply_isolates_missing_core_failures_and_updates_revision() {
        let dir = std::env::temp_dir().join(format!("yuzuki-sup-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Settings {
            board_url: "https://control.example.net:3443".parse().unwrap(),
            ca_certificate: String::new(),
            state_dir: dir.clone(),
            binaries: Default::default(),
            core_management: CoreManagementSettings {
                enabled: true,
                detect_system_binaries: false,
                download_mirror: None,
                allow_http_downloads: false,
            },
            config_warnings: Vec::new(),
        };
        let cores = Cores::builtins(&settings).unwrap();
        let mut supervisor = Supervisor::new(cores, dir.clone(), true);
        let id = Uuid::new_v4();
        let statuses = supervisor
            .apply(Snapshot {
                revision: "rev-fault-isolated".into(),
                instances: vec![Instance {
                    id,
                    core: Core::Xray,
                    config: json!({"inbounds": []}),
                    meter: None,
                }],
            })
            .await;

        assert_eq!(supervisor.revision.as_deref(), Some("rev-fault-isolated"));
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].instance_id, id);
        assert!(!statuses[0].running);
        assert_eq!(statuses[0].state, InstanceState::MissingCore);
        assert!(statuses[0].error.is_some());

        // Removing the failed instance cleans it up cleanly.
        let statuses = supervisor
            .apply(Snapshot {
                revision: "rev-empty".into(),
                instances: vec![],
            })
            .await;
        assert!(statuses.is_empty());
        assert_eq!(supervisor.revision.as_deref(), Some("rev-empty"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
