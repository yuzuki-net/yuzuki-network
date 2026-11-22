use chrono::{DateTime, Utc};
use sea_orm::{
    ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Set, TransactionTrait,
};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    infra::{
        error::{Error, Result, problem},
        postgres::entities::{account, session},
    },
    services::{access, auth::Session},
};

#[derive(Serialize)]
pub struct ListedSession {
    id: Uuid,
    current: bool,
    user_agent: String,
    created_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

pub(super) async fn touch(
    db: &DatabaseConnection,
    id: Uuid,
    now: DateTime<Utc>,
    cutoff: DateTime<Utc>,
) -> Result<()> {
    session::Entity::update_many()
        .set(session::ActiveModel {
            last_seen_at: Set(now),
            ..Default::default()
        })
        .filter(session::Column::Id.eq(id))
        .filter(session::Column::LastSeenAt.lt(cutoff))
        .filter(session::Column::ExpiresAt.gt(now))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn list(db: &DatabaseConnection, caller: &Session) -> Result<Vec<ListedSession>> {
    let rows = session::Entity::find()
        .filter(session::Column::AccountId.eq(caller.account.id))
        .filter(session::Column::ExpiresAt.gt(Utc::now()))
        .order_by_desc(session::Column::LastSeenAt)
        .limit(100)
        .all(db)
        .await?;
    let mut result: Vec<_> = rows
        .into_iter()
        .map(|row| ListedSession {
            id: row.id,
            current: row.id == caller.id,
            user_agent: row.user_agent,
            created_at: row.created_at,
            last_seen_at: row.last_seen_at,
            expires_at: row.expires_at,
        })
        .collect();
    result.sort_by_key(|row| !row.current);
    Ok(result)
}

pub async fn revoke(db: &DatabaseConnection, caller: &Session, id: Uuid) -> Result<()> {
    if id == caller.id {
        return Err(Error::BadRequest(problem::SESSION_CURRENT));
    }
    let tx = begin_revocation(db, caller).await?;
    let removed = session::Entity::delete_many()
        .filter(session::Column::AccountId.eq(caller.account.id))
        .filter(session::Column::Id.eq(id))
        .exec(&tx)
        .await?;
    if removed.rows_affected == 0 {
        return Err(Error::NotFound);
    }
    access::audit(&tx, caller.account.id, "session.revoked", id).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn revoke_other(db: &DatabaseConnection, caller: &Session) -> Result<()> {
    let tx = begin_revocation(db, caller).await?;
    let removed = session::Entity::delete_many()
        .filter(session::Column::AccountId.eq(caller.account.id))
        .filter(session::Column::Id.ne(caller.id))
        .exec(&tx)
        .await?;
    if removed.rows_affected > 0 {
        access::audit(
            &tx,
            caller.account.id,
            "session.others_revoked",
            caller.account.id,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn begin_revocation(
    db: &DatabaseConnection,
    caller: &Session,
) -> Result<DatabaseTransaction> {
    let tx = db.begin().await?;
    account::Entity::find_by_id(caller.account.id)
        .filter(account::Column::Active.eq(true))
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(Error::NotFound)?;
    session::Entity::find_by_id(&caller.token_hash)
        .filter(session::Column::ExpiresAt.gt(Utc::now()))
        .one(&tx)
        .await?
        .ok_or(Error::NotFound)?;
    Ok(tx)
}
