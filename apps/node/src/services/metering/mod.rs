pub mod ports;

use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub struct Reading {
    pub access_id: Uuid,
    pub uploaded: i64,
    pub downloaded: i64,
}
