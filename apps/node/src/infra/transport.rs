use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use yuzuki_protocol::{
    codec::{self, MAX_FRAME_SIZE},
    v1::{BoardMessage, CONNECT_PATH, NodeMessage, SUBPROTOCOL},
};

use super::{config::Settings, identity::Identity};
use crate::services::control::ports::ControlTransport;

pub struct Wss(WebSocketStream<MaybeTlsStream<TcpStream>>);

impl Wss {
    pub async fn connect(settings: &Settings, identity: &Identity) -> Result<Self> {
        let mut url = settings.board_url.join(CONNECT_PATH)?;
        url.set_scheme("wss")
            .map_err(|_| anyhow::anyhow!("invalid WSS origin"))?;
        let mut request = url.as_str().into_client_request()?;
        request.headers_mut().insert(
            http::header::SEC_WEBSOCKET_PROTOCOL,
            http::HeaderValue::from_static(SUBPROTOCOL),
        );
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME_SIZE))
            .max_frame_size(Some(MAX_FRAME_SIZE));
        let tls = identity.websocket_tls(&settings.ca_certificate)?;
        let (stream, response) = tokio::time::timeout(
            Duration::from_secs(8),
            connect_async_tls_with_config(
                request,
                Some(config),
                true,
                Some(Connector::Rustls(tls)),
            ),
        )
        .await
        .context("connect timeout")??;
        ensure!(
            response
                .headers()
                .get(http::header::SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok())
                == Some(SUBPROTOCOL),
            "Board did not negotiate the control protocol"
        );
        Ok(Self(stream))
    }
}

#[async_trait::async_trait]
impl ControlTransport for Wss {
    async fn send(&mut self, message: NodeMessage) -> Result<()> {
        let bytes = codec::encode(&message)?;
        tokio::time::timeout(
            Duration::from_secs(5),
            self.0.send(Message::Binary(bytes.into())),
        )
        .await
        .context("control send timeout")??;
        Ok(())
    }

    async fn receive(&mut self) -> Result<BoardMessage> {
        loop {
            match self.0.next().await.context("control connection closed")?? {
                Message::Binary(bytes) => return Ok(codec::decode(&bytes)?),
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
                Message::Close(_) => bail!("Board closed the connection"),
                Message::Text(_) => bail!("unexpected text control frame"),
            }
        }
    }
}
