pub mod management;

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set, SqlErr,
    TransactionTrait,
};
use uuid::Uuid;

use crate::{
    infra::error::{Error, Result, problem},
    infra::postgres::entities::account,
    services::{access, auth::Auth},
};

pub fn normalize_email(email: &str) -> Result<String> {
    let email = email.trim();
    let valid = email.len() <= 254
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && domain.contains('.')
                && domain.split('.').all(|part| !part.is_empty())
                && local
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._+-".contains(&c))
                && domain
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
        });
    if !valid {
        return Err(Error::BadRequest(problem::ACCOUNT_EMAIL));
    }
    Ok(email.to_ascii_lowercase())
}

pub async fn by_email(db: &DatabaseConnection, email: &str) -> Result<Option<account::Model>> {
    Ok(account::Entity::find()
        .filter(account::Column::Email.eq(email))
        .one(db)
        .await?)
}

pub async fn create(
    db: &DatabaseConnection,
    auth: &Auth,
    email: String,
    password: String,
    admin: bool,
    active: bool,
) -> Result<account::Model> {
    create_account(db, auth, email, password, admin, active, None).await
}

pub async fn create_managed(
    db: &DatabaseConnection,
    auth: &Auth,
    email: String,
    password: String,
    actor: Uuid,
) -> Result<account::Model> {
    create_account(db, auth, email, password, false, true, Some(actor)).await
}

pub async fn set_admin(db: &DatabaseConnection, email: &str, admin: bool) -> Result<account::Model> {
    let email = normalize_email(email)?;
    let tx = db.begin().await?;
    let existing = account::Entity::find()
        .filter(account::Column::Email.eq(&email))
        .one(&tx)
        .await?
        .ok_or(Error::NotFound)?;
    let mut row: account::ActiveModel = existing.into();
    row.admin = Set(admin);
    let updated = row.update(&tx).await?;
    if admin {
        access::add_admin_role(&tx, updated.id).await?;
    } else {
        access::remove_admin_role(&tx, updated.id).await?;
        access::add_default_role(&tx, updated.id).await?;
    }
    tx.commit().await?;
    Ok(updated)
}

async fn create_account(
    db: &DatabaseConnection,
    auth: &Auth,
    email: String,
    password: String,
    admin: bool,
    active: bool,
    actor: Option<Uuid>,
) -> Result<account::Model> {
    let email = normalize_email(&email)?;
    let password_hash = auth.hash_password(password).await?;
    let tx = db.begin().await?;
    if let Some(actor) = actor {
        access::begin_change(&tx).await?;
        access::actor(&tx, actor, &[access::Permission::UsersCreate]).await?;
    }
    let account = account::ActiveModel {
        id: Set(Uuid::new_v4()),
        email: Set(email),
        display_name: Set(String::new()),
        locale: Set(None),
        password_hash: Set(password_hash),
        admin: Set(admin),
        active: Set(active),
        access_id: Set(Uuid::new_v4()),
        used_bytes: Set(0),
        created_at: Set(Utc::now()),
    }
    .insert(&tx)
    .await
    .map_err(|error| match error.sql_err() {
        Some(SqlErr::UniqueConstraintViolation(_)) => Error::Conflict(problem::EMAIL_TAKEN),
        _ => error.into(),
    })?;
    if admin {
        access::add_admin_role(&tx, account.id).await?;
        crate::services::quotas::policy::issue_default_for_role(&tx, account.id, access::ADMIN_ROLE)
            .await?;
    } else {
        access::add_default_role(&tx, account.id).await?;
        crate::services::quotas::policy::issue_default_for_role(&tx, account.id, access::MEMBER)
            .await?;
    }
    if let Ok(settings) = crate::services::settings::read(&tx, false).await
        && settings.panel.subscription.auto_provision_links
    {
        let access = access::permissions_for(&tx, &account).await?;
        if access.allows(access::Permission::SubscriptionsRead)
            && access.allows(access::Permission::SubscriptionsManage)
        {
            let limits = crate::services::quotas::policy::LinkLimits::default().resolve(&access);
            crate::services::subscriptions::links::provision_defaults(
                &tx,
                account.id,
                &settings.panel.name,
                limits,
            )
            .await?;
        }
    }
    if let Some(actor) = actor {
        access::audit(&tx, actor, "account.created", account.id).await?;
    }
    tx.commit().await?;
    Ok(account)
}
