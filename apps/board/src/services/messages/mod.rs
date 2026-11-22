use std::time::Duration;

use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, QueryResult, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    infra::error::{Error, Result},
    services::announcements,
};

const MAX_ATTEMPTS: i16 = 6;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    PublishAnnouncement { announcement_id: Uuid },
}

impl Message {
    fn kind(&self) -> &'static str {
        match self {
            Self::PublishAnnouncement { .. } => "announcement.publish",
        }
    }
}

pub async fn enqueue(db: &impl ConnectionTrait, message: Message) -> Result<()> {
    let payload = serde_json::to_value(&message).map_err(json_error)?;
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO message_jobs (kind, payload) VALUES ($1, $2)",
        [message.kind().into(), payload.into()],
    ))
    .await?;
    Ok(())
}

pub async fn worker(db: DatabaseConnection) {
    let mut ticks = tokio::time::interval(Duration::from_secs(2));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticks.tick().await;
        if let Err(error) = drain(&db).await {
            tracing::warn!(?error, "Message worker could not drain its queue");
        }
    }
}

pub async fn drain(db: &DatabaseConnection) -> Result<u32> {
    let mut processed = 0;
    while processed < 50 && process_one(db).await? {
        processed += 1;
    }
    Ok(processed)
}

async fn process_one(db: &DatabaseConnection) -> Result<bool> {
    let tx = db.begin().await?;
    let pending = tx
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT id, kind, payload, attempts FROM message_jobs
         WHERE completed_at IS NULL AND failed_at IS NULL AND available_at <= now()
         ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED",
        ))
        .await?;
    let Some(pending) = pending else {
        tx.commit().await?;
        return Ok(false);
    };
    let id: i64 = pending.try_get("", "id")?;
    let attempts = pending.try_get::<i16>("", "attempts")? + 1;
    let delivery = tx.begin().await?;
    let statement = match deliver(&delivery, &pending).await {
        Ok(()) => {
            delivery.commit().await?;
            Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "UPDATE message_jobs SET completed_at = now(), attempts = $2 WHERE id = $1",
                [id.into(), attempts.into()],
            )
        }
        Err(error) => {
            delivery.rollback().await?;
            tracing::warn!(id, attempts, ?error, "Message delivery failed");
            Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "UPDATE message_jobs SET attempts = $2,
                   failed_at = CASE WHEN $2 >= $3 THEN now() ELSE NULL END,
                   available_at = now() + (interval '1 second' * $4::int)
                 WHERE id = $1",
                [
                    id.into(),
                    attempts.into(),
                    MAX_ATTEMPTS.into(),
                    (1_i32 << attempts.min(6)).into(),
                ],
            )
        }
    };
    tx.execute(statement).await?;
    tx.commit().await?;
    Ok(true)
}

async fn deliver(db: &impl ConnectionTrait, row: &QueryResult) -> Result<()> {
    let kind: String = row.try_get("", "kind")?;
    let message: Message =
        serde_json::from_value(row.try_get::<Value>("", "payload")?).map_err(json_error)?;
    if message.kind() != kind {
        return Err(Error::Internal(anyhow::anyhow!(
            "Queued message kind does not match payload"
        )));
    }
    match message {
        Message::PublishAnnouncement { announcement_id } => {
            announcements::deliver(db, announcement_id).await
        }
    }
}

fn json_error(error: serde_json::Error) -> Error {
    Error::Internal(error.into())
}
