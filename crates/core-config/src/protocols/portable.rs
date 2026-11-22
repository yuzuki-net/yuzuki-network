use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    ClientFingerprint, NativeEndpoint, ProtocolOptions, Reality, Section, StreamTransport,
    VlessFlow, ports::EndpointCodec, quic, shadowsocks, stream,
};
use crate::Core;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Vless,
    Vmess,
    Trojan,
    Shadowsocks,
    Shadowsocks2022,
    Socks5,
    Http,
    Hysteria2,
    Hysteria,
    Tuic,
    #[serde(rename = "anytls")]
    AnyTls,
    Naive,
    #[serde(rename = "wireguard")]
    WireGuard,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PortableEndpoint {
    pub protocol: Transport,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<StreamTransport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reality: Option<Reality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<VlessFlow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpn: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<ClientFingerprint>,
    #[serde(default)]
    pub allow_insecure: bool,
    /// Optional static password/UUID override for External third-party nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
    /// Optional static username override for External SOCKS5/HTTP/Naive nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<ProtocolOptions>,
}

impl PortableEndpoint {
    pub fn effective_credential<'a>(&'a self, access_id: &'a str) -> &'a str {
        self.credential
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(access_id)
    }

    pub fn effective_username<'a>(&'a self, access_id: &'a str) -> &'a str {
        self.username
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(access_id)
    }

    pub fn supports(&self, core: Core) -> bool {
        if matches!(self.network, Some(StreamTransport::Xhttp { .. })) {
            return core == Core::Xray;
        }
        match (self.protocol, core) {
            (Transport::Hysteria | Transport::Tuic | Transport::AnyTls, Core::Xray) => false,
            (Transport::Naive, Core::Xray | Core::Mihomo) => false,
            (Transport::Socks5, Core::SingBox) if self.server_name.is_some() => false,
            _ => true,
        }
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.port != 0 && valid_host(&self.host),
            "invalid endpoint address"
        );
        if let Some(name) = &self.server_name {
            ensure!(
                valid_host(name) && name.parse::<std::net::IpAddr>().is_err(),
                "invalid TLS server name"
            );
        }
        if matches!(
            self.protocol,
            Transport::Trojan
                | Transport::Hysteria
                | Transport::Hysteria2
                | Transport::Tuic
                | Transport::AnyTls
                | Transport::Naive
        ) {
            ensure!(
                self.server_name.is_some(),
                "this protocol requires a TLS server name"
            );
        }
        if let Some(alpn) = &self.alpn {
            ensure!(
                alpn.len() <= 8
                    && alpn
                        .iter()
                        .all(|a| !a.trim().is_empty() && a.len() <= 32 && !a.chars().any(char::is_control)),
                "invalid ALPN values"
            );
        }
        if let Some(cred) = &self.credential {
            ensure!(
                cred.len() <= 512 && !cred.chars().any(char::is_control),
                "invalid credential"
            );
        }
        if let Some(user) = &self.username {
            ensure!(
                user.len() <= 256 && !user.chars().any(char::is_control),
                "invalid username"
            );
        }
        ensure!(
            self.method.is_none() || self.protocol == Transport::Shadowsocks,
            "method is available only for Shadowsocks"
        );
        if matches!(
            self.protocol,
            Transport::Shadowsocks | Transport::Shadowsocks2022
        ) {
            ensure!(
                self.server_name.is_none(),
                "use a native endpoint for Shadowsocks with custom transport"
            );
            if self.protocol == Transport::Shadowsocks {
                ensure!(
                    matches!(
                        self.method.as_deref(),
                        None | Some("aes-128-gcm" | "aes-256-gcm" | "chacha20-ietf-poly1305")
                    ),
                    "use a native endpoint for this cipher"
                );
            }
        }
        if self.protocol == Transport::WireGuard {
            let Some(ProtocolOptions::WireGuard {
                private_key,
                peer_public_key,
                local_address,
                mtu,
                ..
            }) = &self.options
            else {
                anyhow::bail!("WireGuard requires private_key and peer_public_key options");
            };
            ensure!(
                !private_key.trim().is_empty() && !peer_public_key.trim().is_empty(),
                "WireGuard private_key and peer_public_key cannot be empty"
            );
            if let Some(mtu) = mtu {
                ensure!((1280..=9000).contains(mtu), "WireGuard MTU must be 1280–9000");
            }
            ensure!(
                local_address.iter().all(|a| !a.trim().is_empty() && a.len() <= 64),
                "invalid WireGuard local address"
            );
            return Ok(());
        }
        stream::validate(self)?;
        if self.protocol == Transport::Shadowsocks2022 {
            shadowsocks::validate(self)
        } else {
            quic::validate(self)
        }
    }
}

impl EndpointCodec for PortableEndpoint {
    fn encode(&self, core: Core, tag: &str, access_id: &str) -> Result<NativeEndpoint> {
        self.validate()?;
        ensure!(
            self.supports(core),
            "unsupported protocol or transport for {core}"
        );
        if self.protocol == Transport::WireGuard {
            return encode_wireguard(self, core, tag);
        }
        let config = if self.protocol == Transport::Shadowsocks2022 {
            shadowsocks::encode(self, core, tag, access_id)?
        } else if let Some(config) = quic::encode(self, core, tag, access_id) {
            config
        } else {
            encode_stream(self, core, tag, access_id)
        };
        Ok(NativeEndpoint {
            section: Section::Outbound,
            config,
        })
    }
}

fn encode_wireguard(endpoint: &PortableEndpoint, core: Core, tag: &str) -> Result<NativeEndpoint> {
    let Some(ProtocolOptions::WireGuard {
        private_key,
        peer_public_key,
        preshared_key,
        local_address,
        reserved,
        mtu,
    }) = &endpoint.options
    else {
        anyhow::bail!("WireGuard options missing");
    };
    let addresses: Vec<String> = if local_address.is_empty() {
        vec!["10.0.0.2/32".to_string()]
    } else {
        local_address.clone()
    };
    let mtu = mtu.unwrap_or(1280);
    let host = &endpoint.host;
    let port = endpoint.port;

    match core {
        Core::SingBox => {
            let mut peer = json!({
                "address": host,
                "port": port,
                "public_key": peer_public_key.trim(),
            });
            if let Some(psk) = preshared_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                peer["pre_shared_key"] = json!(psk);
            }
            if let Some(res) = reserved {
                peer["reserved"] = json!(res);
            }
            Ok(NativeEndpoint {
                section: Section::Endpoint,
                config: json!({
                    "type": "wireguard",
                    "tag": tag,
                    "address": addresses,
                    "private_key": private_key.trim(),
                    "mtu": mtu,
                    "peers": [peer],
                }),
            })
        }
        Core::Mihomo => {
            let primary_ip = addresses[0].split('/').next().unwrap_or("10.0.0.2");
            let mut config = json!({
                "name": tag,
                "type": "wireguard",
                "server": host,
                "port": port,
                "ip": primary_ip,
                "private-key": private_key.trim(),
                "public-key": peer_public_key.trim(),
                "mtu": mtu,
                "udp": true,
            });
            if let Some(v6) = addresses.iter().find(|a| a.contains(':')) {
                config["ipv6"] = json!(v6.split('/').next().unwrap_or(v6));
            }
            if let Some(psk) = preshared_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                config["pre-shared-key"] = json!(psk);
            }
            if let Some(res) = reserved {
                config["reserved"] = json!(res);
            }
            Ok(NativeEndpoint {
                section: Section::Outbound,
                config,
            })
        }
        Core::Xray => {
            let mut peer = json!({
                "publicKey": peer_public_key.trim(),
                "endpoint": format!("{host}:{port}"),
            });
            if let Some(psk) = preshared_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                peer["preSharedKey"] = json!(psk);
            }
            let mut settings = json!({
                "secretKey": private_key.trim(),
                "address": addresses,
                "mtu": mtu,
                "peers": [peer],
            });
            if let Some(res) = reserved {
                settings["reserved"] = json!(res);
            }
            Ok(NativeEndpoint {
                section: Section::Outbound,
                config: json!({
                    "tag": tag,
                    "protocol": "wireguard",
                    "settings": settings,
                }),
            })
        }
    }
}

fn encode_stream(endpoint: &PortableEndpoint, core: Core, tag: &str, access_id: &str) -> Value {
    use Transport::{AnyTls, Hysteria, Hysteria2, Naive, Shadowsocks2022, Tuic, WireGuard};
    let addr = &endpoint.host;
    let port = endpoint.port;
    let cred = endpoint.effective_credential(access_id);
    let user = endpoint.effective_username(access_id);
    let method = endpoint
        .method
        .as_deref()
        .unwrap_or("chacha20-ietf-poly1305");
    let mut config = match core {
        Core::Xray => {
            let (protocol, settings) = match endpoint.protocol {
                Transport::Vless => (
                    "vless",
                    json!({"vnext":[{"address":addr,"port":port,"users":[{"id":cred,"encryption":"none"}]}]}),
                ),
                Transport::Vmess => (
                    "vmess",
                    json!({"vnext":[{"address":addr,"port":port,"users":[{"id":cred,"security":"auto"}]}]}),
                ),
                Transport::Trojan => (
                    "trojan",
                    json!({"servers":[{"address":addr,"port":port,"password":cred}]}),
                ),
                Transport::Shadowsocks => (
                    "shadowsocks",
                    json!({"servers":[{"address":addr,"port":port,"password":cred,"method":method}]}),
                ),
                Transport::Socks5 => (
                    "socks",
                    json!({"servers":[{"address":addr,"port":port,"users":[{"user":user,"pass":cred}]}]}),
                ),
                Transport::Http => (
                    "http",
                    json!({"servers":[{"address":addr,"port":port,"users":[{"user":user,"pass":cred}]}]}),
                ),
                Hysteria2 | Hysteria | Tuic | AnyTls | Naive | Shadowsocks2022 | WireGuard => {
                    unreachable!("handled by protocol codec")
                }
            };
            json!({"tag":tag,"protocol":protocol,"settings":settings})
        }
        Core::SingBox | Core::Mihomo => {
            let mihomo = core == Core::Mihomo;
            let (kind, fields): (&str, Value) = match endpoint.protocol {
                Transport::Vless => ("vless", json!({"uuid":cred})),
                Transport::Vmess if mihomo => (
                    "vmess",
                    json!({"uuid":cred,"alterId":0,"cipher":"auto"}),
                ),
                Transport::Vmess => ("vmess", json!({"uuid":cred,"security":"auto"})),
                Transport::Trojan => ("trojan", json!({"password":cred})),
                Transport::Shadowsocks if mihomo => {
                    ("ss", json!({"password":cred,"cipher":method}))
                }
                Transport::Shadowsocks => {
                    ("shadowsocks", json!({"password":cred,"method":method}))
                }
                Transport::Socks5 if mihomo => {
                    ("socks5", json!({"username":user,"password":cred}))
                }
                Transport::Socks5 => (
                    "socks",
                    json!({"username":user,"password":cred,"version":"5"}),
                ),
                Transport::Http => ("http", json!({"username":user,"password":cred})),
                Hysteria2 | Hysteria | Tuic | AnyTls | Naive | Shadowsocks2022 | WireGuard => {
                    unreachable!("handled by protocol codec")
                }
            };
            let mut config = fields;
            config["type"] = json!(kind);
            config["server"] = json!(addr);
            if mihomo {
                config["name"] = json!(tag);
                config["port"] = json!(port);
                if !matches!(endpoint.protocol, Transport::Http) {
                    config["udp"] = json!(true);
                }
            } else {
                config["tag"] = json!(tag);
                config["server_port"] = json!(port);
            }
            config
        }
    };
    stream::apply(endpoint, core, &mut config);
    config
}

pub fn valid_host(value: &str) -> bool {
    value.parse::<std::net::IpAddr>().is_ok()
        || (!value.is_empty()
            && value.len() <= 253
            && value.split('.').all(|label| {
                (1..=63).contains(&label.len())
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            }))
}
