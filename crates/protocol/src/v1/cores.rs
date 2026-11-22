use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Core;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct HostInfo {
    pub os: String,
    pub arch: String,
    #[serde(default)]
    pub core_management: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoreSource {
    Managed,
    #[default]
    Configured,
    System,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CoreAction {
    Install {
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        download_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
    },
    Remove,
    Probe,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CoreActionRequest {
    pub request_id: Uuid,
    pub core: Option<Core>,
    pub action: CoreAction,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoreActionStage {
    Queued,
    Downloading,
    Verifying,
    Extracting,
    Testing,
    Installing,
    Removing,
    Probing,
    Completed,
    Failed,
}
