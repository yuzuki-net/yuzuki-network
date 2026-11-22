//! Versioned messages shared by Board and Node.

pub mod codec;
pub mod v1;

use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Core {
    Xray,
    SingBox,
    Mihomo,
}

impl Core {
    pub const ALL: [Self; 3] = [Self::Xray, Self::SingBox, Self::Mihomo];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Xray => "xray",
            Self::SingBox => "sing-box",
            Self::Mihomo => "mihomo",
        }
    }
}

impl fmt::Display for Core {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.id())
    }
}

impl FromStr for Core {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|core| core.id() == value)
            .ok_or("unknown core")
    }
}
