use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use yuzuki_protocol::v1::Meter;

use crate::{
    Core,
    protocols::{
        ClientFingerprint, PortableEndpoint, ProtocolOptions, Reality, StreamTransport, Transport,
        VlessFlow, valid_host,
    },
};

const ACCESS_ID: &str = "$yuzuki_access_id";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManagedReality {
    pub private_key: String,
    pub public_key: String,
    #[serde(default)]
    pub short_id: String,
    #[serde(default)]
    pub fingerprint: ClientFingerprint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handshake_server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handshake_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spider_x: Option<String>,
}

/// Unified single-source-of-truth protocol specification for managed and external proxy nodes.
/// Board compiles both server inbound templates (for `yuzuki-node`) and client
/// subscription endpoints (for xray / sing-box / mihomo / universal URI) from this struct.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManagedProtocolConfig {
    pub protocol: Transport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<StreamTransport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reality: Option<ManagedReality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<VlessFlow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpn: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<ClientFingerprint>,
    #[serde(default)]
    pub allow_insecure: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<ProtocolOptions>,
}

pub fn supported_server_cores(protocol: Transport) -> &'static [Core] {
    match protocol {
        Transport::Vless => &[Core::Xray, Core::SingBox, Core::Mihomo],
        Transport::Vmess => &[Core::Xray, Core::SingBox, Core::Mihomo],
        Transport::Trojan => &[Core::SingBox, Core::Xray, Core::Mihomo],
        Transport::Hysteria2 => &[Core::SingBox, Core::Xray, Core::Mihomo],
        Transport::Shadowsocks2022 => &[Core::SingBox, Core::Xray, Core::Mihomo],
        Transport::Shadowsocks => &[Core::SingBox, Core::Xray, Core::Mihomo],
        Transport::Hysteria => &[Core::SingBox],
        Transport::Tuic => &[Core::SingBox, Core::Mihomo],
        Transport::AnyTls => &[Core::SingBox, Core::Mihomo],
        Transport::Naive => &[Core::SingBox],
        Transport::Socks5 | Transport::Http => &[Core::SingBox, Core::Xray, Core::Mihomo],
        Transport::WireGuard => &[],
    }
}

pub fn supports_server_core(protocol: Transport, core: Core) -> bool {
    supported_server_cores(protocol).contains(&core)
}

pub fn default_server_core(protocol: Transport) -> Core {
    supported_server_cores(protocol)
        .first()
        .copied()
        .unwrap_or(Core::SingBox)
}

pub fn protocol_uses_tcp(protocol: Transport) -> bool {
    !matches!(
        protocol,
        Transport::Hysteria2 | Transport::Hysteria | Transport::Tuic | Transport::WireGuard
    )
}

pub fn protocol_uses_udp(protocol: Transport) -> bool {
    matches!(
        protocol,
        Transport::Hysteria2
            | Transport::Hysteria
            | Transport::Tuic
            | Transport::Shadowsocks
            | Transport::Shadowsocks2022
            | Transport::WireGuard
    )
}

pub fn requires_tls_cert(config: &ManagedProtocolConfig) -> bool {
    if config.reality.is_some() {
        return false;
    }
    if matches!(
        config.protocol,
        Transport::Shadowsocks | Transport::Shadowsocks2022 | Transport::WireGuard
    ) {
        return false;
    }
    if matches!(
        config.protocol,
        Transport::Trojan
            | Transport::Hysteria2
            | Transport::Hysteria
            | Transport::Tuic
            | Transport::AnyTls
            | Transport::Naive
    ) {
        return true;
    }
    config.server_name.is_some()
}

impl ManagedProtocolConfig {
    pub fn listen_host_or_default(&self) -> &str {
        self.listen_host
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("0.0.0.0")
    }

    pub fn to_portable_endpoint(&self, host: &str, port: u16) -> Result<PortableEndpoint> {
        let endpoint = PortableEndpoint {
            protocol: self.protocol,
            host: host.trim().to_string(),
            port,
            server_name: self
                .server_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            method: self.method.clone(),
            network: self.network.clone(),
            reality: self.reality.as_ref().map(|r| Reality {
                public_key: r.public_key.trim().to_string(),
                short_id: r.short_id.trim().to_string(),
                fingerprint: r.fingerprint,
                spider_x: r.spider_x.clone(),
            }),
            flow: self.flow,
            alpn: self.alpn.clone(),
            fingerprint: self.fingerprint,
            allow_insecure: self.allow_insecure,
            credential: self.credential.clone(),
            username: self.username.clone(),
            options: self.options.clone(),
        };
        endpoint.validate()?;
        Ok(endpoint)
    }

    pub fn validate_for_server(
        &self,
        core: Core,
        host: &str,
        port: u16,
        listen_port: u16,
    ) -> Result<()> {
        ensure!(listen_port != 0, "listen port must be between 1 and 65535");
        ensure!(
            supports_server_core(self.protocol, core),
            "{} server does not support managed {:?} listeners",
            core,
            self.protocol
        );
        if matches!(self.network, Some(StreamTransport::Xhttp { .. })) {
            ensure!(
                core == Core::Xray,
                "XHTTP server listeners require xray-core"
            );
        }
        self.to_portable_endpoint(host, port)?;

        let listen = self.listen_host_or_default();
        ensure!(
            listen.parse::<std::net::IpAddr>().is_ok() || valid_host(listen),
            "invalid server listen address"
        );

        if let Some(reality) = &self.reality {
            ensure!(
                matches!(core, Core::Xray | Core::SingBox),
                "REALITY managed listeners require xray or sing-box"
            );
            ensure!(
                URL_SAFE_NO_PAD
                    .decode(reality.private_key.trim())
                    .is_ok_and(|key| key.len() == 32),
                "REALITY private key must be a 43-character Base64URL X25519 key"
            );
            if let Some(hs) = reality
                .handshake_server
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                ensure!(valid_host(hs), "invalid REALITY handshake server");
            }
            if let Some(hp) = reality.handshake_port {
                ensure!(hp != 0, "invalid REALITY handshake port");
            }
        }

        if requires_tls_cert(self) {
            let cert = self.certificate.as_deref().map(str::trim).unwrap_or("");
            let key = self.key.as_deref().map(str::trim).unwrap_or("");
            ensure!(
                !cert.is_empty() && !key.is_empty(),
                "TLS certificate and private key paths are required for this protocol"
            );
            ensure!(
                !cert.chars().any(char::is_control) && !key.chars().any(char::is_control),
                "certificate and key paths must not contain control characters"
            );
        }

        if core == Core::Mihomo
            && matches!(self.network, Some(StreamTransport::HttpUpgrade { .. }))
        {
            anyhow::bail!("mihomo server listeners do not support HTTP Upgrade transport");
        }
        Ok(())
    }

    pub fn compile_server(
        &self,
        core: Core,
        listen_port: u16,
        meter: Option<&Meter>,
    ) -> Result<Value> {
        ensure!(listen_port != 0, "listen port must be between 1 and 65535");
        ensure!(
            supports_server_core(self.protocol, core),
            "{} server does not support managed {:?} listeners",
            core,
            self.protocol
        );

        let base = match core {
            Core::Xray => self.compile_xray(listen_port)?,
            Core::SingBox => self.compile_sing_box(listen_port)?,
            Core::Mihomo => self.compile_mihomo(listen_port)?,
        };

        Ok(match meter {
            Some(meter) => inject_metering(core, base, meter),
            None => base,
        })
    }

    fn compile_xray(&self, listen_port: u16) -> Result<Value> {
        let host = self.listen_host_or_default();
        let h2 = self.protocol == Transport::Hysteria2;
        let ss2022 = self.protocol == Transport::Shadowsocks2022;
        let ss_legacy = self.protocol == Transport::Shadowsocks;
        let flow = self.flow.map(|f| json!(f));

        let mut inbound = Map::new();
        inbound.insert(
            "protocol".into(),
            json!(match self.protocol {
                Transport::Hysteria2 => "hysteria",
                Transport::Shadowsocks | Transport::Shadowsocks2022 => "shadowsocks",
                Transport::Socks5 => "socks",
                Transport::Http => "http",
                Transport::Vless => "vless",
                Transport::Vmess => "vmess",
                Transport::Trojan => "trojan",
                _ => anyhow::bail!("xray server does not support {:?}", self.protocol),
            }),
        );
        inbound.insert("listen".into(), json!(host));
        inbound.insert("port".into(), json!(listen_port));

        let settings = if h2 {
            json!({
                "version": 2,
                "users": { "$yuzuki_users": { "auth": ACCESS_ID, "email": ACCESS_ID } }
            })
        } else if ss2022 {
            let Some(ProtocolOptions::Shadowsocks2022 { cipher, server_key }) = &self.options else {
                anyhow::bail!("Shadowsocks 2022 options missing");
            };
            json!({
                "method": cipher,
                "network": "tcp,udp",
                "password": server_key,
                "users": { "$yuzuki_users": { "password": { "$yuzuki_ss2022_user_key": cipher }, "email": ACCESS_ID } }
            })
        } else if ss_legacy {
            let method = self.method.as_deref().unwrap_or("chacha20-ietf-poly1305");
            json!({
                "network": "tcp,udp",
                "clients": { "$yuzuki_users": { "method": method, "password": ACCESS_ID, "email": ACCESS_ID } }
            })
        } else if matches!(self.protocol, Transport::Socks5 | Transport::Http) {
            json!({
                "auth": "password",
                "accounts": { "$yuzuki_users": { "user": ACCESS_ID, "pass": ACCESS_ID } },
                "udp": self.protocol == Transport::Socks5
            })
        } else {
            let mut client = Map::new();
            client.insert("email".into(), json!(ACCESS_ID));
            if self.protocol == Transport::Trojan {
                client.insert("password".into(), json!(ACCESS_ID));
            } else {
                client.insert("id".into(), json!(ACCESS_ID));
                if let Some(flow) = flow {
                    client.insert("flow".into(), flow);
                }
            }
            let mut settings = Map::new();
            if self.protocol == Transport::Vless {
                settings.insert("decryption".into(), json!("none"));
            }
            settings.insert(
                "clients".into(),
                json!({ "$yuzuki_users": Value::Object(client) }),
            );
            Value::Object(settings)
        };
        inbound.insert("settings".into(), settings);

        if !ss2022 && !ss_legacy {
            let mut stream = Map::new();
            if let Some(reality) = &self.reality {
                let sni = self
                    .server_name
                    .as_deref()
                    .unwrap_or("www.microsoft.com")
                    .trim();
                let hs = reality
                    .handshake_server
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(sni);
                let hp = reality.handshake_port.unwrap_or(443);
                stream.insert("network".into(), json!("tcp"));
                stream.insert("security".into(), json!("reality"));
                stream.insert(
                    "realitySettings".into(),
                    json!({
                        "dest": format!("{hs}:{hp}"),
                        "serverNames": [sni],
                        "privateKey": reality.private_key.trim(),
                        "shortIds": [reality.short_id.trim()],
                    }),
                );
            } else if requires_tls_cert(self) {
                let mut tls = Map::new();
                if let Some(alpn) = &self.alpn && !alpn.is_empty() {
                    tls.insert("alpn".into(), json!(alpn));
                } else if h2 {
                    tls.insert("alpn".into(), json!(["h3"]));
                }
                tls.insert(
                    "certificates".into(),
                    json!([{
                        "certificateFile": self.certificate.as_deref().unwrap_or("").trim(),
                        "keyFile": self.key.as_deref().unwrap_or("").trim(),
                    }]),
                );
                stream.insert("security".into(), json!("tls"));
                stream.insert("tlsSettings".into(), Value::Object(tls));
            }

            if h2 {
                stream.insert("network".into(), json!("hysteria"));
                let mut h2_settings = json!({ "version": 2 });
                if let Some(ProtocolOptions::Hysteria2 {
                    obfs_password,
                    up_mbps,
                    down_mbps,
                    ..
                }) = &self.options
                {
                    if let Some(up) = up_mbps {
                        h2_settings["up"] = json!(format!("{up} mbps"));
                    }
                    if let Some(down) = down_mbps {
                        h2_settings["down"] = json!(format!("{down} mbps"));
                    }
                    if let Some(pw) = obfs_password {
                        stream.insert(
                            "finalmask".into(),
                            json!({
                                "udp": [{ "type": "salamander", "settings": { "password": pw } }]
                            }),
                        );
                    }
                }
                stream.insert("hysteriaSettings".into(), h2_settings);
            } else if let Some(network) = &self.network {
                match network {
                    StreamTransport::WebSocket { path, host, .. } => {
                        stream.insert("network".into(), json!("ws"));
                        let mut ws = Map::new();
                        ws.insert("path".into(), json!(path));
                        if let Some(h) = host {
                            ws.insert("host".into(), json!(h));
                        }
                        stream.insert("wsSettings".into(), Value::Object(ws));
                    }
                    StreamTransport::HttpUpgrade { path, host } => {
                        stream.insert("network".into(), json!("httpupgrade"));
                        let mut hu = Map::new();
                        hu.insert("path".into(), json!(path));
                        if let Some(h) = host {
                            hu.insert("host".into(), json!(h));
                        }
                        stream.insert("httpupgradeSettings".into(), Value::Object(hu));
                    }
                    StreamTransport::Xhttp { path, host, mode } => {
                        stream.insert("network".into(), json!("xhttp"));
                        let mut xs = Map::new();
                        xs.insert("path".into(), json!(path));
                        xs.insert("mode".into(), json!(mode.unwrap_or_default().as_str()));
                        if let Some(h) = host {
                            xs.insert("host".into(), json!(h));
                        }
                        stream.insert("xhttpSettings".into(), Value::Object(xs));
                    }
                    StreamTransport::Grpc { service_name, .. } => {
                        stream.insert("network".into(), json!("grpc"));
                        stream.insert("grpcSettings".into(), json!({ "serviceName": service_name }));
                    }
                }
            }

            if !stream.is_empty() {
                inbound.insert("streamSettings".into(), Value::Object(stream));
            }
        }

        Ok(json!({
            "inbounds": [Value::Object(inbound)],
            "outbounds": [{ "protocol": "freedom" }],
        }))
    }

    fn compile_sing_box(&self, listen_port: u16) -> Result<Value> {
        let host = self.listen_host_or_default();
        let h2 = self.protocol == Transport::Hysteria2;
        let tuic = self.protocol == Transport::Tuic;
        let ss2022 = self.protocol == Transport::Shadowsocks2022;
        let ss_legacy = self.protocol == Transport::Shadowsocks;

        let mut inbound = Map::new();
        inbound.insert(
            "type".into(),
            json!(match self.protocol {
                Transport::Shadowsocks | Transport::Shadowsocks2022 => "shadowsocks",
                Transport::Socks5 => "socks",
                Transport::Http => "http",
                Transport::Vless => "vless",
                Transport::Vmess => "vmess",
                Transport::Trojan => "trojan",
                Transport::Hysteria2 => "hysteria2",
                Transport::Hysteria => "hysteria",
                Transport::Tuic => "tuic",
                Transport::AnyTls => "anytls",
                Transport::Naive => "naive",
                Transport::WireGuard => anyhow::bail!("sing-box managed server does not support WireGuard"),
            }),
        );
        inbound.insert("listen".into(), json!(host));
        inbound.insert("listen_port".into(), json!(listen_port));

        let user_template = match self.protocol {
            Transport::Vless => {
                let mut u = json!({ "name": ACCESS_ID, "uuid": ACCESS_ID });
                if let Some(flow) = self.flow {
                    u["flow"] = json!(flow);
                }
                u
            }
            Transport::Vmess => json!({ "name": ACCESS_ID, "uuid": ACCESS_ID }),
            Transport::Trojan | Transport::Hysteria2 | Transport::AnyTls | Transport::Shadowsocks => {
                json!({ "name": ACCESS_ID, "password": ACCESS_ID })
            }
            Transport::Hysteria => json!({ "name": ACCESS_ID, "auth_str": ACCESS_ID }),
            Transport::Tuic => json!({ "name": ACCESS_ID, "uuid": ACCESS_ID, "password": ACCESS_ID }),
            Transport::Naive | Transport::Socks5 | Transport::Http => {
                json!({ "username": ACCESS_ID, "password": ACCESS_ID })
            }
            Transport::Shadowsocks2022 => {
                let Some(ProtocolOptions::Shadowsocks2022 { cipher, .. }) = &self.options else {
                    anyhow::bail!("Shadowsocks 2022 options missing");
                };
                json!({ "name": ACCESS_ID, "password": { "$yuzuki_ss2022_user_key": cipher } })
            }
            Transport::WireGuard => unreachable!(),
        };
        inbound.insert("users".into(), json!({ "$yuzuki_users": user_template }));

        if ss2022 {
            let Some(ProtocolOptions::Shadowsocks2022 { cipher, server_key }) = &self.options else {
                anyhow::bail!("Shadowsocks 2022 options missing");
            };
            inbound.insert("method".into(), json!(cipher));
            inbound.insert("password".into(), json!(server_key));
        } else if ss_legacy {
            let method = self.method.as_deref().unwrap_or("chacha20-ietf-poly1305");
            inbound.insert("method".into(), json!(method));
        } else if let Some(reality) = &self.reality {
            let sni = self
                .server_name
                .as_deref()
                .unwrap_or("www.microsoft.com")
                .trim();
            let hs = reality
                .handshake_server
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(sni);
            let hp = reality.handshake_port.unwrap_or(443);
            inbound.insert(
                "tls".into(),
                json!({
                    "enabled": true,
                    "server_name": sni,
                    "reality": {
                        "enabled": true,
                        "handshake": { "server": hs, "server_port": hp },
                        "private_key": reality.private_key.trim(),
                        "short_id": [reality.short_id.trim()],
                    }
                }),
            );
        } else if requires_tls_cert(self) {
            let mut tls = Map::new();
            tls.insert("enabled".into(), json!(true));
            tls.insert(
                "certificate_path".into(),
                json!(self.certificate.as_deref().unwrap_or("").trim()),
            );
            tls.insert(
                "key_path".into(),
                json!(self.key.as_deref().unwrap_or("").trim()),
            );
            if let Some(alpn) = &self.alpn && !alpn.is_empty() {
                tls.insert("alpn".into(), json!(alpn));
            } else if h2 || tuic {
                tls.insert("alpn".into(), json!(["h3"]));
            }
            inbound.insert("tls".into(), Value::Object(tls));
        }

        if let Some(network) = &self.network {
            let transport = match network {
                StreamTransport::WebSocket {
                    path,
                    max_early_data,
                    early_data_header_name,
                    ..
                } => {
                    let mut t = json!({ "type": "ws", "path": path });
                    if let Some(ed) = max_early_data {
                        t["max_early_data"] = json!(ed);
                    }
                    if let Some(hdr) = early_data_header_name {
                        t["early_data_header_name"] = json!(hdr);
                    }
                    t
                }
                StreamTransport::HttpUpgrade { path, host } => {
                    let mut t = json!({ "type": "httpupgrade", "path": path });
                    if let Some(h) = host {
                        t["host"] = json!(h);
                    }
                    t
                }
                StreamTransport::Grpc { service_name, .. } => {
                    json!({ "type": "grpc", "service_name": service_name })
                }
                StreamTransport::Xhttp { .. } => {
                    anyhow::bail!("sing-box server does not support XHTTP transport");
                }
            };
            inbound.insert("transport".into(), transport);
        }

        if tuic {
            let (cc, z_rtt, hb) = match &self.options {
                Some(ProtocolOptions::Tuic {
                    congestion_control,
                    zero_rtt_handshake,
                    heartbeat,
                    ..
                }) => (
                    congestion_control.as_deref().unwrap_or("bbr"),
                    *zero_rtt_handshake,
                    heartbeat.as_deref(),
                ),
                _ => ("bbr", false, None),
            };
            inbound.insert("congestion_control".into(), json!(cc));
            if z_rtt {
                inbound.insert("zero_rtt_handshake".into(), json!(true));
            }
            if let Some(hb) = hb {
                inbound.insert("heartbeat".into(), json!(hb));
            }
        }

        match &self.options {
            Some(ProtocolOptions::Hysteria2 {
                obfs_password,
                up_mbps,
                down_mbps,
                ignore_client_bandwidth,
                ..
            }) => {
                if let Some(pw) = obfs_password {
                    inbound.insert(
                        "obfs".into(),
                        json!({ "type": "salamander", "password": pw }),
                    );
                }
                if let Some(up) = up_mbps {
                    inbound.insert("up_mbps".into(), json!(up));
                }
                if let Some(down) = down_mbps {
                    inbound.insert("down_mbps".into(), json!(down));
                }
                if *ignore_client_bandwidth {
                    inbound.insert("ignore_client_bandwidth".into(), json!(true));
                }
            }
            Some(ProtocolOptions::Hysteria {
                up_mbps,
                down_mbps,
                obfs_password,
            }) => {
                inbound.insert("up_mbps".into(), json!(up_mbps));
                inbound.insert("down_mbps".into(), json!(down_mbps));
                if let Some(pw) = obfs_password {
                    inbound.insert("obfs".into(), json!(pw));
                }
            }
            _ => {}
        }

        Ok(json!({
            "inbounds": [Value::Object(inbound)],
            "outbounds": [{ "type": "direct" }],
        }))
    }

    fn compile_mihomo(&self, listen_port: u16) -> Result<Value> {
        let host = self.listen_host_or_default();
        let h2 = self.protocol == Transport::Hysteria2;
        let tuic = self.protocol == Transport::Tuic;
        let ss2022 = self.protocol == Transport::Shadowsocks2022;
        let ss_legacy = self.protocol == Transport::Shadowsocks;

        let mut listener = Map::new();
        listener.insert(
            "type".into(),
            json!(match self.protocol {
                Transport::Shadowsocks | Transport::Shadowsocks2022 => "shadowsocks",
                Transport::Socks5 => "socks",
                Transport::Http => "http",
                Transport::Vless => "vless",
                Transport::Vmess => "vmess",
                Transport::Trojan => "trojan",
                Transport::Hysteria2 => "hysteria2",
                Transport::Tuic => "tuic",
                Transport::AnyTls => "anytls",
                _ => anyhow::bail!("mihomo server does not support {:?}", self.protocol),
            }),
        );
        listener.insert("name".into(), json!("managed"));
        listener.insert("listen".into(), json!(host));
        listener.insert("port".into(), json!(listen_port));

        let users = if ss2022 {
            let Some(ProtocolOptions::Shadowsocks2022 { cipher, .. }) = &self.options else {
                anyhow::bail!("Shadowsocks 2022 options missing");
            };
            json!({ "$yuzuki_user_map": { "$yuzuki_ss2022_user_key": cipher } })
        } else if h2 || tuic || self.protocol == Transport::AnyTls {
            json!({ "$yuzuki_user_map": ACCESS_ID })
        } else if self.protocol == Transport::Trojan {
            json!({ "$yuzuki_users": { "username": ACCESS_ID, "password": ACCESS_ID } })
        } else if matches!(self.protocol, Transport::Socks5 | Transport::Http) {
            json!({ "$yuzuki_users": { "username": ACCESS_ID, "password": ACCESS_ID } })
        } else if ss_legacy {
            json!({ "$yuzuki_user_map": ACCESS_ID })
        } else {
            let mut u = json!({ "username": ACCESS_ID, "uuid": ACCESS_ID });
            if let Some(flow) = self.flow {
                u["flow"] = json!(flow);
            }
            json!({ "$yuzuki_users": u })
        };
        listener.insert("users".into(), users);

        if ss2022 {
            let Some(ProtocolOptions::Shadowsocks2022 { cipher, server_key }) = &self.options else {
                anyhow::bail!("Shadowsocks 2022 options missing");
            };
            listener.insert("cipher".into(), json!(cipher));
            listener.insert("password".into(), json!(server_key));
            listener.insert("udp".into(), json!(true));
        } else if ss_legacy {
            let method = self.method.as_deref().unwrap_or("chacha20-ietf-poly1305");
            listener.insert("cipher".into(), json!(method));
            listener.insert("udp".into(), json!(true));
        } else if requires_tls_cert(self) {
            listener.insert(
                "certificate".into(),
                json!(self.certificate.as_deref().unwrap_or("").trim()),
            );
            listener.insert(
                "private-key".into(),
                json!(self.key.as_deref().unwrap_or("").trim()),
            );
            if let Some(alpn) = &self.alpn && !alpn.is_empty() {
                listener.insert("alpn".into(), json!(alpn));
            } else if h2 || tuic {
                listener.insert("alpn".into(), json!(["h3"]));
            }
        }

        if let Some(network) = &self.network {
            match network {
                StreamTransport::WebSocket { path, .. } => {
                    listener.insert("ws-path".into(), json!(path));
                }
                StreamTransport::Grpc { service_name, .. } => {
                    listener.insert("grpc-service-name".into(), json!(service_name));
                }
                StreamTransport::HttpUpgrade { .. } | StreamTransport::Xhttp { .. } => {
                    anyhow::bail!("mihomo server listeners do not support this transport");
                }
            }
        }

        if let Some(ProtocolOptions::Hysteria2 {
            obfs_password,
            up_mbps,
            down_mbps,
            ignore_client_bandwidth,
            ..
        }) = &self.options
        {
            if let Some(pw) = obfs_password {
                listener.insert("obfs".into(), json!("salamander"));
                listener.insert("obfs-password".into(), json!(pw));
            }
            if let Some(up) = up_mbps {
                listener.insert("up".into(), json!(format!("{up} Mbps")));
            }
            if let Some(down) = down_mbps {
                listener.insert("down".into(), json!(format!("{down} Mbps")));
            }
            if *ignore_client_bandwidth {
                listener.insert("ignore-client-bandwidth".into(), json!(true));
            }
        }

        if let Some(ProtocolOptions::Tuic {
            congestion_control, ..
        }) = &self.options
            && let Some(cc) = congestion_control
        {
            listener.insert("congestion-controller".into(), json!(cc));
        }

        Ok(json!({ "listeners": [Value::Object(listener)] }))
    }
}

/// Inject local loopback metering API configuration into a server config template.
pub fn inject_metering(core: Core, mut config: Value, meter: &Meter) -> Value {
    let Some(root) = config.as_object_mut() else {
        return config;
    };
    match meter {
        Meter::DedicatedTraffic { addr, secret, .. } => {
            root.insert("external-controller".into(), json!(addr.to_string()));
            root.insert("secret".into(), json!(secret));
        }
        Meter::UserStats { addr } => match core {
            Core::Xray => {
                let mut api = root
                    .get("api")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                api.entry("tag".to_string()).or_insert_with(|| json!("api"));
                api.insert("listen".into(), json!(addr.to_string()));
                let mut services: Vec<Value> = api
                    .get("services")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if !services.iter().any(|s| s.as_str() == Some("StatsService")) {
                    services.push(json!("StatsService"));
                }
                api.insert("services".into(), Value::Array(services));
                root.insert("api".into(), Value::Object(api));

                let stats = root
                    .get("stats")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                root.insert("stats".into(), Value::Object(stats));

                let mut policy = root
                    .get("policy")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let mut levels = policy
                    .get("levels")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let mut level0 = levels
                    .get("0")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                level0.insert("statsUserUplink".into(), json!(true));
                level0.insert("statsUserDownlink".into(), json!(true));
                level0.insert("statsUserOnline".into(), json!(true));
                levels.insert("0".into(), Value::Object(level0));
                policy.insert("levels".into(), Value::Object(levels));
                root.insert("policy".into(), Value::Object(policy));
            }
            Core::SingBox => {
                let mut experimental = root
                    .get("experimental")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let mut v2ray_api = experimental
                    .get("v2ray_api")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                v2ray_api.insert("listen".into(), json!(addr.to_string()));
                let mut stats = v2ray_api
                    .get("stats")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                stats.insert("enabled".into(), json!(true));
                stats.insert("users".into(), json!({ "$yuzuki_users": ACCESS_ID }));
                v2ray_api.insert("stats".into(), Value::Object(stats));
                experimental.insert("v2ray_api".into(), Value::Object(v2ray_api));
                root.insert("experimental".into(), Value::Object(experimental));
            }
            Core::Mihomo => {}
        },
    }
    config
}
