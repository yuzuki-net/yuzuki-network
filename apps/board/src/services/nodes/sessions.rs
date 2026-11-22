use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set,
    TransactionTrait,
};
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{Capability, HostInfo, RuntimeStatus},
};

use crate::{
    infra::{
        error::{Error, Result},
        postgres::entities::{server, server_identity},
    },
    services::nodes::inventory,
};

pub struct Identity {
    pub fingerprint: String,
    pub expires_at: DateTime<Utc>,
}

pub async fn enroll(db: &DatabaseConnection, token_hash: String, identity: Identity) -> Result<()> {
    let tx = db.begin().await?;
    let candidate = server::Entity::find()
        .filter(server::Column::EnrollmentHash.eq(&token_hash))
        .filter(server::Column::DeletedAt.is_null())
        .one(&tx)
        .await?
        .ok_or(Error::NotFound)?;
    let row = inventory::locked_active(&tx, candidate.id).await?;
    if row.enrollment_hash.as_deref() != Some(&token_hash)
        || !row
            .enrollment_expires_at
            .is_some_and(|expires| expires > Utc::now())
    {
        return Err(Error::NotFound);
    }
    let mut row: server::ActiveModel = row.into();
    row.enrollment_hash = Set(None);
    row.enrollment_expires_at = Set(None);
    row.update(&tx).await?;
    save(&tx, candidate.id, identity).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn authenticate(db: &DatabaseConnection, fingerprint: &str) -> Result<Uuid> {
    let ident = server_identity::Entity::find_by_id(fingerprint)
        .filter(server_identity::Column::ExpiresAt.gt(Utc::now()))
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    let active = server::Entity::find_by_id(ident.server_id)
        .filter(server::Column::DeletedAt.is_null())
        .one(db)
        .await?
        .is_some();
    if !active {
        return Err(Error::NotFound);
    }
    Ok(ident.server_id)
}

pub async fn renew(db: &DatabaseConnection, fingerprint: &str, identity: Identity) -> Result<()> {
    let id = authenticate(db, fingerprint).await?;
    let tx = db.begin().await?;
    inventory::locked_active(&tx, id).await?;
    check_identity(&tx, id, fingerprint).await?;
    server_identity::Entity::delete_many()
        .filter(server_identity::Column::ServerId.eq(id))
        .filter(server_identity::Column::ExpiresAt.lte(Utc::now()))
        .exec(&tx)
        .await?;
    save(&tx, id, identity).await?;
    tx.commit().await?;
    Ok(())
}

async fn save(
    tx: &sea_orm::DatabaseTransaction,
    server_id: Uuid,
    identity: Identity,
) -> Result<()> {
    server_identity::ActiveModel {
        fingerprint: Set(identity.fingerprint),
        server_id: Set(server_id),
        expires_at: Set(identity.expires_at),
    }
    .insert(tx)
    .await?;
    Ok(())
}

async fn check_identity(
    db: &sea_orm::DatabaseTransaction,
    id: Uuid,
    fingerprint: &str,
) -> Result<()> {
    server_identity::Entity::find_by_id(fingerprint)
        .filter(server_identity::Column::ServerId.eq(id))
        .filter(server_identity::Column::ExpiresAt.gt(Utc::now()))
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    Ok(())
}

fn sanitize_capabilities(capabilities: Vec<Capability>) -> Vec<Capability> {
    Core::ALL
        .iter()
        .filter_map(|core| {
            let capability = capabilities.iter().find(|entry| entry.core == *core)?;
            let version = capability
                .version
                .chars()
                .take_while(|c| *c != '\n')
                .filter(|c| !c.is_control())
                .take(120)
                .collect();
            let path = capability.path.as_ref().map(|p| {
                p.chars()
                    .take_while(|c| *c != '\n')
                    .filter(|c| !c.is_control())
                    .take(240)
                    .collect()
            });
            Some(Capability {
                core: *core,
                version,
                source: capability.source,
                path,
            })
        })
        .collect()
}

fn sanitize_host(host: HostInfo) -> HostInfo {
    let clean = |value: String| -> String {
        value
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            .take(32)
            .collect()
    };
    HostInfo {
        os: clean(host.os),
        arch: clean(host.arch),
        core_management: host.core_management,
    }
}

fn sanitize_warnings(warnings: Vec<String>) -> Vec<String> {
    warnings
        .into_iter()
        .take(16)
        .map(|w| {
            w.chars()
                .filter(|c| !c.is_control())
                .take(240)
                .collect::<String>()
        })
        .filter(|w| !w.trim().is_empty())
        .collect()
}

pub async fn claim(
    db: &DatabaseConnection,
    id: Uuid,
    fingerprint: &str,
    capabilities: Vec<Capability>,
    host: Option<HostInfo>,
    config_warnings: Vec<String>,
) -> Result<Uuid> {
    let tx = db.begin().await?;
    let mut row: server::ActiveModel = inventory::locked_active(&tx, id).await?.into();
    check_identity(&tx, id, fingerprint).await?;
    let session = Uuid::new_v4();
    row.session_id = Set(Some(session));
    row.last_seen_at = Set(Some(Utc::now()));
    let capabilities = sanitize_capabilities(capabilities);
    row.capabilities =
        Set(serde_json::to_value(capabilities).map_err(|error| Error::Internal(error.into()))?);
    if let Some(host) = host {
        row.host_info = Set(Some(
            serde_json::to_value(sanitize_host(host))
                .map_err(|error| Error::Internal(error.into()))?,
        ));
    }
    row.config_warnings = Set(
        serde_json::to_value(sanitize_warnings(config_warnings))
            .map_err(|error| Error::Internal(error.into()))?,
    );
    row.runtime_status = Set(None);
    row.deployment_error = Set(None);
    row.update(&tx).await?;
    tx.commit().await?;
    Ok(session)
}

pub async fn update_capabilities(
    db: &DatabaseConnection,
    id: Uuid,
    session: Uuid,
    capabilities: Vec<Capability>,
    host: Option<HostInfo>,
    clear_error: bool,
) -> Result<()> {
    let capabilities = serde_json::to_value(sanitize_capabilities(capabilities))
        .map_err(|error| Error::Internal(error.into()))?;
    let host_info = match host {
        Some(host) => Set(Some(
            serde_json::to_value(sanitize_host(host))
                .map_err(|error| Error::Internal(error.into()))?,
        )),
        None => Default::default(),
    };
    let row = server::ActiveModel {
        capabilities: Set(capabilities),
        host_info,
        last_seen_at: Set(Some(Utc::now())),
        deployment_error: if clear_error {
            Set(None)
        } else {
            Default::default()
        },
        ..Default::default()
    };
    store_status(db, id, session, row).await
}

pub async fn release(db: &DatabaseConnection, id: Uuid, session: Uuid) -> Result<()> {
    session_rows(id, session)
        .set(server::ActiveModel {
            session_id: Set(None),
            ..Default::default()
        })
        .exec(db)
        .await?;
    Ok(())
}

pub async fn heartbeat(
    db: &DatabaseConnection,
    id: Uuid,
    session: Uuid,
    instances: Vec<RuntimeStatus>,
) -> Result<()> {
    let sanitized: Vec<RuntimeStatus> = instances
        .into_iter()
        .map(|mut item| {
            item.error = item.error.map(|e| {
                e.chars()
                    .filter(|c| !c.is_control() || *c == ' ')
                    .take(360)
                    .collect()
            });
            item
        })
        .collect();
    let status = serde_json::to_value(sanitized).map_err(|error| Error::Internal(error.into()))?;
    store_status(
        db,
        id,
        session,
        server::ActiveModel {
            runtime_status: Set(Some(status)),
            last_seen_at: Set(Some(Utc::now())),
            ..Default::default()
        },
    )
    .await
}

pub async fn report(
    db: &DatabaseConnection,
    id: Uuid,
    session: Uuid,
    revision: &str,
    error: Option<String>,
) -> Result<()> {
    let row = server::ActiveModel {
        last_seen_at: Set(Some(Utc::now())),
        applied_revision: if error.is_none() {
            Set(Some(revision.into()))
        } else {
            Default::default()
        },
        deployment_error: Set(error),
        ..Default::default()
    };
    store_status(db, id, session, row).await
}

fn session_rows(id: Uuid, session: Uuid) -> sea_orm::UpdateMany<server::Entity> {
    server::Entity::update_many()
        .filter(server::Column::Id.eq(id))
        .filter(server::Column::SessionId.eq(session))
        .filter(server::Column::DeletedAt.is_null())
}

async fn store_status(
    db: &DatabaseConnection,
    id: Uuid,
    session: Uuid,
    row: server::ActiveModel,
) -> Result<()> {
    let result = session_rows(id, session).set(row).exec(db).await?;
    if result.rows_affected == 0 {
        return Err(Error::NotFound);
    }
    Ok(())
}
