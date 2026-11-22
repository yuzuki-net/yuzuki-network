use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct UsageEvent {
    pub event_id: Uuid,
    pub instance_id: Uuid,
    pub access_id: Uuid,
    pub uploaded: i64,
    pub downloaded: i64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct UsageBatch {
    pub events: Vec<UsageEvent>,
}
