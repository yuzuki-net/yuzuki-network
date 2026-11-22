use std::{collections::HashSet, fmt::Write};

use chrono::{DateTime, Utc};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, FromQueryResult, QueryFilter,
    QuerySelect, TransactionTrait,
};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;
use yuzuki_protocol::v1::{InstanceDevices, MAX_ONLINE_INSTANCES, MAX_ONLINE_SOURCES};

use crate::infra::{
    error::{Error, Result, problem},
    postgres::entities::server,
};

use super::{invalid_result, sql};

#[derive(FromQueryResult, Serialize)]
pub struct Presence {
    pub sources: i64,
    pub measured_instances: i64,
    pub active_instances: i64,
}

pub async fn read(db: &impl ConnectionTrait, as_of: DateTime<Utc>) -> Result<Presence> {
    Presence::find_by_statement(sql(
        "WITH active AS (
             SELECT n.id, s.session_id
             FROM proxy_nodes n
             JOIN servers s ON n.server_id = s.id
             WHERE n.deleted_at IS NULL AND n.enabled AND n.mode IN ('managed', 'custom')
               AND s.deleted_at IS NULL AND s.session_id IS NOT NULL
               AND s.last_seen_at > $1::timestamptz - INTERVAL '60 seconds'
         ), measured AS (
             SELECT id FROM active JOIN observed_instances oi ON oi.node_id = active.id
                AND oi.session_id = active.session_id AND oi.observed_at > $1::timestamptz - INTERVAL '20 seconds'
         )
         SELECT
            (SELECT count(DISTINCT (s.account_id, s.fingerprint)) FROM observed_sources s JOIN measured ON s.node_id = measured.id) AS sources,
            (SELECT count(*) FROM measured) AS measured_instances,
            (SELECT count(*) FROM active) AS active_instances",
        [as_of.into()],
    ))
    .one(db)
    .await?
    .ok_or_else(invalid_result)
}

pub async fn key(db: &DatabaseConnection) -> Result<[u8; 32]> {
    let proposed = rand::random::<[u8; 32]>();
    db.execute(sql(
        "INSERT INTO device_fingerprint_key VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
        [proposed.to_vec().into()],
    ))
    .await?;
    let row = db
        .query_one(sql(
            "SELECT key FROM device_fingerprint_key WHERE id = 1",
            [],
        ))
        .await?
        .ok_or_else(invalid_result)?;
    let key: Vec<u8> = row.try_get("", "key")?;
    key.try_into().map_err(|_| invalid_result())
}

pub async fn record(
    db: &DatabaseConnection,
    server_id: Uuid,
    session: Uuid,
    instances: Vec<InstanceDevices>,
) -> Result<()> {
    let ids: HashSet<_> = instances.iter().map(|report| report.instance_id).collect();
    if instances.len() > MAX_ONLINE_INSTANCES
        || ids.len() != instances.len()
        || instances
            .iter()
            .map(|report| report.sources.len())
            .sum::<usize>()
            > MAX_ONLINE_SOURCES
    {
        return Err(Error::BadRequest(problem::PRESENCE_REPORT));
    }
    let tx = db.begin().await?;
    server::Entity::find_by_id(server_id)
        .filter(server::Column::DeletedAt.is_null())
        .lock_exclusive()
        .one(&tx)
        .await?
        .filter(|record| record.session_id == Some(session))
        .ok_or(Error::NotFound)?;
    tx.execute(sql(
        "DELETE FROM observed_instances WHERE server_id = $1",
        [server_id.into()],
    ))
    .await?;

    if !instances.is_empty() {
        tx.execute(sql(
            "INSERT INTO observed_instances (node_id, server_id, session_id)
             SELECT n.id, n.server_id, $2 FROM proxy_nodes n
             JOIN jsonb_array_elements_text($3::jsonb) AS requested(id) ON n.id = requested.id::uuid
             WHERE n.server_id = $1 AND n.deleted_at IS NULL AND n.enabled",
            [server_id.into(), session.into(), json!(ids).into()],
        ))
        .await?;
        let records: Vec<_> = instances
            .iter()
            .flat_map(|report| {
                report.sources.iter().map(move |source| {
                    let mut fingerprint = String::with_capacity(64);
                    for byte in source.source {
                        let _ = write!(fingerprint, "{byte:02x}");
                    }
                    json!({ "node_id": report.instance_id, "access_id": source.access_id, "fingerprint": fingerprint })
                })
            })
            .collect();
        if !records.is_empty() {
            tx.execute(sql(
                "INSERT INTO observed_sources (node_id, account_id, fingerprint)
                 SELECT r.node_id, a.id, decode(r.fingerprint, 'hex')
                 FROM jsonb_to_recordset($2::jsonb) AS r(node_id uuid, access_id uuid, fingerprint text)
                 JOIN observed_instances i ON i.node_id = r.node_id AND i.server_id = $1
                 JOIN accounts a ON a.access_id = r.access_id
                 ON CONFLICT DO NOTHING",
                [server_id.into(), json!(records).into()],
            ))
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}
