use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Result, ensure};
use yuzuki_protocol::{
    Core,
    v1::{Capability, CoreSource},
};

use crate::{
    infra::{config::Settings, installer, process::ProcessCore},
    services::runtime::ports::CoreRuntime,
};

struct RegisteredCore {
    runtime: Arc<dyn CoreRuntime>,
    source: CoreSource,
}

pub struct Cores(BTreeMap<Core, RegisteredCore>);

impl Cores {
    pub fn builtins(settings: &Settings) -> Result<Self> {
        let mut registry = Self(BTreeMap::new());
        registry.reload(settings)?;
        Ok(registry)
    }

    pub fn reload(&mut self, settings: &Settings) -> Result<()> {
        self.0.clear();
        for core in Core::ALL {
            match resolve_core_binary(settings, core) {
                Ok(Some((path, source))) => {
                    if let Err(error) =
                        self.register_with_source(ProcessCore::new(core, path, source), source)
                    {
                        tracing::warn!(%core, %error, "unable to register core runtime");
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(%core, %error, "unable to resolve core binary; continuing without it");
                }
            }
        }
        Ok(())
    }

    fn register_with_source(
        &mut self,
        runtime: impl CoreRuntime + 'static,
        source: CoreSource,
    ) -> Result<()> {
        let core = runtime.core();
        ensure!(
            !self.0.contains_key(&core),
            "core runtime {core} is already registered"
        );
        self.0.insert(
            core,
            RegisteredCore {
                runtime: Arc::new(runtime),
                source,
            },
        );
        Ok(())
    }

    pub fn source(&self, core: Core) -> Option<CoreSource> {
        self.0.get(&core).map(|entry| entry.source)
    }

    pub fn get(&self, core: Core) -> Result<Arc<dyn CoreRuntime>> {
        self.0
            .get(&core)
            .map(|entry| entry.runtime.clone())
            .ok_or_else(|| anyhow::anyhow!("{core} binary is not installed or configured"))
    }

    pub async fn capabilities(&self) -> Vec<Capability> {
        let results = futures_util::future::join_all(
            self.0.values().map(|entry| entry.runtime.capability()),
        )
        .await;
        results
            .into_iter()
            .filter_map(|result| match result {
                Ok(capability) => Some(capability),
                Err(error) => {
                    tracing::warn!(%error, "core version probe failed");
                    None
                }
            })
            .collect()
    }
}

fn resolve_core_binary(settings: &Settings, core: Core) -> Result<Option<(PathBuf, CoreSource)>> {
    // 1. Panel-managed binary in <state_dir>/cores/<core>/<bin> takes precedence when present.
    let managed = installer::managed_binary_path(settings, core);
    if managed.is_file() {
        return Ok(Some((managed, CoreSource::Managed)));
    }

    // 2. Explicitly configured path in node.toml [binaries].
    if let Some(path) = settings.binaries.get(&core) {
        let resolved = if path.components().count() > 1 {
            env::current_dir()?.join(path)
        } else {
            path.clone()
        };
        if resolved.components().count() <= 1 || is_executable_file(&resolved) {
            return Ok(Some((resolved, CoreSource::Configured)));
        }
        tracing::warn!(
            %core,
            path = %resolved.display(),
            "configured binary in node.toml is missing or not executable; skipping"
        );
    }

    // 3. Optional auto-discovery of pre-installed binaries in PATH.
    if settings.core_management.detect_system_binaries
        && let Some(found) = find_in_path(installer::binary_filename(core))
    {
        return Ok(Some((found, CoreSource::System)));
    }

    Ok(None)
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
