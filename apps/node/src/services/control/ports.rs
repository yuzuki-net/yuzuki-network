use anyhow::Result;
use yuzuki_protocol::v1::{BoardMessage, NodeMessage};

#[async_trait::async_trait]
pub trait ControlTransport: Send {
    async fn send(&mut self, message: NodeMessage) -> Result<()>;
    async fn receive(&mut self) -> Result<BoardMessage>;
}
