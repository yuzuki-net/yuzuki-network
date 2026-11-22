use std::path::Path;

use anyhow::Result;
use tokio::process::Child;
use yuzuki_protocol::{
    Core,
    v1::{Capability, Instance},
};

#[async_trait::async_trait]
pub trait CoreRuntime: Send + Sync {
    fn core(&self) -> Core;
    async fn capability(&self) -> Result<Capability>;
    async fn validate(&self, instance: &Instance, work: &Path) -> Result<()>;
    async fn start(&self, instance: &Instance, work: &Path) -> Result<Child>;
}
