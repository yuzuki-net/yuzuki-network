use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use yuzuki_core_config::protocols::valid_host;

use crate::{
    infra::{
        error::{Error, Result, problem},
        postgres::entities::{proxy_node, server, server_identity},
    },
    services::{
        access::{self, sql},
        auth::issue_token,
        nodes::broker::NodeBroker,
    },
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerInput {
    pub name: String,
    #[serde(default)]
    pub remark: String,
    #[serde(default)]
    pub default_host: Option<String>,
}

#[derive(Serialize)]
pub struct ServerView {
    pub id: Uuid,
    pub name: String,
    pub remark: String,
    pub default_host: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub applied_revision: Option<String>,
    pub deployment_error: Option<String>,
    pub enrollment_expires_at: Option<DateTime<Utc>>,
    pub agent_session: bool,
    pub capabilities: serde_json::Value,
    pub runtime_status: Option<serde_json::Value>,
    pub host_info: Option<serde_json::Value>,
    pub config_warnings: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub location: Option<String>,
    pub node_count: i64,
    pub enabled_node_count: i64,
}

pub fn label(value: String) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 || value.chars().any(char::is_control) {
        return Err(Error::BadRequest(problem::NODE_NAME));
    }
    Ok(value.into())
}

fn clean_remark(value: String) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.chars().count() > 400
        || trimmed
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(Error::BadRequest(problem::SERVER_REMARK));
    }
    Ok(trimmed.to_string())
}

fn clean_default_host(value: Option<String>) -> Result<Option<String>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !valid_host(trimmed) {
        return Err(Error::Invalid("Invalid default host address.".into()));
    }
    Ok(Some(trimmed.to_string()))
}

pub async fn list(db: &DatabaseConnection, include_deleted: bool) -> Result<Vec<ServerView>> {
    let mut query = server::Entity::find()
        .order_by_asc(server::Column::DeletedAt)
        .order_by_asc(server::Column::Name)
        .order_by_asc(server::Column::Id);
    if !include_deleted {
        query = query.filter(server::Column::DeletedAt.is_null());
    }
    let rows = query.all(db).await?;
    decorate(db, rows).await
}

pub async fn get_view(db: &DatabaseConnection, id: Uuid) -> Result<ServerView> {
    let row = server::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    decorate(db, vec![row])
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)
}

async fn decorate(db: &impl ConnectionTrait, rows: Vec<server::Model>) -> Result<Vec<ServerView>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    let loc_rows = db
        .query_all(sql(
            "SELECT server_id, label FROM server_locations
             WHERE server_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))",
            [serde_json::json!(ids).into()],
        ))
        .await?;
    let mut locations: HashMap<Uuid, String> = HashMap::new();
    for row in loc_rows {
        locations.insert(row.try_get("", "server_id")?, row.try_get("", "label")?);
    }

    let count_rows = db
        .query_all(sql(
            "SELECT server_id,
                    count(*) AS total,
                    count(*) FILTER (WHERE enabled) AS enabled_count
             FROM proxy_nodes
             WHERE deleted_at IS NULL
               AND server_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))
             GROUP BY server_id",
            [serde_json::json!(ids).into()],
        ))
        .await?;
    let mut counts: HashMap<Uuid, (i64, i64)> = HashMap::new();
    for row in count_rows {
        counts.insert(
            row.try_get("", "server_id")?,
            (
                row.try_get("", "total")?,
                row.try_get("", "enabled_count")?,
            ),
        );
    }

    Ok(rows
        .into_iter()
        .map(|row| {
            let (node_count, enabled_node_count) = counts.get(&row.id).copied().unwrap_or((0, 0));
            let location = locations.remove(&row.id);
            ServerView {
                id: row.id,
                name: row.name,
                remark: row.remark,
                default_host: row.default_host,
                last_seen_at: row.last_seen_at,
                applied_revision: row.applied_revision,
                deployment_error: row.deployment_error,
                enrollment_expires_at: row.enrollment_expires_at,
                agent_session: row.session_id.is_some(),
                capabilities: row.capabilities,
                runtime_status: row.runtime_status,
                host_info: row.host_info,
                config_warnings: row.config_warnings,
                created_at: row.created_at,
                deleted_at: row.deleted_at,
                location,
                node_count,
                enabled_node_count,
            }
        })
        .collect())
}

pub async fn create(
    db: &DatabaseConnection,
    actor: Uuid,
    input: ServerInput,
) -> Result<ServerView> {
    let name = label(input.name)?;
    let remark = clean_remark(input.remark)?;
    let default_host = clean_default_host(input.default_host)?;

    let tx = db.begin().await?;
    let id = Uuid::new_v4();
    let row = server::ActiveModel {
        id: Set(id),
        name: Set(name.clone()),
        remark: Set(remark),
        default_host: Set(default_host),
        capabilities: Set(serde_json::json!([])),
        config_warnings: Set(serde_json::json!([])),
        created_at: Set(Utc::now()),
        ..Default::default()
    }
    .insert(&tx)
    .await?;
    access::audit_subject(&tx, actor, "server.created", id, Some(&name)).await?;
    let view = decorate(&tx, vec![row])
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(view)
}

pub async fn update(
    db: &DatabaseConnection,
    actor: Uuid,
    id: Uuid,
    input: ServerInput,
) -> Result<ServerView> {
    let name = label(input.name)?;
    let remark = clean_remark(input.remark)?;
    let default_host = clean_default_host(input.default_host)?;

    let tx = db.begin().await?;
    let mut row: server::ActiveModel = locked_active(&tx, id).await?.into();
    row.name = Set(name.clone());
    row.remark = Set(remark);
    row.default_host = Set(default_host);
    let updated = row.update(&tx).await?;
    access::audit_subject(&tx, actor, "server.updated", id, Some(&name)).await?;
    let view = decorate(&tx, vec![updated])
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(view)
}

/// Default delete = Soft delete (moves server to Trash, revokes identities,
/// disconnects online agent, and optionally cascades to hosted nodes).
pub async fn soft_delete(
    db: &DatabaseConnection,
    broker: &NodeBroker,
    actor: Uuid,
    id: Uuid,
    cascade: bool,
) -> Result<()> {
    let tx = db.begin().await?;
    let existing = locked_active(&tx, id).await?;
    let hosted_ids: Vec<Uuid> = proxy_node::Entity::find()
        .filter(proxy_node::Column::ServerId.eq(id))
        .filter(proxy_node::Column::DeletedAt.is_null())
        .all(&tx)
        .await?
        .into_iter()
        .map(|n| n.id)
        .collect();
    if !hosted_ids.is_empty() && !cascade {
        return Err(Error::Conflict(problem::SERVER_HAS_NODES));
    }

    let now = Utc::now();
    if !hosted_ids.is_empty() {
        // Also soft-delete any active relay nodes pointing to these hosted nodes.
        proxy_node::Entity::update_many()
            .set(proxy_node::ActiveModel {
                deleted_at: Set(Some(now)),
                enabled: Set(false),
                show: Set(false),
                meter_port: Set(None),
                updated_at: Set(now),
                ..Default::default()
            })
            .filter(proxy_node::Column::ParentId.is_in(hosted_ids.clone()))
            .filter(proxy_node::Column::DeletedAt.is_null())
            .exec(&tx)
            .await?;

        proxy_node::Entity::update_many()
            .set(proxy_node::ActiveModel {
                deleted_at: Set(Some(now)),
                enabled: Set(false),
                show: Set(false),
                meter_port: Set(None),
                updated_at: Set(now),
                ..Default::default()
            })
            .filter(proxy_node::Column::Id.is_in(hosted_ids))
            .exec(&tx)
            .await?;
    }

    let name = existing.name.clone();
    let mut row: server::ActiveModel = existing.into();
    row.deleted_at = Set(Some(now));
    row.enrollment_hash = Set(None);
    row.enrollment_expires_at = Set(None);
    row.session_id = Set(None);
    row.update(&tx).await?;

    server_identity::Entity::delete_many()
        .filter(server_identity::Column::ServerId.eq(id))
        .exec(&tx)
        .await?;
    tx.execute(sql(
        "DELETE FROM observed_instances WHERE server_id = $1",
        [id.into()],
    ))
    .await?;

    access::audit_subject(&tx, actor, "server.deleted", id, Some(&name)).await?;
    tx.commit().await?;

    broker.disconnect(id, "server moved to trash");
    Ok(())
}

pub async fn restore(db: &DatabaseConnection, actor: Uuid, id: Uuid) -> Result<ServerView> {
    let tx = db.begin().await?;
    let existing = locked_any(&tx, id).await?;
    if existing.deleted_at.is_none() {
        let view = decorate(&tx, vec![existing])
            .await?
            .into_iter()
            .next()
            .ok_or(Error::NotFound)?;
        tx.commit().await?;
        return Ok(view);
    }
    let name = existing.name.clone();
    let mut row: server::ActiveModel = existing.into();
    row.deleted_at = Set(None);
    let updated = row.update(&tx).await?;
    access::audit_subject(&tx, actor, "server.restored", id, Some(&name)).await?;
    let view = decorate(&tx, vec![updated])
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(view)
}

/// Manual permanent hard delete (only allowed for soft-deleted servers in Trash).
pub async fn purge(db: &DatabaseConnection, actor: Uuid, id: Uuid) -> Result<()> {
    let tx = db.begin().await?;
    let existing = locked_any(&tx, id).await?;
    if existing.deleted_at.is_none() {
        return Err(Error::Conflict(problem::NODE_NOT_DELETED));
    }
    let name = existing.name.clone();
    server::Entity::delete_by_id(id).exec(&tx).await?;
    access::audit_subject(&tx, actor, "server.purged", id, Some(&name)).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn purge_trash(db: &DatabaseConnection, actor: Uuid) -> Result<u64> {
    let tx = db.begin().await?;
    let trashed = server::Entity::find()
        .filter(server::Column::DeletedAt.is_not_null())
        .all(&tx)
        .await?;
    let count = trashed.len() as u64;
    for row in trashed {
        server::Entity::delete_by_id(row.id).exec(&tx).await?;
        access::audit_subject(&tx, actor, "server.purged", row.id, Some(&row.name)).await?;
    }
    tx.commit().await?;
    Ok(count)
}

pub async fn locked_active(db: &sea_orm::DatabaseTransaction, id: Uuid) -> Result<server::Model> {
    server::Entity::find_by_id(id)
        .filter(server::Column::DeletedAt.is_null())
        .lock_exclusive()
        .one(db)
        .await?
        .ok_or(Error::NotFound)
}

pub async fn locked_any(db: &sea_orm::DatabaseTransaction, id: Uuid) -> Result<server::Model> {
    server::Entity::find_by_id(id)
        .lock_exclusive()
        .one(db)
        .await?
        .ok_or(Error::NotFound)
}

pub async fn enroll_token(db: &DatabaseConnection, id: Uuid) -> Result<String> {
    let token = issue_token();
    let result = server::Entity::update_many()
        .set(server::ActiveModel {
            enrollment_hash: Set(Some(token.digest)),
            enrollment_expires_at: Set(Some(Utc::now() + Duration::minutes(15))),
            ..Default::default()
        })
        .filter(server::Column::Id.eq(id))
        .filter(server::Column::DeletedAt.is_null())
        .exec(db)
        .await?;
    if result.rows_affected == 0 {
        return Err(Error::NotFound);
    }
    Ok(token.value)
}

pub async fn revoke_identities(
    db: &DatabaseConnection,
    broker: &NodeBroker,
    id: Uuid,
) -> Result<()> {
    let tx = db.begin().await?;
    let mut row: server::ActiveModel = locked_active(&tx, id).await?.into();
    row.enrollment_hash = Set(None);
    row.enrollment_expires_at = Set(None);
    row.session_id = Set(None);
    row.update(&tx).await?;
    server_identity::Entity::delete_many()
        .filter(server_identity::Column::ServerId.eq(id))
        .exec(&tx)
        .await?;
    tx.commit().await?;
    broker.disconnect(id, "server identities revoked");
    Ok(())
}
