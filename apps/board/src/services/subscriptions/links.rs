use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, QueryResult, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use yuzuki_core_config::Format;

use crate::{
    infra::{
        error::{Error, Result, problem},
        postgres::entities::account,
    },
    services::{
        access::{self, Access, Permission, sql},
        auth::{Session, issue_token},
        quotas::policy::{self, Status},
        settings,
    },
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewLink {
    pub name: String,
    pub format: u8,
}

#[derive(Serialize)]
pub struct View {
    pub id: Uuid,
    pub name: String,
    pub format: u8,
    pub path: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub within_limit: bool,
}

pub(crate) fn parse_format(code: u8) -> Result<Format> {
    match code {
        0 => Ok(Format::Xray),
        1 => Ok(Format::SingBox),
        2 => Ok(Format::Mihomo),
        3 => Ok(Format::Universal),
        _ => Err(Error::BadRequest(problem::LINK_FORMAT)),
    }
}

pub fn format_label(format: Format) -> &'static str {
    match format {
        Format::Xray => "xray-core",
        Format::SingBox => "sing-box",
        Format::Mihomo => "mihomo",
        Format::Universal => "Universal",
    }
}

pub fn path(route: &str, token: &str, format: u8) -> String {
    format!("/{route}/{token}?f={format}")
}

pub async fn list(
    db: &impl ConnectionTrait,
    owner: Uuid,
    route: &str,
    limits: [i32; 4],
) -> Result<Vec<View>> {
    let rows = db
        .query_all(sql(
            "SELECT id, name, format, token, created_at, last_used_at
             FROM subscription_links WHERE account_id = $1 ORDER BY format, created_at, id",
            [owner.into()],
        ))
        .await?;
    let mut counts = [0; 4];
    rows.iter()
        .map(|row| {
            let code = code(row)?;
            let index = usize::from(code);
            if index < counts.len() {
                counts[index] += 1;
                view(row, route, code, counts[index] <= limits[index])
            } else {
                view(row, route, code, false)
            }
        })
        .collect()
}

/// Automatically create 1 default subscription link for every format where
/// the account currently has 0 links and its effective link limit is >= 1.
pub async fn provision_defaults(
    db: &impl ConnectionTrait,
    owner: Uuid,
    panel_name: &str,
    limits: [i32; 4],
) -> Result<usize> {
    let prefix = if panel_name.trim().is_empty() {
        "Default"
    } else {
        panel_name.trim()
    };
    let mut created = 0usize;
    for format in Format::ALL {
        let idx = usize::from(format.code());
        if limits[idx] < 1 {
            continue;
        }
        if count(db, owner, format).await? > 0 {
            continue;
        }
        let mut name = format!("{prefix} · {}", format_label(format));
        if name.chars().count() > 80 {
            name = name.chars().take(80).collect();
        }
        let token = issue_token().value;
        db.execute(sql(
            "INSERT INTO subscription_links (id, account_id, format, name, token, created_at)
             VALUES ($1, $2, $3, $4, $5, statement_timestamp())",
            [
                Uuid::new_v4().into(),
                owner.into(),
                i16::from(format.code()).into(),
                name.into(),
                token.into(),
            ],
        ))
        .await?;
        created += 1;
    }
    Ok(created)
}

pub async fn provision_for_session(
    db: &DatabaseConnection,
    session: &Session,
    route: &str,
) -> Result<Vec<View>> {
    let tx = db.begin().await?;
    let (account, access) = authorize_management(&tx, session).await?;
    let limits = policy::read(&tx, account.id)
        .await?
        .link_limits
        .resolve(&access);
    let panel_name = settings::read(&tx, false)
        .await
        .map(|s| s.panel.name)
        .unwrap_or_else(|_| "Default".to_string());
    provision_defaults(&tx, account.id, &panel_name, limits).await?;
    let links = list(&tx, account.id, route, limits).await?;
    tx.commit().await?;
    Ok(links)
}

pub async fn create(
    db: &DatabaseConnection,
    session: &Session,
    route: &str,
    input: NewLink,
) -> Result<View> {
    let name = validated_name(&input.name)?;
    let format = parse_format(input.format)?;
    let tx = db.begin().await?;
    let (account, access) = authorize_management(&tx, session).await?;
    let owner = account.id;
    let limits = policy::read(&tx, owner).await?.link_limits.resolve(&access);
    if count(&tx, owner, format).await? >= i64::from(limits[usize::from(format.code())]) {
        return Err(Error::Conflict(problem::LINK_LIMIT));
    }
    let token = issue_token().value;
    let row = tx
        .query_one(sql(
            "INSERT INTO subscription_links (id, account_id, format, name, token, created_at)
             VALUES ($1, $2, $3, $4, $5, statement_timestamp())
             RETURNING id, name, format, token, created_at, last_used_at",
            [
                Uuid::new_v4().into(),
                owner.into(),
                i16::from(format.code()).into(),
                name.into(),
                token.into(),
            ],
        ))
        .await?
        .ok_or(Error::NotFound)?;
    let record = view(&row, route, format.code(), true)?;
    tx.commit().await?;
    Ok(record)
}

pub async fn rename(
    db: &DatabaseConnection,
    session: &Session,
    id: Uuid,
    name: &str,
) -> Result<()> {
    let name = validated_name(name)?;
    let tx = db.begin().await?;
    let (account, _) = authorize_management(&tx, session).await?;
    let updated = tx
        .execute(sql(
            "UPDATE subscription_links SET name = $3 WHERE account_id = $1 AND id = $2",
            [account.id.into(), id.into(), name.into()],
        ))
        .await?;
    if updated.rows_affected() != 1 {
        return Err(Error::NotFound);
    }
    tx.commit().await?;
    Ok(())
}

fn validated_name(value: &str) -> Result<&str> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(Error::BadRequest(problem::LINK_NAME));
    }
    Ok(name)
}

fn view(row: &QueryResult, route: &str, format: u8, within_limit: bool) -> Result<View> {
    let token: String = row.try_get("", "token")?;
    Ok(View {
        id: row.try_get("", "id")?,
        name: row.try_get("", "name")?,
        format,
        path: path(route, &token, format),
        created_at: row.try_get("", "created_at")?,
        last_used_at: row.try_get("", "last_used_at")?,
        within_limit,
    })
}

fn code(row: &QueryResult) -> Result<u8> {
    let format: i16 = row.try_get("", "format")?;
    u8::try_from(format).map_err(|error| Error::Internal(error.into()))
}

pub async fn remove(db: &DatabaseConnection, session: &Session, ids: Vec<Uuid>) -> Result<()> {
    let ids: BTreeSet<_> = ids.into_iter().collect();
    if ids.is_empty() || ids.len() > 300 {
        return Err(Error::BadRequest(problem::LINK_SELECTION));
    }
    let tx = db.begin().await?;
    let (account, _) = authorize_management(&tx, session).await?;
    let owner = account.id;
    for id in ids {
        let deleted = tx
            .execute(sql(
                "DELETE FROM subscription_links WHERE account_id = $1 AND id = $2",
                [owner.into(), id.into()],
            ))
            .await?;
        if deleted.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
    }
    tx.commit().await?;
    Ok(())
}

pub(super) async fn authorize_management(
    tx: &DatabaseTransaction,
    session: &Session,
) -> Result<(account::Model, Access)> {
    access::begin_read(tx).await?;
    let account = policy::lock_account(tx, session.account.id).await?;
    tx.query_one(sql(
        "SELECT 1 FROM sessions
         WHERE id = $1 AND account_id = $2 AND expires_at > statement_timestamp()
         FOR KEY SHARE",
        [session.id.into(), account.id.into()],
    ))
    .await?
    .ok_or(Error::NotFound)?;
    let access = access::permissions_for(tx, &account).await?;
    if !account.active
        || !access.allows(Permission::SubscriptionsRead)
        || !access.allows(Permission::SubscriptionsManage)
    {
        return Err(Error::NotFound);
    }
    Ok((account, access))
}

async fn count(db: &impl ConnectionTrait, account: Uuid, format: Format) -> Result<i64> {
    let row = db
        .query_one(sql(
            "SELECT count(*) AS count FROM subscription_links WHERE account_id = $1 AND format = $2",
            [account.into(), i16::from(format.code()).into()],
        ))
        .await?
        .ok_or(Error::NotFound)?;
    Ok(row.try_get("", "count")?)
}

pub(crate) struct Download {
    pub account: account::Model,
    pub link_id: Uuid,
    pub link_name: String,
    pub quota: Status,
}

pub(crate) async fn resolve(
    tx: &DatabaseTransaction,
    token: &str,
    format: Format,
) -> Result<Download> {
    let format_code = i16::from(format.code());
    let row = tx
        .query_one(sql(
            "SELECT account_id FROM subscription_links WHERE token = $1 AND format = $2",
            [token.into(), format_code.into()],
        ))
        .await?
        .ok_or(Error::NotFound)?;
    let owner: Uuid = row.try_get("", "account_id")?;
    let account = policy::lock_account(tx, owner).await?;
    let access = access::permissions_for(tx, &account).await?;
    let quota = policy::read(tx, owner).await?;
    if !quota.eligible || !access.allows(Permission::SubscriptionsRead) {
        return Err(Error::NotFound);
    }
    let limit = quota.link_limits.resolve(&access)[usize::from(format.code())];
    if limit == 0 {
        return Err(Error::NotFound);
    }
    let result = tx
        .query_one(sql(
            "SELECT chosen.id, chosen.name,
                  (SELECT count(*) FROM subscription_links link WHERE link.account_id = chosen.account_id
                    AND link.format = chosen.format AND (link.created_at, link.id) <= (chosen.created_at, chosen.id))
                    AS position
             FROM subscription_links chosen
             WHERE chosen.account_id = $1 AND chosen.token = $2 AND chosen.format = $3",
            [owner.into(), token.into(), format_code.into()],
        ))
        .await?
        .ok_or(Error::NotFound)?;
    let position: i64 = result.try_get("", "position")?;
    if position > i64::from(limit) {
        return Err(Error::NotFound);
    }
    Ok(Download {
        account,
        link_id: result.try_get("", "id")?,
        link_name: result.try_get("", "name")?,
        quota,
    })
}

pub(crate) async fn mark_download(db: &impl ConnectionTrait, id: Uuid) -> Result<()> {
    db.execute(sql(
        "UPDATE subscription_links SET last_used_at = statement_timestamp() WHERE id = $1",
        [id.into()],
    ))
    .await?;
    Ok(())
}

pub(crate) async fn delete_all(db: &impl ConnectionTrait, id: Uuid) -> Result<()> {
    db.execute(sql(
        "DELETE FROM subscription_links WHERE account_id = $1",
        [id.into()],
    ))
    .await?;
    db.execute(sql(
        "DELETE FROM subscription_devices WHERE account_id = $1",
        [id.into()],
    ))
    .await?;
    Ok(())
}
