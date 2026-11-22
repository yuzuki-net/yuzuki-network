use anyhow::Result;
use yuzuki_protocol::v1::{Instance, OnlineSource};

use super::Reading;

#[async_trait::async_trait]
pub trait UsageCollector: Send + Sync {
    async fn sample(&self, instance: &Instance) -> Result<Vec<Reading>>;

    async fn online(
        &self,
        _instance: &Instance,
        _key: &[u8; 32],
    ) -> Result<Option<Vec<OnlineSource>>> {
        Ok(None)
    }
}
