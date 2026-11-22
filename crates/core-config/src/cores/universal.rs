use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;

use crate::{
    cores::{InfoNodePlacement, RenderOptions},
    protocols::{
        PortableEndpoint, ProtocolOptions, StreamTransport, Transport, shadowsocks,
    },
};

fn pct(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn format_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn push_query(params: &mut Vec<String>, key: &str, value: &str) {
    if !value.is_empty() {
        params.push(format!("{}={}", pct(key), pct(value)));
    }
}

fn push_stream_params(endpoint: &PortableEndpoint, params: &mut Vec<String>) {
    match &endpoint.network {
        None => push_query(params, "type", "tcp"),
        Some(StreamTransport::WebSocket { path, host, .. }) => {
            push_query(params, "type", "ws");
            push_query(params, "path", path);
            if let Some(h) = host {
                push_query(params, "host", h);
            }
        }
        Some(StreamTransport::HttpUpgrade { path, host }) => {
            push_query(params, "type", "httpupgrade");
            push_query(params, "path", path);
            if let Some(h) = host {
                push_query(params, "host", h);
            }
        }
        Some(StreamTransport::Xhttp { path, host, mode }) => {
            push_query(params, "type", "xhttp");
            push_query(params, "path", path);
            push_query(params, "mode", mode.unwrap_or_default().as_str());
            if let Some(h) = host {
                push_query(params, "host", h);
            }
        }
        Some(StreamTransport::Grpc {
            service_name,
            multi_mode,
        }) => {
            push_query(params, "type", "grpc");
            push_query(params, "serviceName", service_name);
            if *multi_mode {
                push_query(params, "mode", "multi");
            }
        }
    }

    if let Some(reality) = &endpoint.reality {
        push_query(params, "security", "reality");
        if let Some(sni) = &endpoint.server_name {
            push_query(params, "sni", sni);
        }
        push_query(params, "pbk", &reality.public_key);
        if !reality.short_id.is_empty() {
            push_query(params, "sid", &reality.short_id);
        }
        push_query(params, "fp", reality.fingerprint.as_str());
        if let Some(spx) = &reality.spider_x {
            push_query(params, "spx", spx);
        }
    } else if let Some(sni) = &endpoint.server_name {
        push_query(params, "security", "tls");
        push_query(params, "sni", sni);
        if let Some(alpn) = &endpoint.alpn && !alpn.is_empty() {
            push_query(params, "alpn", &alpn.join(","));
        }
        if let Some(fp) = endpoint.fingerprint {
            push_query(params, "fp", fp.as_str());
        }
        if endpoint.allow_insecure {
            push_query(params, "allowInsecure", "1");
        }
    } else {
        push_query(params, "security", "none");
    }
}

/// Encode a `PortableEndpoint` into a standard proxy sharing URI (`vless://`, `hysteria2://`, etc.).
pub fn encode_uri(endpoint: &PortableEndpoint, tag: &str, access_id: &str) -> Result<String> {
    endpoint.validate()?;
    let host = format_host(&endpoint.host);
    let port = endpoint.port;
    let cred = endpoint.effective_credential(access_id);
    let user = endpoint.effective_username(access_id);
    let frag = pct(tag);

    match endpoint.protocol {
        Transport::Vless => {
            let mut params = vec!["encryption=none".to_string()];
            if let Some(flow) = endpoint.flow {
                let flow_str = serde_json::to_value(flow)?
                    .as_str()
                    .unwrap_or("xtls-rprx-vision")
                    .to_string();
                push_query(&mut params, "flow", &flow_str);
            }
            push_stream_params(endpoint, &mut params);
            Ok(format!("vless://{}@{host}:{port}?{}#{frag}", pct(cred), params.join("&")))
        }
        Transport::Vmess => {
            let (net, path, req_host) = match &endpoint.network {
                None => ("tcp", "", ""),
                Some(StreamTransport::WebSocket { path, host, .. }) => {
                    ("ws", path.as_str(), host.as_deref().unwrap_or(""))
                }
                Some(StreamTransport::HttpUpgrade { path, host }) => {
                    ("httpupgrade", path.as_str(), host.as_deref().unwrap_or(""))
                }
                Some(StreamTransport::Grpc { service_name, .. }) => {
                    ("grpc", service_name.as_str(), "")
                }
                Some(StreamTransport::Xhttp { path, host, .. }) => {
                    ("xhttp", path.as_str(), host.as_deref().unwrap_or(""))
                }
            };
            let payload = json!({
                "v": "2",
                "ps": tag,
                "add": endpoint.host,
                "port": port.to_string(),
                "id": cred,
                "aid": "0",
                "scy": "auto",
                "net": net,
                "type": "none",
                "host": req_host,
                "path": path,
                "tls": if endpoint.server_name.is_some() { "tls" } else { "" },
                "sni": endpoint.server_name.as_deref().unwrap_or(""),
                "alpn": endpoint.alpn.as_ref().map(|v| v.join(",")).unwrap_or_default(),
                "fp": endpoint.fingerprint.map(|f| f.as_str()).unwrap_or(""),
            });
            Ok(format!("vmess://{}", STANDARD.encode(payload.to_string())))
        }
        Transport::Trojan => {
            let mut params = Vec::new();
            push_stream_params(endpoint, &mut params);
            Ok(format!("trojan://{}@{host}:{port}?{}#{frag}", pct(cred), params.join("&")))
        }
        Transport::Shadowsocks => {
            let method = endpoint.method.as_deref().unwrap_or("chacha20-ietf-poly1305");
            let userinfo = STANDARD.encode(format!("{method}:{cred}"));
            Ok(format!("ss://{userinfo}@{host}:{port}#{frag}"))
        }
        Transport::Shadowsocks2022 => {
            let (cipher, password) = shadowsocks::effective_password(endpoint, access_id)?;
            let userinfo = STANDARD.encode(format!("{}:{password}", cipher.as_str()));
            Ok(format!("ss://{userinfo}@{host}:{port}#{frag}"))
        }
        Transport::Hysteria2 => {
            let mut params = Vec::new();
            if let Some(sni) = &endpoint.server_name {
                push_query(&mut params, "sni", sni);
            }
            if endpoint.allow_insecure {
                push_query(&mut params, "insecure", "1");
            }
            if let Some(ProtocolOptions::Hysteria2 {
                obfs_password,
                ports,
                pin_sha256,
                ..
            }) = &endpoint.options
            {
                if let Some(pw) = obfs_password {
                    push_query(&mut params, "obfs", "salamander");
                    push_query(&mut params, "obfs-password", pw);
                }
                if let Some(p) = ports {
                    push_query(&mut params, "mport", p);
                }
                if let Some(pin) = pin_sha256 {
                    push_query(&mut params, "pinSHA256", pin);
                }
            }
            Ok(format!(
                "hysteria2://{}@{host}:{port}/?{}#{frag}",
                pct(cred),
                params.join("&")
            ))
        }
        Transport::Hysteria => {
            let mut params = vec!["protocol=udp".to_string()];
            push_query(&mut params, "auth", cred);
            if let Some(sni) = &endpoint.server_name {
                push_query(&mut params, "peer", sni);
            }
            if endpoint.allow_insecure {
                push_query(&mut params, "insecure", "1");
            }
            if let Some(ProtocolOptions::Hysteria {
                up_mbps,
                down_mbps,
                obfs_password,
            }) = &endpoint.options
            {
                push_query(&mut params, "upmbps", &up_mbps.to_string());
                push_query(&mut params, "downmbps", &down_mbps.to_string());
                if let Some(pw) = obfs_password {
                    push_query(&mut params, "obfsParam", pw);
                }
            }
            Ok(format!("hysteria://{host}:{port}?{}#{frag}", params.join("&")))
        }
        Transport::Tuic => {
            let mut params = Vec::new();
            if let Some(sni) = &endpoint.server_name {
                push_query(&mut params, "sni", sni);
            }
            let alpn = endpoint
                .alpn
                .as_ref()
                .filter(|v| !v.is_empty())
                .map(|v| v.join(","))
                .unwrap_or_else(|| "h3".to_string());
            push_query(&mut params, "alpn", &alpn);
            let (cc, udp_mode) = match &endpoint.options {
                Some(ProtocolOptions::Tuic {
                    congestion_control,
                    udp_relay_mode,
                    ..
                }) => (
                    congestion_control.as_deref().unwrap_or("bbr"),
                    udp_relay_mode.as_deref().unwrap_or("native"),
                ),
                _ => ("bbr", "native"),
            };
            push_query(&mut params, "congestion_control", cc);
            push_query(&mut params, "udp_relay_mode", udp_mode);
            if endpoint.allow_insecure {
                push_query(&mut params, "allow_insecure", "1");
            }
            Ok(format!(
                "tuic://{}:{}@{host}:{port}?{}#{frag}",
                pct(cred),
                pct(cred),
                params.join("&")
            ))
        }
        Transport::AnyTls => {
            let mut params = Vec::new();
            if let Some(sni) = &endpoint.server_name {
                push_query(&mut params, "sni", sni);
            }
            if let Some(fp) = endpoint.fingerprint {
                push_query(&mut params, "fp", fp.as_str());
            }
            if endpoint.allow_insecure {
                push_query(&mut params, "insecure", "1");
            }
            Ok(format!(
                "anytls://{}@{host}:{port}/?{}#{frag}",
                pct(cred),
                params.join("&")
            ))
        }
        Transport::Naive => {
            let mut params = Vec::new();
            if let Some(sni) = &endpoint.server_name {
                push_query(&mut params, "sni", sni);
            }
            Ok(format!(
                "naive+https://{}:{}@{host}:{port}?{}#{frag}",
                pct(user),
                pct(cred),
                params.join("&")
            ))
        }
        Transport::WireGuard => {
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
            let mut params = Vec::new();
            push_query(&mut params, "publickey", peer_public_key.trim());
            let addr = if local_address.is_empty() {
                "10.0.0.2/32".to_string()
            } else {
                local_address.join(",")
            };
            push_query(&mut params, "address", &addr);
            if let Some(mtu) = mtu {
                push_query(&mut params, "mtu", &mtu.to_string());
            }
            if let Some(psk) = preshared_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                push_query(&mut params, "presharedkey", psk);
            }
            if let Some(res) = reserved {
                push_query(&mut params, "reserved", &format!("{},{},{}", res[0], res[1], res[2]));
            }
            Ok(format!(
                "wireguard://{}@{host}:{port}/?{}#{frag}",
                pct(private_key.trim()),
                params.join("&")
            ))
        }
        Transport::Socks5 => {
            let auth = STANDARD.encode(format!("{user}:{cred}"));
            Ok(format!("socks://{auth}@{host}:{port}#{frag}"))
        }
        Transport::Http => {
            let scheme = if endpoint.server_name.is_some() { "https" } else { "http" };
            Ok(format!("{scheme}://{}:{}@{host}:{port}#{frag}", pct(user), pct(cred)))
        }
    }
}

/// Render a standard Base64-encoded URI subscription document with optional info placeholder nodes.
pub fn render_subscription(uris: &[String], options: &RenderOptions) -> String {
    let info_uris: Vec<String> = options
        .unique_info_labels(std::iter::empty())
        .into_iter()
        .map(|label| format!("socks://127.0.0.1:1#{}", pct(&label)))
        .collect();

    let mut lines = Vec::with_capacity(uris.len() + info_uris.len());
    if options.placement == InfoNodePlacement::AppendToGroup {
        lines.extend(uris.iter().cloned());
        lines.extend(info_uris);
    } else {
        lines.extend(info_uris);
        lines.extend(uris.iter().cloned());
    }
    STANDARD.encode(lines.join("\n"))
}
