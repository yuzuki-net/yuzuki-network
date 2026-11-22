use anyhow::{Context, Result, anyhow, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::Core;

use super::{PortableEndpoint, ProtocolOptions};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ShadowsocksCipher {
    #[serde(rename = "2022-blake3-aes-128-gcm")]
    Aes128,
    #[serde(rename = "2022-blake3-aes-256-gcm")]
    Aes256,
    #[serde(rename = "2022-blake3-chacha20-poly1305")]
    ChaCha20,
}

impl ShadowsocksCipher {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Aes128 => "2022-blake3-aes-128-gcm",
            Self::Aes256 => "2022-blake3-aes-256-gcm",
            Self::ChaCha20 => "2022-blake3-chacha20-poly1305",
        }
    }

    const fn key_bytes(self) -> usize {
        match self {
            Self::Aes128 => 16,
            Self::Aes256 | Self::ChaCha20 => 32,
        }
    }
}

pub(crate) fn user_key(cipher: ShadowsocksCipher, access_id: &str) -> Result<String> {
    let id = Uuid::parse_str(access_id).context("Shadowsocks 2022 requires a UUID credential")?;
    let mut digest = Sha256::new();
    digest.update(b"yuzuki/shadowsocks2022/user-key/v1/");
    digest.update(id.as_bytes());
    Ok(STANDARD.encode(&digest.finalize()[..cipher.key_bytes()]))
}

pub(crate) fn effective_password(endpoint: &PortableEndpoint, access_id: &str) -> Result<(ShadowsocksCipher, String)> {
    let Some(ProtocolOptions::Shadowsocks2022 { cipher, server_key }) = &endpoint.options else {
        return Err(anyhow!("Shadowsocks 2022 options are missing"));
    };
    if let Some(static_cred) = endpoint.credential.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return Ok((*cipher, static_cred.to_string()));
    }
    Ok((*cipher, format!("{server_key}:{}", user_key(*cipher, access_id)?)))
}

pub(super) fn validate(endpoint: &PortableEndpoint) -> Result<()> {
    let Some(ProtocolOptions::Shadowsocks2022 { cipher, server_key }) = &endpoint.options else {
        return Err(anyhow!(
            "Shadowsocks 2022 requires a cipher and the listener's server key"
        ));
    };
    if endpoint.credential.as_deref().map(str::trim).is_some_and(|s| !s.is_empty()) {
        return Ok(());
    }
    let key = STANDARD
        .decode(server_key)
        .context("Shadowsocks 2022 server key must be standard Base64")?;
    ensure!(
        key.len() == cipher.key_bytes(),
        "Shadowsocks 2022 server key must contain {} bytes for the chosen cipher",
        cipher.key_bytes()
    );
    Ok(())
}

pub(super) fn encode(
    endpoint: &PortableEndpoint,
    core: Core,
    tag: &str,
    access_id: &str,
) -> Result<Value> {
    let (cipher, password) = effective_password(endpoint, access_id)?;
    let host = &endpoint.host;
    let port = endpoint.port;
    Ok(match core {
        Core::Xray => json!({"protocol":"shadowsocks", "tag":tag,
            "settings":{"servers":[{"address":host, "port":port, "method":cipher, "password":password}]}}),
        Core::SingBox => json!({"type":"shadowsocks", "tag":tag,
            "server":host, "server_port":port, "method":cipher, "password":password}),
        Core::Mihomo => json!({"type":"ss", "name":tag,
            "server":host, "port":port, "cipher":cipher, "password":password, "udp":true}),
    })
}
