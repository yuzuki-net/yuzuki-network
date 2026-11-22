use std::net::IpAddr;

use axum::http::{HeaderMap, header::USER_AGENT};
use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection, TransactionTrait};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    infra::error::{Error, Result, problem},
    services::{access::sql, auth::Session},
};

use super::links;

const ACTIVE_BINDING: &str = "30 days";
pub const BINDING_DAYS: u8 = 30;

pub struct Device {
    name: String,
    identity: String,
}

impl Device {
    pub fn from_request(headers: &HeaderMap, address: Option<IpAddr>) -> Self {
        let header = |key| headers.get(key).and_then(|value| value.to_str().ok());
        let client_id = |key| {
            header(key).filter(|id| {
                (1..=128).contains(&id.len())
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
            })
        };
        let agent = headers
            .get(USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let ip = address.map(|value| value.to_string()).unwrap_or_default();
        let identity = client_id("x-device-id")
            .or_else(|| client_id("x-hwid"))
            .map(|id| format!("client/{id}"))
            .unwrap_or_else(|| {
                format!(
                    "request/{ip}/{}",
                    agent.chars().take(512).collect::<String>()
                )
            });
        let name = header("x-device-name")
            .unwrap_or(agent)
            .trim()
            .chars()
            .filter(|ch| !ch.is_control())
            .take(120)
            .collect();
        Self { name, identity }
    }

    fn fingerprint(&self, account: Uuid) -> String {
        let mut hash = Sha256::new();
        hash.update(account.as_bytes());
        hash.update(self.identity.as_bytes());
        format!("{:x}", hash.finalize())
    }
}

#[derive(Serialize)]
pub struct DeviceView {
    pub id: Uuid,
    pub client_name: String,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

pub async fn bind(
    db: &impl ConnectionTrait,
    account: Uuid,
    device: &Device,
    maximum: Option<i32>,
) -> Result<()> {
    let hash = device.fingerprint(account);
    if let Some(maximum) = maximum {
        let previous = db
            .query_one(sql(
                "SELECT id FROM subscription_devices
             WHERE account_id = $1 AND device_hash = $2
                AND last_seen_at >= statement_timestamp() - $3::interval",
                [account.into(), hash.clone().into(), ACTIVE_BINDING.into()],
            ))
            .await?;
        if maximum == 0 || (previous.is_none() && count(db, account).await? >= i64::from(maximum)) {
            return Err(Error::Conflict(problem::DEVICE_LIMIT));
        }
    }
    db.execute(sql(
        "INSERT INTO subscription_devices (id, account_id, device_hash, client_name, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, statement_timestamp(), statement_timestamp())
         ON CONFLICT (account_id, device_hash) DO UPDATE SET
            last_seen_at = statement_timestamp(), client_name = EXCLUDED.client_name",
        [
            Uuid::new_v4().into(),
            account.into(),
            hash.into(),
            device.name.clone().into(),
        ],
    ))
    .await?;
    Ok(())
}

pub async fn count(db: &impl ConnectionTrait, account: Uuid) -> Result<i64> {
    let result = db
        .query_one(sql(
            "SELECT count(*) AS count FROM subscription_devices
         WHERE account_id = $1 AND last_seen_at >= statement_timestamp() - $2::interval",
            [account.into(), ACTIVE_BINDING.into()],
        ))
        .await?
        .ok_or(Error::NotFound)?;
    Ok(result.try_get("", "count")?)
}

pub async fn list(db: &impl ConnectionTrait, account: Uuid) -> Result<Vec<DeviceView>> {
    db.query_all(sql(
        "SELECT id, client_name, first_seen_at, last_seen_at FROM subscription_devices
         WHERE account_id = $1 AND last_seen_at >= statement_timestamp() - $2::interval
         ORDER BY last_seen_at DESC, id",
        [account.into(), ACTIVE_BINDING.into()],
    ))
    .await?
    .into_iter()
    .map(|row| {
        Ok(DeviceView {
            id: row.try_get("", "id")?,
            client_name: row.try_get("", "client_name")?,
            first_seen_at: row.try_get("", "first_seen_at")?,
            last_seen_at: row.try_get("", "last_seen_at")?,
        })
    })
    .collect()
}

pub async fn remove(db: &DatabaseConnection, session: &Session, id: Uuid) -> Result<()> {
    let tx = db.begin().await?;
    let (account, _) = links::authorize_management(&tx, session).await?;
    let removed = tx
        .execute(sql(
            "DELETE FROM subscription_devices WHERE account_id = $1 AND id = $2",
            [account.id.into(), id.into()],
        ))
        .await?;
    if removed.rows_affected() == 0 {
        return Err(Error::NotFound);
    }
    tx.commit().await?;
    Ok(())
}

pub async fn trim(db: &impl ConnectionTrait, account: Uuid, keep: i32) -> Result<()> {
    let keep = keep.max(0);
    db.execute(sql(
        "DELETE FROM subscription_devices
         WHERE account_id = $1
           AND id NOT IN (
               SELECT id FROM subscription_devices
               WHERE account_id = $1
               ORDER BY last_seen_at DESC, id DESC
               LIMIT $2
           )",
        [account.into(), i64::from(keep).into()],
    ))
    .await?;
    Ok(())
}

pub async fn purge(db: &impl ConnectionTrait) -> Result<()> {
    db.execute(sql(
        "DELETE FROM subscription_devices WHERE last_seen_at < statement_timestamp() - $1::interval",
        [ACTIVE_BINDING.into()],
    )).await?;
    Ok(())
}
