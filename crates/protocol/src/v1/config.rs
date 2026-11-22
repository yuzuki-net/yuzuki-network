use std::net::SocketAddr;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::Core;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Snapshot {
    pub revision: String,
    pub instances: Vec<Instance>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Instance {
    pub id: Uuid,
    pub core: Core,
    pub config: Value,
    pub meter: Option<Meter>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Meter {
    UserStats {
        #[serde(with = "as_string")]
        addr: SocketAddr,
    },
    DedicatedTraffic {
        #[serde(with = "as_string")]
        addr: SocketAddr,
        #[serde(with = "as_string")]
        access_id: Uuid,
        secret: String,
    },
}

mod as_string {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    use std::{fmt::Display, str::FromStr};

    pub fn serialize<T: Display, S: Serializer>(
        value: &T,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<T, D::Error>
    where
        T: FromStr,
        T::Err: Display,
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(D::Error::custom)
    }
}

impl std::fmt::Debug for Meter {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::UserStats { .. } => "UserStats",
            Self::DedicatedTraffic { .. } => "DedicatedTraffic",
        })
    }
}
