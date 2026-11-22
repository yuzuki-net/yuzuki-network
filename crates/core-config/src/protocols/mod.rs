mod portable;
mod quic;
pub(crate) mod shadowsocks;
mod stream;
pub use portable::valid_host;
pub mod ports;

pub use portable::{PortableEndpoint, Transport};
pub use shadowsocks::ShadowsocksCipher;
use std::collections::BTreeMap;
pub use stream::{ClientFingerprint, Reality, StreamTransport, VlessFlow, XhttpMode};

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Core, cores::universal, templates};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProtocolOptions {
    Hysteria2 {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        obfs_password: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        up_mbps: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        down_mbps: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ports: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pin_sha256: Option<String>,
        #[serde(default)]
        ignore_client_bandwidth: bool,
    },
    Hysteria {
        up_mbps: u32,
        down_mbps: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        obfs_password: Option<String>,
    },
    Tuic {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        congestion_control: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        udp_relay_mode: Option<String>,
        #[serde(default)]
        zero_rtt_handshake: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        heartbeat: Option<String>,
    },
    Shadowsocks2022 {
        cipher: ShadowsocksCipher,
        server_key: String,
    },
    WireGuard {
        private_key: String,
        peer_public_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preshared_key: Option<String>,
        #[serde(default)]
        local_address: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reserved: Option<[u8; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mtu: Option<u16>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub portable: Option<PortableEndpoint>,
    #[serde(default)]
    pub native: BTreeMap<Core, NativeEndpoint>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NativeEndpoint {
    pub section: Section,
    pub config: Value,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Section {
    Outbound,
    Endpoint,
}

impl Endpoint {
    /// Returns format compatibility flags for `[xray, sing-box, mihomo, universal]`.
    pub fn compatible_formats(&self) -> [bool; 4] {
        let [xray, sing_box, mihomo] = Core::ALL.map(|core| {
            self.native.contains_key(&core)
                || self
                    .portable
                    .as_ref()
                    .is_some_and(|endpoint| endpoint.supports(core))
        });
        let universal = self.portable.is_some();
        [xray, sing_box, mihomo, universal]
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.portable.is_some() || !self.native.is_empty(),
            "endpoint is empty"
        );
        if let Some(portable) = &self.portable {
            portable.validate()?;
        }
        for core in Core::ALL {
            self.resolve(core, "validation", "00000000-0000-4000-8000-000000000000")?;
        }
        if self.portable.is_some() {
            self.resolve_uri("validation", "00000000-0000-4000-8000-000000000000")?;
        }
        Ok(())
    }

    pub fn resolve(
        &self,
        core: Core,
        tag: &str,
        access_id: &str,
    ) -> Result<Option<NativeEndpoint>> {
        if let Some(endpoint) = self.native.get(&core) {
            return endpoint.with_account(core, tag, access_id).map(Some);
        }
        self.portable
            .as_ref()
            .filter(|endpoint| endpoint.supports(core))
            .map(|endpoint| ports::EndpointCodec::encode(endpoint, core, tag, access_id))
            .transpose()
    }

    pub fn resolve_uri(&self, tag: &str, access_id: &str) -> Result<Option<String>> {
        self.portable
            .as_ref()
            .map(|endpoint| universal::encode_uri(endpoint, tag, access_id))
            .transpose()
    }
}

impl NativeEndpoint {
    fn with_account(&self, core: Core, tag: &str, access_id: &str) -> Result<Self> {
        ensure!(
            self.section == Section::Outbound || core == Core::SingBox,
            "the endpoints section is available only in sing-box"
        );
        let mut config = templates::client(&self.config, access_id)?;
        let map = config
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("endpoint is not an object"))?;
        let (kind, name) = match core {
            Core::Xray => ("protocol", "tag"),
            Core::SingBox => ("type", "tag"),
            Core::Mihomo => ("type", "name"),
        };
        ensure!(
            map.get(kind)
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty()),
            "native endpoint is missing its {kind}"
        );
        map.insert(name.into(), Value::String(tag.into()));
        Ok(Self {
            section: self.section,
            config,
        })
    }
}
