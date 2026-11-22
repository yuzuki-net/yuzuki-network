use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

use tokio::sync::mpsc;
use uuid::Uuid;
use yuzuki_protocol::v1::BoardMessage;

struct ActiveSession {
    session_id: Uuid,
    tx: mpsc::UnboundedSender<BoardMessage>,
}

#[derive(Clone, Default)]
pub struct NodeBroker {
    sessions: Arc<RwLock<HashMap<Uuid, ActiveSession>>>,
}

impl NodeBroker {
    pub fn register(
        &self,
        server_id: Uuid,
        session_id: Uuid,
    ) -> mpsc::UnboundedReceiver<BoardMessage> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut guard = self.sessions.write().expect("node broker lock");
        if let Some(previous) = guard.insert(server_id, ActiveSession { session_id, tx }) {
            let _ = previous.tx.send(BoardMessage::Disconnect {
                reason: "replaced by newer agent session".into(),
            });
        }
        rx
    }

    pub fn unregister(&self, server_id: Uuid, session_id: Uuid) {
        let mut guard = self.sessions.write().expect("node broker lock");
        if guard
            .get(&server_id)
            .is_some_and(|active| active.session_id == session_id)
        {
            guard.remove(&server_id);
        }
    }

    pub fn send(&self, server_id: Uuid, message: BoardMessage) -> bool {
        let guard = self.sessions.read().expect("node broker lock");
        guard
            .get(&server_id)
            .is_some_and(|active| active.tx.send(message).is_ok())
    }

    pub fn disconnect(&self, server_id: Uuid, reason: impl Into<String>) {
        let mut guard = self.sessions.write().expect("node broker lock");
        if let Some(active) = guard.remove(&server_id) {
            let _ = active.tx.send(BoardMessage::Disconnect {
                reason: reason.into(),
            });
        }
    }

    pub fn is_connected(&self, server_id: Uuid) -> bool {
        let guard = self.sessions.read().expect("node broker lock");
        guard
            .get(&server_id)
            .is_some_and(|active| !active.tx.is_closed())
    }
}
