use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_ONLINE_INSTANCES: usize = 128;
pub const MAX_ONLINE_SOURCES: usize = 4096;

/// An empty list records a successful measurement with no attributable sources.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct InstanceDevices {
    pub instance_id: Uuid,
    pub sources: Vec<OnlineSource>,
}

/// An account and its keyed, pseudonymous source address fingerprint.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct OnlineSource {
    pub access_id: Uuid,
    pub source: [u8; 32],
}
