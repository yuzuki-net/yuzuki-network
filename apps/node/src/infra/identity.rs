use std::{
    io::Cursor,
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use rcgen::{CertificateParams, KeyPair};
use reqwest::{Client, ClientBuilder};
use rustls::{ClientConfig, RootCertStore};
use serde::{Deserialize, Serialize};
use yuzuki_protocol::v1::{ENROLL_PATH, RENEW_PATH, SignRequest, SignedIdentity};

use super::{config::Settings, filesystem};

#[derive(Deserialize, Serialize)]
pub struct Identity {
    certificate_pem: String,
    key_pem: String,
    expires_unix: i64,
}

impl Identity {
    pub fn read(directory: &Path) -> Result<Self> {
        let data = std::fs::read(directory.join("identity.json"))
            .context("read Node identity; run node enroll first")?;
        Ok(serde_json::from_slice(&data)?)
    }

    pub fn due(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.expires_unix.saturating_sub(now as i64) <= 4 * 3600
    }

    pub fn websocket_tls(&self, ca: &str) -> Result<Arc<ClientConfig>> {
        let mut roots = RootCertStore::empty();
        let (added, _) = roots.add_parsable_certificates(
            rustls_pemfile::certs(&mut Cursor::new(ca.as_bytes()))
                .collect::<std::io::Result<Vec<_>>>()?,
        );
        ensure!(added > 0, "Board CA bundle is empty");
        let certificates = rustls_pemfile::certs(&mut Cursor::new(self.certificate_pem.as_bytes()))
            .collect::<std::io::Result<Vec<_>>>()?;
        let key = rustls_pemfile::private_key(&mut Cursor::new(self.key_pem.as_bytes()))?
            .context("Node identity has no private key")?;

        Ok(Arc::new(
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_protocol_versions(&[&rustls::version::TLS13])?
                .with_root_certificates(roots)
                .with_client_auth_cert(certificates, key)?,
        ))
    }

    fn http_identity(&self) -> Result<reqwest::Identity> {
        Ok(reqwest::Identity::from_pem(
            format!("{}\n{}", self.certificate_pem, self.key_pem).as_bytes(),
        )?)
    }
}

fn builder(settings: &Settings) -> Result<ClientBuilder> {
    Ok(Client::builder()
        .tls_built_in_root_certs(false)
        .add_root_certificate(
            reqwest::Certificate::from_pem_bundle(settings.ca_certificate.as_bytes())?
                .into_iter()
                .next()
                .context("Board TLS CA missing")?,
        )
        .min_tls_version(reqwest::tls::Version::TLS_1_3)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8)))
}

pub async fn issue(
    settings: &Settings,
    token: Option<&str>,
    current: Option<&Identity>,
) -> Result<Identity> {
    let mut builder = builder(settings)?;
    let path = if let Some(current) = current {
        builder = builder.identity(current.http_identity()?);
        RENEW_PATH
    } else {
        ENROLL_PATH
    };
    let key = KeyPair::generate()?;
    let csr_pem = CertificateParams::default()
        .serialize_request(&key)?
        .pem()?;
    let client = builder.build()?;
    let mut request = client
        .post(settings.board_url.join(path)?)
        .json(&SignRequest { csr_pem });
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await?;
    ensure!(
        response.status().is_success(),
        "Board certificate endpoint returned {}",
        response.status()
    );
    let signed: SignedIdentity = response.json().await?;
    let identity = Identity {
        certificate_pem: signed.certificate_pem,
        key_pem: key.serialize_pem(),
        expires_unix: signed.expires_unix,
    };
    identity.websocket_tls(&settings.ca_certificate)?;
    filesystem::atomic_write(
        &settings.state_dir.join("identity.json"),
        &serde_json::to_vec(&identity)?,
    )?;
    Ok(identity)
}
