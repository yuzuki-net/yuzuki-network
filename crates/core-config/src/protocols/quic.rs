use anyhow::{Result, ensure};
use serde_json::{Value, json};

use crate::Core;

use super::{PortableEndpoint, ProtocolOptions, Transport};

pub(super) fn validate(endpoint: &PortableEndpoint) -> Result<()> {
    match (&endpoint.options, endpoint.protocol) {
        (None, _) => Ok(()),
        (
            Some(ProtocolOptions::Hysteria2 {
                obfs_password,
                up_mbps,
                down_mbps,
                ports,
                pin_sha256,
                ..
            }),
            Transport::Hysteria2,
        ) => {
            if let Some(password) = obfs_password {
                validate_password(password)?;
            }
            if let Some(up) = up_mbps {
                ensure!(
                    (1..=100_000).contains(up),
                    "Hysteria2 upload rate must be between 1 and 100000 Mbps"
                );
            }
            if let Some(down) = down_mbps {
                ensure!(
                    (1..=100_000).contains(down),
                    "Hysteria2 download rate must be between 1 and 100000 Mbps"
                );
            }
            if let Some(ports) = ports {
                ensure!(
                    !ports.trim().is_empty()
                        && ports.len() <= 128
                        && ports
                            .bytes()
                            .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b',' | b'/')),
                    "invalid Hysteria2 port hopping range"
                );
            }
            if let Some(pin) = pin_sha256 {
                ensure!(
                    !pin.trim().is_empty() && pin.len() <= 128 && !pin.chars().any(char::is_control),
                    "invalid pinSHA256"
                );
            }
            Ok(())
        }
        (
            Some(ProtocolOptions::Hysteria {
                up_mbps,
                down_mbps,
                obfs_password,
            }),
            Transport::Hysteria,
        ) => {
            ensure!(
                (1..=100_000).contains(up_mbps) && (1..=100_000).contains(down_mbps),
                "Hysteria upload and download rates must be between 1 and 100000 Mbps"
            );
            if let Some(password) = obfs_password {
                validate_password(password)?;
            }
            Ok(())
        }
        (
            Some(ProtocolOptions::Tuic {
                congestion_control,
                udp_relay_mode,
                heartbeat,
                ..
            }),
            Transport::Tuic,
        ) => {
            if let Some(cc) = congestion_control {
                ensure!(
                    matches!(cc.as_str(), "bbr" | "cubic" | "new_reno"),
                    "TUIC congestion_control must be bbr, cubic, or new_reno"
                );
            }
            if let Some(mode) = udp_relay_mode {
                ensure!(
                    matches!(mode.as_str(), "native" | "quic"),
                    "TUIC udp_relay_mode must be native or quic"
                );
            }
            if let Some(hb) = heartbeat {
                ensure!(
                    !hb.trim().is_empty() && hb.len() <= 16 && !hb.chars().any(char::is_control),
                    "invalid TUIC heartbeat"
                );
            }
            Ok(())
        }
        _ => anyhow::bail!("protocol options do not match the selected protocol"),
    }
}

fn validate_password(password: &str) -> Result<()> {
    ensure!(
        !password.trim().is_empty()
            && password.len() <= 256
            && !password.chars().any(char::is_control),
        "obfuscation password must contain 1–256 bytes and no control characters"
    );
    Ok(())
}

pub(super) fn encode(
    endpoint: &PortableEndpoint,
    core: Core,
    tag: &str,
    access_id: &str,
) -> Option<Value> {
    let name = endpoint.server_name.as_deref();
    let host = &endpoint.host;
    let port = endpoint.port;
    let cred = endpoint.effective_credential(access_id);
    let user = endpoint.effective_username(access_id);

    if endpoint.protocol == Transport::Hysteria2 && core == Core::Xray {
        let mut tls = json!({
            "serverName": name,
            "alpn": endpoint.alpn.clone().unwrap_or_else(|| vec!["h3".to_string()]),
        });
        if endpoint.allow_insecure {
            tls["allowInsecure"] = json!(true);
        }
        let mut h2_settings = json!({ "version": 2, "auth": cred });
        if let Some(ProtocolOptions::Hysteria2 {
            up_mbps, down_mbps, ..
        }) = &endpoint.options
        {
            if let Some(up) = up_mbps {
                h2_settings["up"] = json!(format!("{up} mbps"));
            }
            if let Some(down) = down_mbps {
                h2_settings["down"] = json!(format!("{down} mbps"));
            }
        }
        let mut result = json!({
            "protocol": "hysteria",
            "tag": tag,
            "settings": { "version": 2, "address": host, "port": port },
            "streamSettings": {
                "network": "hysteria",
                "security": "tls",
                "tlsSettings": tls,
                "hysteriaSettings": h2_settings,
            }
        });
        if let Some(ProtocolOptions::Hysteria2 {
            obfs_password: Some(pw),
            ..
        }) = &endpoint.options
        {
            result["streamSettings"]["finalmask"] = json!({
                "udp": [{ "type": "salamander", "settings": { "password": pw } }]
            });
        }
        return Some(result);
    }

    let (protocol, mut config) = match endpoint.protocol {
        Transport::Hysteria2 => ("hysteria2", json!({ "password": cred })),
        Transport::Hysteria => ("hysteria", json!({})),
        Transport::Tuic => ("tuic", json!({ "uuid": cred, "password": cred })),
        Transport::AnyTls => ("anytls", json!({ "password": cred })),
        Transport::Naive => ("naive", json!({ "username": user, "password": cred })),
        _ => return None,
    };
    config["type"] = json!(protocol);
    config["server"] = json!(host);

    if core == Core::Mihomo {
        config["name"] = json!(tag);
        config["port"] = json!(port);
        config["sni"] = json!(name);
        if endpoint.allow_insecure {
            config["skip-cert-verify"] = json!(true);
        }
        if let Some(alpn) = &endpoint.alpn && !alpn.is_empty() {
            config["alpn"] = json!(alpn);
        }
        if let Some(fp) = endpoint.fingerprint {
            config["client-fingerprint"] = json!(fp);
        }
        if endpoint.protocol == Transport::Tuic {
            let (cc, udp_mode, z_rtt) = match &endpoint.options {
                Some(ProtocolOptions::Tuic {
                    congestion_control,
                    udp_relay_mode,
                    zero_rtt_handshake,
                    ..
                }) => (
                    congestion_control.as_deref().unwrap_or("bbr"),
                    udp_relay_mode.as_deref(),
                    *zero_rtt_handshake,
                ),
                _ => ("bbr", None, false),
            };
            config["congestion-controller"] = json!(cc);
            if let Some(m) = udp_mode {
                config["udp-relay-mode"] = json!(m);
            }
            if z_rtt {
                config["reduce-rtt"] = json!(true);
            }
            if config.get("alpn").is_none() {
                config["alpn"] = json!(["h3"]);
            }
        }
    } else {
        config["tag"] = json!(tag);
        config["server_port"] = json!(port);
        let mut tls = json!({ "enabled": true, "server_name": name });
        if endpoint.allow_insecure {
            tls["insecure"] = json!(true);
        }
        if let Some(alpn) = &endpoint.alpn && !alpn.is_empty() {
            tls["alpn"] = json!(alpn);
        } else if matches!(endpoint.protocol, Transport::Hysteria2 | Transport::Tuic) {
            tls["alpn"] = json!(["h3"]);
        }
        if let Some(fp) = endpoint.fingerprint {
            tls["utls"] = json!({ "enabled": true, "fingerprint": fp });
        }
        config["tls"] = tls;
        if endpoint.protocol == Transport::Tuic {
            let (cc, udp_mode, z_rtt, hb) = match &endpoint.options {
                Some(ProtocolOptions::Tuic {
                    congestion_control,
                    udp_relay_mode,
                    zero_rtt_handshake,
                    heartbeat,
                }) => (
                    congestion_control.as_deref().unwrap_or("bbr"),
                    udp_relay_mode.as_deref(),
                    *zero_rtt_handshake,
                    heartbeat.as_deref(),
                ),
                _ => ("bbr", None, false, None),
            };
            config["congestion_control"] = json!(cc);
            if let Some(m) = udp_mode {
                config["udp_relay_mode"] = json!(m);
            }
            if z_rtt {
                config["zero_rtt_handshake"] = json!(true);
            }
            if let Some(hb) = hb {
                config["heartbeat"] = json!(hb);
            }
        }
    }

    if endpoint.protocol == Transport::Hysteria {
        let (up, down, obfs) = match &endpoint.options {
            Some(ProtocolOptions::Hysteria {
                up_mbps,
                down_mbps,
                obfs_password,
            }) => (*up_mbps, *down_mbps, obfs_password.as_deref()),
            _ => (100, 100, None),
        };
        if core == Core::Mihomo {
            config["auth-str"] = json!(cred);
            config["protocol"] = json!("udp");
            config["up"] = json!(format!("{up} Mbps"));
            config["down"] = json!(format!("{down} Mbps"));
        } else {
            config["auth_str"] = json!(cred);
            config["up_mbps"] = json!(up);
            config["down_mbps"] = json!(down);
        }
        if let Some(obfs) = obfs {
            config["obfs"] = json!(obfs);
        }
    }

    if let Some(ProtocolOptions::Hysteria2 {
        obfs_password,
        up_mbps,
        down_mbps,
        ports,
        pin_sha256,
        ..
    }) = &endpoint.options
    {
        if core == Core::Mihomo {
            if let Some(pw) = obfs_password {
                config["obfs"] = json!("salamander");
                config["obfs-password"] = json!(pw);
            }
            if let Some(up) = up_mbps {
                config["up"] = json!(format!("{up} Mbps"));
            }
            if let Some(down) = down_mbps {
                config["down"] = json!(format!("{down} Mbps"));
            }
            if let Some(p) = ports {
                config["ports"] = json!(p);
            }
            if let Some(pin) = pin_sha256 {
                config["fingerprint"] = json!(pin);
            }
        } else {
            if let Some(pw) = obfs_password {
                config["obfs"] = json!({ "type": "salamander", "password": pw });
            }
            if let Some(up) = up_mbps {
                config["up_mbps"] = json!(up);
            }
            if let Some(down) = down_mbps {
                config["down_mbps"] = json!(down);
            }
            if let Some(p) = ports {
                let singbox_ports: Vec<String> = p
                    .split(',')
                    .map(|part| part.trim().replace('-', ":"))
                    .filter(|s| !s.is_empty())
                    .collect();
                if !singbox_ports.is_empty() {
                    config["server_ports"] = json!(singbox_ports);
                }
            }
        }
    }
    Some(config)
}
