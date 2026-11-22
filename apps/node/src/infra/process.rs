use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use tokio::process::{Child, Command};
use yuzuki_protocol::{
    Core,
    v1::{Capability, CoreSource, Instance},
};

use crate::{infra::filesystem, services::runtime::ports::CoreRuntime};

pub struct ProcessCore {
    core: Core,
    binary: PathBuf,
    source: CoreSource,
}

impl ProcessCore {
    pub fn new(core: Core, binary: PathBuf, source: CoreSource) -> Self {
        Self {
            core,
            binary,
            source,
        }
    }

    pub fn source(&self) -> CoreSource {
        self.source
    }

    pub fn binary(&self) -> &Path {
        &self.binary
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.binary);
        command.kill_on_drop(true).stdin(Stdio::null());
        if self.core == Core::Xray
            && let Some(parent) = self.binary.parent()
            && parent.join("geoip.dat").is_file()
        {
            command.env("XRAY_LOCATION_ASSET", parent);
        }
        command
    }

    fn config(&self, instance: &Instance, work: &Path) -> Result<PathBuf> {
        filesystem::directory(work)?;
        let (name, bytes) = if self.core == Core::Mihomo {
            (
                "config.yaml",
                serde_yaml_ng::to_string(&instance.config)?.into_bytes(),
            )
        } else {
            ("config.json", serde_json::to_vec_pretty(&instance.config)?)
        };
        let config = work.join(name);
        filesystem::atomic_write(&config, &bytes)?;
        Ok(config)
    }

    fn args(&self, command: &mut Command, config: &Path, work: &Path, check: bool) {
        match self.core {
            Core::Xray => {
                command.arg("run");
                if check {
                    command.arg("-test");
                }
                command.arg("-config").arg(config);
            }
            Core::SingBox => {
                command
                    .arg(if check { "check" } else { "run" })
                    .arg("-c")
                    .arg(config);
            }
            Core::Mihomo => {
                if check {
                    command.arg("-t");
                }
                command.arg("-d").arg(work).arg("-f").arg(config);
            }
        }
    }
}

fn diagnostic_snippet(stdout: &[u8], stderr: &[u8]) -> String {
    let raw = if !stderr.is_empty() { stderr } else { stdout };
    String::from_utf8_lossy(raw)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ")
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect()
}

#[async_trait::async_trait]
impl CoreRuntime for ProcessCore {
    fn core(&self) -> Core {
        self.core
    }

    async fn capability(&self) -> Result<Capability> {
        let mut command = self.command();
        command.arg(match self.core {
            Core::Mihomo => "-v",
            _ => "version",
        });
        let output = tokio::time::timeout(Duration::from_secs(5), command.output()).await??;
        ensure!(
            output.status.success(),
            "{} version check failed",
            self.core
        );
        let text = String::from_utf8_lossy(&output.stdout);
        let version = text
            .lines()
            .next()
            .unwrap_or_default()
            .chars()
            .take(160)
            .collect();
        Ok(Capability {
            core: self.core,
            version,
            source: self.source,
            path: Some(self.binary.display().to_string()),
        })
    }

    async fn validate(&self, instance: &Instance, work: &Path) -> Result<()> {
        let config = self.config(instance, work)?;
        let mut command = self.command();
        command
            .current_dir(work)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.args(&mut command, &config, work, true);
        let output = tokio::time::timeout(Duration::from_secs(10), command.output())
            .await
            .context("core configuration validation timed out")??;
        if !output.status.success() {
            let detail = diagnostic_snippet(&output.stdout, &output.stderr);
            if detail.is_empty() {
                anyhow::bail!("{} rejected configuration for {}", self.core, instance.id);
            }
            anyhow::bail!(
                "{} rejected configuration for {}: {}",
                self.core,
                instance.id,
                detail
            );
        }
        Ok(())
    }

    async fn start(&self, instance: &Instance, work: &Path) -> Result<Child> {
        let config = self.config(instance, work)?;
        let mut command = self.command();
        command
            .current_dir(work)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        self.args(&mut command, &config, work, false);
        let mut child = command
            .spawn()
            .with_context(|| format!("start {}", self.core))?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        if child.try_wait()?.is_some() {
            let output = child.wait_with_output().await.ok();
            let detail = output
                .as_ref()
                .map(|out| diagnostic_snippet(&out.stdout, &out.stderr))
                .unwrap_or_default();
            if detail.is_empty() {
                anyhow::bail!("{} exited during startup for {}", self.core, instance.id);
            }
            anyhow::bail!(
                "{} exited during startup for {}: {}",
                self.core,
                instance.id,
                detail
            );
        }
        // Drain stderr so long-running cores never block on a full stderr pipe buffer.
        if let Some(mut stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            });
        }
        Ok(child)
    }
}
