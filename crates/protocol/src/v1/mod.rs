mod config;
mod cores;
mod devices;
mod usage;

pub use config::{Instance, Meter, Snapshot};
pub use cores::{CoreAction, CoreActionRequest, CoreActionStage, CoreSource, HostInfo};
pub use devices::{InstanceDevices, MAX_ONLINE_INSTANCES, MAX_ONLINE_SOURCES, OnlineSource};
pub use usage::{UsageBatch, UsageEvent};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Core;

pub const SUBPROTOCOL: &str = "yuzuki.node.v1";
pub const CONNECT_PATH: &str = "/v1/session";
pub const ENROLL_PATH: &str = "/v1/enroll";
pub const RENEW_PATH: &str = "/v1/renew";
pub const MAX_USAGE_EVENTS: usize = 128;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignRequest {
    pub csr_pem: String,
}

#[derive(Serialize, Deserialize)]
pub struct SignedIdentity {
    pub certificate_pem: String,
    pub expires_unix: i64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstanceState {
    Running,
    #[default]
    Stopped,
    Failed,
    MissingCore,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RuntimeStatus {
    pub instance_id: Uuid,
    pub running: bool,
    #[serde(default)]
    pub state: InstanceState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Capability {
    pub core: Core,
    pub version: String,
    #[serde(default)]
    pub source: CoreSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeMessage {
    Hello {
        capabilities: Vec<Capability>,
        applied: Option<String>,
        #[serde(default)]
        host: Option<HostInfo>,
        #[serde(default)]
        config_warnings: Vec<String>,
    },
    Capabilities {
        host: HostInfo,
        capabilities: Vec<Capability>,
    },
    Heartbeat {
        instances: Vec<RuntimeStatus>,
    },
    Applied {
        revision: String,
        #[serde(default)]
        instances: Vec<RuntimeStatus>,
    },
    Rejected {
        revision: String,
        reason: String,
    },
    Usage(UsageBatch),
    Devices {
        instances: Vec<InstanceDevices>,
    },
    CoreActionProgress {
        request_id: Uuid,
        core: Option<Core>,
        stage: CoreActionStage,
        message: String,
    },
    CoreActionResult {
        request_id: Uuid,
        core: Option<Core>,
        ok: bool,
        version: Option<String>,
        error: Option<String>,
        capabilities: Vec<Capability>,
        host: HostInfo,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BoardMessage {
    Welcome {
        session: Uuid,
        lease_seconds: u64,
        online_devices: [u8; 32],
    },
    Snapshot(Snapshot),
    Lease {
        seconds: u64,
    },
    UsageAck {
        event_ids: Vec<Uuid>,
    },
    UsageRejected {
        reason: String,
    },
    CoreAction(CoreActionRequest),
    RestartInstance {
        instance_id: Uuid,
    },
    Disconnect {
        reason: String,
    },
}
