use uuid::Uuid;
use yuzuki_protocol::v1::UsageBatch;

use crate::infra::error::Result;
pub mod policy;

#[async_trait::async_trait]
pub trait QuotaLedger: Send + Sync {
    async fn record(&self, node_id: Uuid, session: Uuid, batch: UsageBatch) -> Result<Vec<Uuid>>;
}
