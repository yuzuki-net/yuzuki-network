use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::Core;

use super::{PortableEndpoint, Transport, valid_host};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum XhttpMode {
    #[default]
    Auto,
    PacketUp,
    StreamUp,
    StreamOne,
}

impl XhttpMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::PacketUp => "packet-up",
            Self::StreamUp => "stream-up",
            Self::StreamOne => "stream-one",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StreamTransport {
    #[serde(rename = "ws")]
    WebSocket {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_early_data: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        early_data_header_name: Option<String>,
    },
    Grpc {
        service_name: String,
        #[serde(default)]
        multi_mode: bool,
    },
    HttpUpgrade {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host: Option<String>,
    },
    Xhttp {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<XhttpMode>,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClientFingerprint {
    #[default]
    Chrome,
    Firefox,
    Safari,
    Edge,
    Ios,
    Android,
    Random,
    Randomized,
}

impl ClientFingerprint {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Firefox => "firefox",
            Self::Safari => "safari",
            Self::Edge => "edge",
            Self::Ios => "ios",
            Self::Android => "android",
            Self::Random => "random",
            Self::Randomized => "randomized",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Reality {
    pub public_key: String,
    pub short_id: String,
    #[serde(default)]
    pub fingerprint: ClientFingerprint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spider_x: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum VlessFlow {
    #[serde(rename = "xtls-rprx-vision")]
    Vision,
}

pub(super) fn validate(endpoint: &PortableEndpoint) -> Result<()> {
    if let Some(network) = &endpoint.network {
        ensure!(
            matches!(
                endpoint.protocol,
                Transport::Vless | Transport::Vmess | Transport::Trojan
            ),
            "WebSocket, gRPC, HTTP Upgrade and XHTTP require VLESS, VMess or Trojan"
        );
        match network {
            StreamTransport::WebSocket {
                path,
                host,
                max_early_data,
                early_data_header_name,
            } => {
                validate_path(path)?;
                ensure!(
                    host.as_deref().is_none_or(valid_host),
                    "invalid HTTP transport host"
                );
                if let Some(ed) = max_early_data {
                    ensure!(*ed <= 65535, "max_early_data must be <= 65535");
                }
                if let Some(hdr) = early_data_header_name {
                    ensure!(
                        !hdr.trim().is_empty() && hdr.len() <= 64 && !hdr.chars().any(char::is_control),
                        "invalid early_data_header_name"
                    );
                }
            }
            StreamTransport::HttpUpgrade { path, host }
            | StreamTransport::Xhttp { path, host, .. } => {
                if matches!(network, StreamTransport::Xhttp { .. }) {
                    ensure!(
                        endpoint.protocol == Transport::Vless,
                        "XHTTP transport is supported for VLESS"
                    );
                }
                validate_path(path)?;
                ensure!(
                    host.as_deref().is_none_or(valid_host),
                    "invalid HTTP transport host"
                );
            }
            StreamTransport::Grpc { service_name, .. } => {
                ensure!(
                    !service_name.is_empty()
                        && service_name.len() <= 200
                        && service_name
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"./_-".contains(&c))
                        && !service_name.starts_with('/'),
                    "gRPC service name must be a relative service name"
                );
            }
        }
    }
    if let Some(reality) = &endpoint.reality {
        let valid_network = endpoint.network.is_none()
            || matches!(
                endpoint.network,
                Some(StreamTransport::Grpc { .. } | StreamTransport::Xhttp { .. })
            );
        ensure!(
            endpoint.protocol == Transport::Vless && valid_network && endpoint.server_name.is_some(),
            "REALITY requires VLESS over TCP, gRPC, or XHTTP and a TLS server name"
        );
        ensure!(
            URL_SAFE_NO_PAD
                .decode(&reality.public_key)
                .is_ok_and(|key| key.len() == 32),
            "REALITY public key must be a 43-character Base64URL key"
        );
        ensure!(
            reality.short_id.len() <= 16
                && reality.short_id.len().is_multiple_of(2)
                && reality.short_id.bytes().all(|c| c.is_ascii_hexdigit()),
            "REALITY short ID must contain up to 16 hexadecimal digits in pairs"
        );
        if let Some(spx) = &reality.spider_x {
            ensure!(
                spx.len() <= 256 && !spx.chars().any(char::is_control),
                "invalid REALITY spiderX"
            );
        }
    }
    if endpoint.flow.is_some() {
        ensure!(
            endpoint.protocol == Transport::Vless
                && endpoint.network.is_none()
                && endpoint.server_name.is_some(),
            "Vision flow requires VLESS over TCP with TLS or REALITY"
        );
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<()> {
    ensure!(
        path.starts_with('/')
            && path.len() <= 1024
            && path.bytes().all(|c| c.is_ascii_graphic() && c != b'#'),
        "transport path must begin with / and contain no spaces or fragment"
    );
    Ok(())
}

pub(super) fn apply(endpoint: &PortableEndpoint, core: Core, config: &mut Value) {
    if let Some(flow) = endpoint.flow {
        match core {
            Core::Xray => config["settings"]["vnext"][0]["users"][0]["flow"] = json!(flow),
            _ => config["flow"] = json!(flow),
        }
    }
    if let Some(name) = &endpoint.server_name {
        match core {
            Core::Xray if let Some(reality) = &endpoint.reality => {
                let mut rs = json!({
                    "serverName": name,
                    "fingerprint": reality.fingerprint,
                    "password": reality.public_key,
                    "shortId": reality.short_id,
                });
                if let Some(spx) = reality.spider_x.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    rs["spiderX"] = json!(spx);
                }
                config["streamSettings"] = json!({
                    "security": "reality",
                    "realitySettings": rs,
                });
            }
            Core::Xray => {
                let mut tls = json!({ "serverName": name });
                if let Some(alpn) = &endpoint.alpn && !alpn.is_empty() {
                    tls["alpn"] = json!(alpn);
                }
                if let Some(fp) = endpoint.fingerprint {
                    tls["fingerprint"] = json!(fp);
                }
                if endpoint.allow_insecure {
                    tls["allowInsecure"] = json!(true);
                }
                config["streamSettings"] = json!({ "security": "tls", "tlsSettings": tls });
            }
            Core::SingBox => {
                let mut tls = json!({ "enabled": true, "server_name": name });
                if let Some(alpn) = &endpoint.alpn && !alpn.is_empty() {
                    tls["alpn"] = json!(alpn);
                }
                if endpoint.allow_insecure {
                    tls["insecure"] = json!(true);
                }
                if let Some(reality) = &endpoint.reality {
                    tls["reality"] = json!({
                        "enabled": true,
                        "public_key": reality.public_key,
                        "short_id": reality.short_id,
                    });
                    tls["utls"] = json!({ "enabled": true, "fingerprint": reality.fingerprint });
                } else if let Some(fp) = endpoint.fingerprint {
                    tls["utls"] = json!({ "enabled": true, "fingerprint": fp });
                }
                config["tls"] = tls;
            }
            Core::Mihomo => {
                config["tls"] = json!(true);
                let key = if matches!(endpoint.protocol, Transport::Trojan | Transport::Http) {
                    "sni"
                } else {
                    "servername"
                };
                config[key] = json!(name);
                if let Some(alpn) = &endpoint.alpn && !alpn.is_empty() {
                    config["alpn"] = json!(alpn);
                }
                if endpoint.allow_insecure {
                    config["skip-cert-verify"] = json!(true);
                }
                if let Some(reality) = &endpoint.reality {
                    config["client-fingerprint"] = json!(reality.fingerprint);
                    config["reality-opts"] = json!({
                        "public-key": reality.public_key,
                        "short-id": reality.short_id,
                    });
                } else if let Some(fp) = endpoint.fingerprint {
                    config["client-fingerprint"] = json!(fp);
                }
            }
        }
    }
    if let Some(network) = &endpoint.network {
        apply_network(network, core, config);
    }
}

fn apply_network(network: &StreamTransport, core: Core, config: &mut Value) {
    match network {
        StreamTransport::WebSocket {
            path,
            host,
            max_early_data,
            early_data_header_name,
        } => match core {
            Core::Xray => {
                config["streamSettings"]["network"] = json!("ws");
                let mut ws = json!({ "path": path });
                if let Some(host) = host {
                    ws["host"] = json!(host);
                }
                config["streamSettings"]["wsSettings"] = ws;
            }
            Core::SingBox => {
                let mut t = json!({ "type": "ws", "path": path });
                if let Some(host) = host {
                    t["headers"] = json!({ "Host": host });
                }
                if let Some(ed) = max_early_data {
                    t["max_early_data"] = json!(ed);
                }
                if let Some(hdr) = early_data_header_name {
                    t["early_data_header_name"] = json!(hdr);
                }
                config["transport"] = t;
            }
            Core::Mihomo => {
                config["network"] = json!("ws");
                let mut ws = json!({ "path": path });
                if let Some(host) = host {
                    ws["headers"] = json!({ "Host": host });
                }
                if let Some(ed) = max_early_data {
                    ws["max-early-data"] = json!(ed);
                }
                if let Some(hdr) = early_data_header_name {
                    ws["early-data-header-name"] = json!(hdr);
                }
                config["ws-opts"] = ws;
            }
        },
        StreamTransport::HttpUpgrade { path, host } => match core {
            Core::Xray => {
                config["streamSettings"]["network"] = json!("httpupgrade");
                let mut hu = json!({ "path": path });
                if let Some(host) = host {
                    hu["host"] = json!(host);
                }
                config["streamSettings"]["httpupgradeSettings"] = hu;
            }
            Core::SingBox => {
                let mut t = json!({ "type": "httpupgrade", "path": path });
                if let Some(host) = host {
                    t["host"] = json!(host);
                }
                config["transport"] = t;
            }
            Core::Mihomo => {
                config["network"] = json!("ws");
                let mut ws = json!({ "path": path, "v2ray-http-upgrade": true });
                if let Some(host) = host {
                    ws["headers"] = json!({ "Host": host });
                }
                config["ws-opts"] = ws;
            }
        },
        StreamTransport::Xhttp { path, host, mode } => {
            if core == Core::Xray {
                config["streamSettings"]["network"] = json!("xhttp");
                let mut xs = json!({
                    "path": path,
                    "mode": mode.unwrap_or_default().as_str(),
                });
                if let Some(host) = host {
                    xs["host"] = json!(host);
                }
                config["streamSettings"]["xhttpSettings"] = xs;
            }
        }
        StreamTransport::Grpc {
            service_name,
            multi_mode,
        } => match core {
            Core::Xray => {
                config["streamSettings"]["network"] = json!("grpc");
                let mut gs = json!({ "serviceName": service_name });
                if *multi_mode {
                    gs["multiMode"] = json!(true);
                }
                config["streamSettings"]["grpcSettings"] = gs;
            }
            Core::SingBox => {
                config["transport"] = json!({ "type": "grpc", "service_name": service_name });
            }
            Core::Mihomo => {
                config["network"] = json!("grpc");
                config["grpc-opts"] = json!({ "grpc-service-name": service_name });
            }
        },
    }
}
