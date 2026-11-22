use sea_orm::{
    ActiveModelTrait, DatabaseConnection, EntityTrait, QuerySelect, Set, SqlErr, TransactionTrait,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    infra::{
        error::{Error, Result, problem},
        postgres::entities::account,
    },
    services::{access, accounts, auth::Auth},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocaleInput {
    pub locale: Option<String>,
}

const SUPPORTED_LOCALES: &[&str] = &["en", "zh-CN", "ja", "ru", "fa"];

pub async fn update_locale(
    db: &DatabaseConnection,
    account_id: Uuid,
    input: LocaleInput,
) -> Result<account::Model> {
    let locale = match input.locale {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else if SUPPORTED_LOCALES.contains(&trimmed) {
                Some(trimmed.to_owned())
            } else {
                return Err(Error::BadRequest(problem::ACCOUNT_LOCALE));
            }
        }
        None => None,
    };
    let current = account::Entity::find_by_id(account_id)
        .one(db)
        .await?
        .filter(|row| row.active)
        .ok_or(Error::NotFound)?;
    let mut update: account::ActiveModel = current.into();
    update.locale = Set(locale);
    Ok(update.update(db).await?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileInput {
    pub email: String,
    pub display_name: String,
    pub current_password: Option<String>,
}

pub async fn update(
    db: &DatabaseConnection,
    auth: &Auth,
    account_id: Uuid,
    input: ProfileInput,
) -> Result<account::Model> {
    let email = accounts::normalize_email(&input.email)?;
    let name = input.display_name.trim();
    if name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(Error::BadRequest(problem::ACCOUNT_DISPLAY_NAME));
    }
    let previous = account::Entity::find_by_id(account_id)
        .one(db)
        .await?
        .filter(|row| row.active)
        .ok_or(Error::NotFound)?;
    if email != previous.email
        && !auth
            .verify_password(
                previous.password_hash.clone(),
                input.current_password.unwrap_or_default(),
            )
            .await?
    {
        return Err(Error::BadRequest(problem::PROFILE_PASSWORD));
    }

    let tx = db.begin().await?;
    let current = account::Entity::find_by_id(account_id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .filter(|row| row.active)
        .ok_or(Error::NotFound)?;
    if previous.password_hash != current.password_hash || previous.email != current.email {
        return Err(Error::Conflict(problem::PROFILE_CHANGED));
    }
    let mut update: account::ActiveModel = current.into();
    update.email = Set(email);
    update.display_name = Set(name.to_owned());
    let updated = update
        .update(&tx)
        .await
        .map_err(|error| match error.sql_err() {
            Some(SqlErr::UniqueConstraintViolation(_)) => {
                Error::Conflict(problem::ACCOUNT_DUPLICATE)
            }
            _ => error.into(),
        })?;
    access::audit(&tx, account_id, "account.own_profile_updated", account_id).await?;
    tx.commit().await?;
    Ok(updated)
}
