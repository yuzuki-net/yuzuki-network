mod certificates;
mod control;

use std::{io::Cursor, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, ensure};
use axum::{Extension, Router};
use hyper_util::{
    rt::{TokioExecutor, TokioIo},
    server::conn::auto,
    service::TowerToHyperService,
};
use rustls::{RootCertStore, ServerConfig, server::WebPkiClientVerifier};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::{net::TcpListener, sync::Semaphore};
use tokio_rustls::TlsAcceptor;

use crate::app::State;
use certificates::Signer;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlSettings {
    pub bind: SocketAddr,
    pub certificate: PathBuf,
    pub private_key: PathBuf,
    pub node_ca_certificate: PathBuf,
    pub node_ca_key: PathBuf,
}

#[derive(Clone)]
struct Peer(Option<String>);

pub struct Gateway {
    listener: TcpListener,
    tls: TlsAcceptor,
    router: Router,
}

impl Gateway {
    pub async fn bind(settings: &ControlSettings, state: State) -> Result<Self> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let ca = std::fs::read_to_string(&settings.node_ca_certificate)
            .context("read node CA certificate")?;
        let ca_key = std::fs::read_to_string(&settings.node_ca_key).context("read node CA key")?;
        let mut roots = RootCertStore::empty();
        let (added, _) = roots.add_parsable_certificates(
            rustls_pemfile::certs(&mut Cursor::new(ca.as_bytes()))
                .collect::<std::io::Result<Vec<_>>>()?,
        );
        ensure!(added == 1, "configure one node CA certificate");
        let verifier =
            WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider.clone())
                .allow_unauthenticated()
                .build()?;
        let tls = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])?
            .with_client_cert_verifier(verifier)
            .with_single_cert(
                rustls_pemfile::certs(&mut Cursor::new(std::fs::read(&settings.certificate)?))
                    .collect::<std::io::Result<Vec<_>>>()?,
                rustls_pemfile::private_key(&mut Cursor::new(std::fs::read(
                    &settings.private_key,
                )?))?
                .context("control TLS key is missing from PEM")?,
            )?;
        let device_key = crate::services::dashboard::presence::key(&state.db)
            .await
            .map_err(|error| anyhow::anyhow!("{error:?}"))?;
        let router = control::router(state, Signer::new(&ca, &ca_key)?, device_key);
        let listener = TcpListener::bind(settings.bind).await?;
        eprintln!("Node control listening on {}", listener.local_addr()?);
        Ok(Self {
            listener,
            tls: TlsAcceptor::from(Arc::new(tls)),
            router,
        })
    }

    pub async fn run(self) -> Result<()> {
        let connections = Arc::new(Semaphore::new(1024));
        loop {
            let (socket, _) = self.listener.accept().await?;
            let Ok(permit) = connections.clone().try_acquire_owned() else {
                continue;
            };
            let tls = self.tls.clone();
            let router = self.router.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let result =
                    tokio::time::timeout(Duration::from_secs(10), tls.accept(socket)).await;
                let Ok(Ok(stream)) = result else { return };
                let digest = stream
                    .get_ref()
                    .1
                    .peer_certificates()
                    .and_then(|certs| certs.first())
                    .map(|cert| format!("{:x}", Sha256::digest(cert.as_ref())));
                let service = TowerToHyperService::new(router.layer(Extension(Peer(digest))));
                let mut server = auto::Builder::new(TokioExecutor::new());
                server
                    .http1()
                    .timer(hyper_util::rt::TokioTimer::new())
                    .header_read_timeout(Duration::from_secs(10));
                if let Err(error) = server
                    .serve_connection_with_upgrades(TokioIo::new(stream), service)
                    .await
                {
                    tracing::debug!(%error, "control connection ended");
                }
            });
        }
    }
}
