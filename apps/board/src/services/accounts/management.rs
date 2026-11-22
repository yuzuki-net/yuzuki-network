use std::collections::HashSet;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    DatabaseTransaction, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    SqlErr, Statement, TransactionTrait,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    infra::{
        error::{Error, Result, problem},
        postgres::entities::{account, session},
    },
    services::{
        access::{self, Permission},
        auth::Auth,
        subscriptions::links,
    },
};

#[derive(Default, Deserialize)]
pub struct DirectoryQuery {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub page: u64,
    pub active: Option<bool>,
}

pub async fn directory(
    db: &DatabaseConnection,
    query: DirectoryQuery,
) -> Result<(Vec<account::Model>, u64)> {
    if query.page > 10_000 || query.q.chars().count() > 120 {
        return Err(Error::BadRequest(problem::ACCOUNT_FILTER));
    }
    let mut select = account::Entity::find()
        .order_by_asc(account::Column::Email)
        .order_by_asc(account::Column::Id);
    if !query.q.trim().is_empty() {
        let search = query.q.trim().to_lowercase();
        select = select.filter(
            Condition::any()
                .add(account::Column::Email.contains(&search))
                .add(sea_orm::sea_query::Expr::cust_with_values(
                    "lower(display_name) LIKE $1",
                    [format!("%{search}%")],
                )),
        );
    }
    if let Some(active) = query.active {
        select = select.filter(account::Column::Active.eq(active));
    }
    let selected = select.paginate(db, 25);
    let count = selected.num_items().await?;
    Ok((selected.fetch_page(query.page).await?, count))
}

pub async fn manageable_accounts(
    db: &DatabaseConnection,
    actor: &access::Access,
    ids: &[Uuid],
) -> Result<HashSet<Uuid>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    if actor.owner {
        return Ok(ids.iter().copied().collect());
    }
    let permissions: Vec<_> = actor.permissions.iter().map(|point| point.key()).collect();
    let query = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT a.id FROM accounts a
         JOIN jsonb_array_elements_text($1::jsonb) AS wanted(id) ON a.id = wanted.id::uuid
         WHERE NOT a.admin AND NOT EXISTS (
            SELECT permission FROM account_permissions WHERE account_id = a.id AND NOT ($2::jsonb ? permission)
            UNION ALL
            SELECT rp.permission FROM account_roles ar JOIN role_permissions rp ON ar.role_id = rp.role_id
                 WHERE ar.account_id = a.id AND NOT ($2::jsonb ? rp.permission)
         )",
        [serde_json::json!(ids).into(), serde_json::json!(permissions).into()],
    );
    db.query_all(query)
        .await?
        .into_iter()
        .map(|row| row.try_get("", "id").map_err(Error::from))
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub email: String,
    pub display_name: String,
}

pub enum Update {
    Profile(Profile),
    Enabled(bool),
}

pub async fn update(
    db: &DatabaseConnection,
    who: Uuid,
    id: Uuid,
    change: Update,
) -> Result<account::Model> {
    let tx = db.begin().await?;
    access::begin_change(&tx).await?;
    let actor = access::actor(&tx, who, &[Permission::UsersUpdate]).await?;
    let account = apply(&tx, who, &actor, id, change).await?;
    tx.commit().await?;
    Ok(account)
}

pub async fn batch_status(
    db: &DatabaseConnection,
    who: Uuid,
    mut ids: Vec<Uuid>,
    active: bool,
) -> Result<usize> {
    if ids.is_empty() || ids.len() > 50 {
        return Err(Error::BadRequest(problem::ACCOUNT_SELECTION));
    }
    ids.sort_unstable();
    ids.dedup();
    let tx = db.begin().await?;
    access::begin_change(&tx).await?;
    let actor = access::actor(&tx, who, &[Permission::UsersRead, Permission::UsersUpdate]).await?;
    for id in &ids {
        apply(&tx, who, &actor, *id, Update::Enabled(active)).await?;
    }
    tx.commit().await?;
    Ok(ids.len())
}

async fn apply(
    tx: &DatabaseTransaction,
    who: Uuid,
    actor: &access::Access,
    id: Uuid,
    change: Update,
) -> Result<account::Model> {
    let (account, _) = access::subject(tx, actor, id).await?;
    if matches!(&change, Update::Enabled(active) if *active == account.active) {
        return Ok(account);
    }
    let owner = account.admin;
    let mut row: account::ActiveModel = account.into();
    let mut revoke = false;
    let action = match change {
        Update::Profile(profile) => {
            let name = profile.display_name.trim();
            if name.chars().count() > 100 || name.chars().any(char::is_control) {
                return Err(Error::BadRequest(problem::ACCOUNT_DISPLAY_NAME));
            }
            row.display_name = Set(name.into());
            row.email = Set(super::normalize_email(&profile.email)?);
            "account.profile_updated"
        }
        Update::Enabled(active) => {
            if !active && (owner || who == id) {
                return Err(Error::BadRequest(problem::ACCOUNT_REQUIRED));
            }
            row.active = Set(active);
            revoke = !active;
            "account.status_updated"
        }
    };
    let updated = row
        .update(tx)
        .await
        .map_err(|error| match error.sql_err() {
            Some(SqlErr::UniqueConstraintViolation(_)) => {
                Error::Conflict(problem::ACCOUNT_DUPLICATE)
            }
            _ => error.into(),
        })?;
    if revoke {
        links::delete_all(tx, id).await?;
        clear_sessions(tx, id).await?;
    }
    access::audit(tx, who, action, id).await?;
    Ok(updated)
}

pub async fn reset_credentials(
    db: &DatabaseConnection,
    auth: &Auth,
    who: Uuid,
    id: Uuid,
    password: Option<String>,
) -> Result<()> {
    if who == id {
        return Err(Error::NotFound);
    }
    let hash = match password {
        Some(password) => Some(auth.hash_password(password).await?),
        None => None,
    };
    let tx = db.begin().await?;
    access::begin_change(&tx).await?;
    let actor = access::actor(&tx, who, &[Permission::UsersCredentials]).await?;
    let (account, _) = access::subject(&tx, &actor, id).await?;
    if account.admin {
        return Err(Error::NotFound);
    }
    let action = if let Some(hash) = hash {
        let mut row: account::ActiveModel = account.into();
        row.password_hash = Set(hash);
        row.update(&tx).await?;
        links::delete_all(&tx, id).await?;
        "account.password_reset"
    } else {
        "account.sessions_revoked"
    };
    clear_sessions(&tx, id).await?;
    access::audit(&tx, who, action, id).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn change_own_password(
    db: &DatabaseConnection,
    auth: &Auth,
    id: Uuid,
    current: String,
    password: String,
) -> Result<()> {
    let old = account::Entity::find_by_id(id)
        .one(db)
        .await?
        .filter(|row| row.active)
        .ok_or(Error::NotFound)?;
    if !auth
        .verify_password(old.password_hash.clone(), current)
        .await?
    {
        return Err(Error::BadRequest(problem::ACCOUNT_CURRENT_PASSWORD));
    }
    let hash = auth.hash_password(password).await?;
    let tx = db.begin().await?;
    let current = account::Entity::find_by_id(id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .filter(|row| row.active && row.password_hash == old.password_hash)
        .ok_or(Error::Conflict(problem::ACCOUNT_PASSWORD_CHANGED))?;
    let mut row: account::ActiveModel = current.into();
    row.password_hash = Set(hash);
    row.update(&tx).await?;
    clear_sessions(&tx, id).await?;
    access::audit(&tx, id, "account.own_password_changed", id).await?;
    tx.commit().await?;
    Ok(())
}

async fn clear_sessions(tx: &sea_orm::DatabaseTransaction, id: Uuid) -> Result<()> {
    session::Entity::delete_many()
        .filter(session::Column::AccountId.eq(id))
        .exec(tx)
        .await?;
    Ok(())
}
