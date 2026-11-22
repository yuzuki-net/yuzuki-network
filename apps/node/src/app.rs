use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use tokio::{sync::mpsc, time::Instant};
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{
        BoardMessage, Capability, CoreAction, CoreActionRequest, CoreActionStage, CoreSource,
        InstanceDevices, MAX_ONLINE_INSTANCES, MAX_ONLINE_SOURCES, NodeMessage, UsageBatch,
    },
};

use crate::{
    extensions::Cores,
    infra::{
        config::{Command, Settings},
        filesystem,
        identity::{self, Identity},
        installer,
        metering::NativeCollector,
        signals,
        sqlite::Outbox,
        transport::Wss,
    },
    services::{
        control::ports::ControlTransport, metering::ports::UsageCollector, runtime::Supervisor,
    },
};

pub async fn run(mut settings: Settings, command: Command) -> Result<()> {
    filesystem::directory(&settings.state_dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(settings.state_dir.join("node.lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .context("another Node process is using this state directory")?;
    match command {
        Command::Enroll => {
            let token =
                std::env::var("YUZUKI_ENROLLMENT_TOKEN").context("set YUZUKI_ENROLLMENT_TOKEN")?;
            identity::issue(&settings, Some(&token), None).await?;
            eprintln!("Node identity enrolled");
        }
        Command::Run => {
            let identity = Identity::read(&settings.state_dir)?;
            let registry = Cores::builtins(&settings)?;
            let outbox = open_resilient_outbox(&settings.state_dir, &mut settings.config_warnings)?;
            let mut agent = Agent {
                outbox,
                collector: Box::new(NativeCollector::new()?),
                runtime: Supervisor::new(
                    registry,
                    settings.state_dir.clone(),
                    settings.core_management.enabled,
                ),
                deadline: None,
            };
            tokio::select! {
                result = agent.connect(&settings, identity) => result?,
                result = signals::shutdown() => result?,
            }
            if let Err(error) = agent.collect(None).await {
                tracing::warn!(%error, "final usage collection failed during shutdown");
            }
            agent.runtime.stop().await;
        }
    }
    Ok(())
}

fn open_resilient_outbox(state_dir: &std::path::Path, warnings: &mut Vec<String>) -> Result<Outbox> {
    let db_path = state_dir.join("usage.sqlite");
    match Outbox::open(&db_path) {
        Ok(outbox) => Ok(outbox),
        Err(error) => {
            tracing::warn!(%error, path = %db_path.display(), "usage outbox failed to open; backing up and recreating");
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = state_dir.join(format!("usage.sqlite.corrupt.{ts}"));
            let _ = std::fs::rename(&db_path, &backup);
            warnings.push(format!(
                "Local usage.sqlite could not be opened and was recreated (previous file backed up to {})",
                backup.display()
            ));
            Outbox::open(&db_path)
        }
    }
}

enum CoreJobEvent {
    Progress {
        request_id: Uuid,
        core: Option<Core>,
        stage: CoreActionStage,
        message: String,
    },
    Finished {
        request_id: Uuid,
        core: Core,
        result: Result<Capability>,
    },
}

struct Agent {
    runtime: Supervisor,
    collector: Box<dyn UsageCollector>,
    outbox: Outbox,
    deadline: Option<Instant>,
}

impl Agent {
    async fn connect(&mut self, settings: &Settings, mut identity: Identity) -> Result<()> {
        let mut backoff = Duration::from_secs(1);
        loop {
            let outcome = tokio::select! {
                outcome = async {
                    if identity.due() { identity = identity::issue(settings, None, Some(&identity)).await?; }
                    Wss::connect(settings, &identity).await
                } => outcome,
                _ = deadline(self.deadline) => {
                    if let Err(error) = self.collect(None).await {
                        tracing::warn!(%error, "usage collection failed on lease expiry");
                    }
                    self.runtime.stop().await;
                    self.deadline = None;
                    continue;
                },
            };
            match outcome {
                Ok(mut stream) => {
                    let connected = Instant::now();
                    if let Err(error) = self.session(&mut stream, settings, &identity).await {
                        tracing::warn!(%error, "control session interrupted");
                    }
                    if connected.elapsed() > Duration::from_secs(30) {
                        backoff = Duration::from_secs(1);
                    }
                }
                Err(error) => tracing::warn!(%error, "connecting to Board failed"),
            }
            self.wait(backoff).await?;
            backoff = (backoff * 2).min(Duration::from_secs(15));
        }
    }

    async fn wait(&mut self, delay: Duration) -> Result<()> {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = deadline(self.deadline) => {
                if let Err(error) = self.collect(None).await {
                    tracing::warn!(%error, "usage collection failed on lease expiry");
                }
                self.runtime.stop().await;
                self.deadline = None;
            }
        }
        Ok(())
    }

    async fn session(
        &mut self,
        io: &mut dyn ControlTransport,
        settings: &Settings,
        identity: &Identity,
    ) -> Result<()> {
        let _ = self.runtime.reload_cores(settings);
        io.send(NodeMessage::Hello {
            capabilities: self.runtime.capabilities().await,
            applied: self.runtime.revision.clone(),
            host: Some(self.runtime.host_info()),
            config_warnings: settings.config_warnings.clone(),
        })
        .await?;
        let welcome_by = (Instant::now() + Duration::from_secs(10)).min(
            self.deadline
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(10)),
        );
        let welcome = tokio::time::timeout_at(welcome_by, io.receive()).await??;
        let BoardMessage::Welcome {
            lease_seconds,
            online_devices,
            ..
        } = welcome
        else {
            bail!("expected Board welcome");
        };
        if self.deadline.is_none() {
            self.extend(lease_seconds);
        }

        let (job_tx, mut job_rx) = mpsc::unbounded_channel::<CoreJobEvent>();
        let mut active_installs: BTreeSet<Core> = BTreeSet::new();

        let mut tick = tokio::time::interval(Duration::from_secs(5));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                _ = deadline(self.deadline) => {
                    if let Err(error) = self.collect(None).await {
                        tracing::warn!(%error, "usage collection failed on lease expiry");
                    }
                    self.runtime.stop().await;
                    self.deadline = None;
                    bail!("configuration lease expired");
                }
                Some(event) = job_rx.recv() => match event {
                    CoreJobEvent::Progress { request_id, core, stage, message } => {
                        io.send(NodeMessage::CoreActionProgress { request_id, core, stage, message }).await?;
                    }
                    CoreJobEvent::Finished { request_id, core, result } => {
                        active_installs.remove(&core);
                        let _ = self.runtime.reload_cores(settings);
                        let capabilities = self.runtime.capabilities().await;
                        let host = self.runtime.host_info();
                        let (ok, version, error) = match result {
                            Ok(cap) => (true, Some(cap.version), None),
                            Err(err) => (false, None, Some(err.to_string())),
                        };
                        if ok {
                            self.runtime.reset_retries_for_core(core);
                            self.runtime.retry_due().await;
                        }
                        io.send(NodeMessage::CoreActionResult {
                            request_id,
                            core: Some(core),
                            ok,
                            version,
                            error,
                            capabilities,
                            host,
                        }).await?;
                        let instances = self.runtime.statuses();
                        io.send(NodeMessage::Heartbeat { instances }).await?;
                    }
                },
                message = io.receive() => match message? {
                    BoardMessage::Lease { seconds } => self.extend(seconds),
                    BoardMessage::Disconnect { reason } => {
                        tracing::info!(%reason, "Board requested session disconnect");
                        if let Err(error) = self.collect(None).await {
                            tracing::warn!(%error, "final usage collection failed before disconnect");
                        }
                        self.runtime.stop().await;
                        self.deadline = None;
                        return Ok(());
                    }
                    BoardMessage::Snapshot(snapshot) => {
                        if let Err(error) = self.collect(None).await {
                            tracing::warn!(%error, "usage collection failed before applying snapshot");
                        }
                        let revision = snapshot.revision.clone();
                        let expires = self.deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(30));
                        match tokio::time::timeout_at(expires, self.runtime.apply(snapshot)).await {
                            Ok(instances) => {
                                io.send(NodeMessage::Applied { revision, instances: instances.clone() }).await?;
                                io.send(NodeMessage::Heartbeat { instances }).await?;
                            }
                            Err(_) => {
                                self.runtime.stop().await;
                                self.deadline = None;
                                bail!("lease expired during configuration update");
                            }
                        }
                    }
                    BoardMessage::UsageAck { event_ids } => {
                        if let Err(error) = self.outbox.acknowledge(&event_ids) {
                            tracing::warn!(%error, "failed to acknowledge usage outbox rows");
                        }
                    }
                    BoardMessage::UsageRejected { reason } => tracing::error!(%reason, "Board rejected a pending usage batch"),
                    BoardMessage::Welcome { .. } => bail!("unexpected additional Board welcome"),
                    BoardMessage::CoreAction(request) => {
                        self.handle_core_action(io, settings, request, &job_tx, &mut active_installs).await?;
                    }
                    BoardMessage::RestartInstance { instance_id } => {
                        if let Err(error) = self.runtime.restart_instance(instance_id).await {
                            tracing::warn!(%instance_id, %error, "instance restart failed");
                        }
                        let instances = self.runtime.statuses();
                        io.send(NodeMessage::Heartbeat { instances }).await?;
                    }
                },
                _ = tick.tick() => {
                    // Attempt bounded backoff recovery for any failed/stopped instances
                    // without ever tearing down the Board management channel.
                    self.runtime.retry_due().await;
                    let instances = self.runtime.statuses();
                    io.send(NodeMessage::Heartbeat { instances }).await?;
                    if identity.due() { bail!("node certificate rotation is due"); }
                    match self.collect(Some(&online_devices)).await {
                        Ok(online) => {
                            match self.outbox.pending() {
                                Ok(events) if !events.is_empty() => {
                                    io.send(NodeMessage::Usage(UsageBatch { events })).await?;
                                }
                                Ok(_) => {}
                                Err(error) => tracing::warn!(%error, "failed reading pending usage outbox"),
                            }
                            io.send(NodeMessage::Devices { instances: online }).await?;
                        }
                        Err(error) => {
                            tracing::warn!(%error, "periodic usage/device sampling failed; keeping control channel open");
                        }
                    }
                }
            }
        }
    }

    async fn handle_core_action(
        &mut self,
        io: &mut dyn ControlTransport,
        settings: &Settings,
        request: CoreActionRequest,
        job_tx: &mpsc::UnboundedSender<CoreJobEvent>,
        active_installs: &mut BTreeSet<Core>,
    ) -> Result<()> {
        let request_id = request.request_id;
        match request.action {
            CoreAction::Probe => {
                io.send(NodeMessage::CoreActionProgress {
                    request_id,
                    core: request.core,
                    stage: CoreActionStage::Probing,
                    message: "Probing installed cores".into(),
                })
                .await?;
                let reload = self.runtime.reload_cores(settings);
                let capabilities = self.runtime.capabilities().await;
                let host = self.runtime.host_info();
                io.send(NodeMessage::CoreActionResult {
                    request_id,
                    core: request.core,
                    ok: reload.is_ok(),
                    version: None,
                    error: reload.err().map(|e| e.to_string()),
                    capabilities,
                    host,
                })
                .await?;
            }
            CoreAction::Remove => {
                let Some(core) = request.core else {
                    let capabilities = self.runtime.capabilities().await;
                    io.send(NodeMessage::CoreActionResult {
                        request_id,
                        core: None,
                        ok: false,
                        version: None,
                        error: Some("missing target core".into()),
                        capabilities,
                        host: self.runtime.host_info(),
                    })
                    .await?;
                    return Ok(());
                };
                io.send(NodeMessage::CoreActionProgress {
                    request_id,
                    core: Some(core),
                    stage: CoreActionStage::Removing,
                    message: format!("Removing managed {core} binary"),
                })
                .await?;
                let result = if active_installs.contains(&core) {
                    Err(anyhow::anyhow!(
                        "{core} has an active installation in progress"
                    ))
                } else if self.runtime.has_running_core(core) {
                    Err(anyhow::anyhow!(
                        "Cannot remove {core} while running instances depend on it; disable or pause them first"
                    ))
                } else if self.runtime.core_source(core) != Some(CoreSource::Managed)
                    && !installer::managed_binary_path(settings, core).exists()
                {
                    Err(anyhow::anyhow!(
                        "{core} is not a panel-managed binary and cannot be removed remotely"
                    ))
                } else {
                    installer::remove_core(settings, core)
                        .and_then(|()| self.runtime.reload_cores(settings))
                };
                let capabilities = self.runtime.capabilities().await;
                let host = self.runtime.host_info();
                io.send(NodeMessage::CoreActionResult {
                    request_id,
                    core: Some(core),
                    ok: result.is_ok(),
                    version: None,
                    error: result.err().map(|e| e.to_string()),
                    capabilities,
                    host,
                })
                .await?;
            }
            CoreAction::Install {
                version,
                download_url,
                sha256,
            } => {
                let Some(core) = request.core else {
                    let capabilities = self.runtime.capabilities().await;
                    io.send(NodeMessage::CoreActionResult {
                        request_id,
                        core: None,
                        ok: false,
                        version: None,
                        error: Some("missing target core".into()),
                        capabilities,
                        host: self.runtime.host_info(),
                    })
                    .await?;
                    return Ok(());
                };
                if !settings.core_management.enabled {
                    let capabilities = self.runtime.capabilities().await;
                    io.send(NodeMessage::CoreActionResult {
                        request_id,
                        core: Some(core),
                        ok: false,
                        version: None,
                        error: Some("Remote core management is disabled in node.toml".into()),
                        capabilities,
                        host: self.runtime.host_info(),
                    })
                    .await?;
                    return Ok(());
                }
                if !active_installs.insert(core) {
                    let capabilities = self.runtime.capabilities().await;
                    io.send(NodeMessage::CoreActionResult {
                        request_id,
                        core: Some(core),
                        ok: false,
                        version: None,
                        error: Some(format!("An installation for {core} is already running")),
                        capabilities,
                        host: self.runtime.host_info(),
                    })
                    .await?;
                    return Ok(());
                }
                let settings_cloned = settings.clone();
                let tx = job_tx.clone();
                tokio::spawn(async move {
                    let progress_tx = tx.clone();
                    let result = installer::install_core(
                        &settings_cloned,
                        core,
                        &version,
                        download_url.as_deref(),
                        sha256.as_deref(),
                        move |stage, message| {
                            let _ = progress_tx.send(CoreJobEvent::Progress {
                                request_id,
                                core: Some(core),
                                stage,
                                message,
                            });
                        },
                    )
                    .await;
                    let _ = tx.send(CoreJobEvent::Finished {
                        request_id,
                        core,
                        result,
                    });
                });
            }
        }
        Ok(())
    }

    fn extend(&mut self, seconds: u64) {
        self.deadline = Some(Instant::now() + Duration::from_secs(seconds.clamp(1, 60)));
    }

    async fn collect(&mut self, online_key: Option<&[u8; 32]>) -> Result<Vec<InstanceDevices>> {
        let samples = futures_util::future::join_all(self.runtime.instances().map(|item| async {
            let (usage, online) = tokio::join!(self.collector.sample(&item.config), async {
                match online_key {
                    Some(key) => self.collector.online(&item.config, key).await,
                    None => Ok(None),
                }
            });
            (item.config.id, item.epoch, usage, online)
        }))
        .await;
        let mut instances = Vec::new();
        let mut remaining = MAX_ONLINE_SOURCES;
        for (id, epoch, usage, online) in samples {
            match usage {
                Ok(readings) => {
                    if let Err(error) = self.outbox.sample(id, epoch, &readings) {
                        tracing::warn!(%id, %error, "failed persisting usage sample to outbox");
                    }
                }
                Err(error) => tracing::warn!(%id, %error, "core usage sample failed"),
            }
            match online {
                Ok(Some(sources))
                    if instances.len() < MAX_ONLINE_INSTANCES && sources.len() <= remaining =>
                {
                    remaining -= sources.len();
                    instances.push(InstanceDevices {
                        instance_id: id,
                        sources,
                    });
                }
                Ok(Some(_)) => tracing::warn!(%id, "online source report reached its size limit"),
                Ok(None) => {}
                Err(error) => tracing::warn!(%id, %error, "online source sample failed"),
            }
        }
        Ok(instances)
    }
}

async fn deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
