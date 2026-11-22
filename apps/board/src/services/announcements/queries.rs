use sea_orm::{AccessMode, ConnectionTrait, DatabaseConnection, IsolationLevel, TransactionTrait};
use uuid::Uuid;

use super::{
    AdminView, Filter, Inbox, UnreadSummary,
    model::{AdminNotice, Notice},
    stmt,
};
use crate::infra::error::{Error, Result, problem};

const PAGE_SIZE: i64 = 25;

/// Published announcements are visible to subscribers only within their configured display window.
const ACTIVE_WINDOW_CLAUSE: &str =
    "a.status = 'published' AND (a.starts_at IS NULL OR a.starts_at <= now()) AND (a.ends_at IS NULL OR a.ends_at > now())";

fn offset(page: i64) -> Result<i64> {
    if !(0..=10_000).contains(&page) {
        return Err(Error::BadRequest(problem::ANNOUNCEMENT_PAGE));
    }
    Ok(page * PAGE_SIZE)
}

pub async fn admin_view(db: &DatabaseConnection, filter: Filter) -> Result<AdminView> {
    let q = filter
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if q.is_some_and(|value| value.chars().count() > 120) {
        return Err(Error::BadRequest(problem::ANNOUNCEMENT_SEARCH));
    }
    let status = filter.status.map(|status| status.as_str());
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let values = [q.into(), status.into()];
    let count = tx
        .query_one(stmt(
            "SELECT count(*) AS total FROM announcements
         WHERE ($1::text IS NULL OR position(lower($1) in lower(title)) > 0)
           AND ($2::text IS NULL OR status = $2)",
            values.clone(),
        ))
        .await?
        .ok_or_else(|| Error::Internal(anyhow::anyhow!("Missing announcement count")))?;
    let skip = offset(filter.page)?;
    let rows = tx
        .query_all(stmt(
            "SELECT a.id, a.title, a.body, a.status, a.display_mode, a.starts_at, a.ends_at,
                a.revision, a.updated_at, a.published_at,
                COALESCE(last_job.failed, false) AS failed
           FROM announcements a
           LEFT JOIN LATERAL (
             SELECT failed_at IS NOT NULL AS failed FROM message_jobs
             WHERE kind = 'announcement.publish' AND payload->>'announcement_id' = a.id::text
             ORDER BY id DESC LIMIT 1
           ) last_job ON a.status = 'queued'
          WHERE ($1::text IS NULL OR position(lower($1) in lower(a.title)) > 0)
            AND ($2::text IS NULL OR a.status = $2)
          ORDER BY a.updated_at DESC, a.id DESC LIMIT $3 OFFSET $4",
            values.into_iter().chain([PAGE_SIZE.into(), skip.into()]),
        ))
        .await?;
    tx.commit().await?;
    let items = rows
        .into_iter()
        .map(|row| {
            Ok(AdminNotice {
                id: row.try_get("", "id")?,
                title: row.try_get("", "title")?,
                body: row.try_get("", "body")?,
                status: row.try_get("", "status")?,
                display_mode: row.try_get("", "display_mode")?,
                starts_at: row.try_get("", "starts_at")?,
                ends_at: row.try_get("", "ends_at")?,
                revision: row.try_get("", "revision")?,
                updated_at: row.try_get("", "updated_at")?,
                published_at: row.try_get("", "published_at")?,
                failed: row.try_get("", "failed")?,
            })
        })
        .collect::<Result<_>>()?;
    Ok(AdminView {
        items,
        total: count.try_get("", "total")?,
        page_size: PAGE_SIZE,
    })
}

pub async fn inbox(db: &DatabaseConnection, account: Uuid, page: i64) -> Result<Inbox> {
    let skip = offset(page)?;
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let counts = tx
        .query_one(stmt(
            &format!(
                "SELECT count(*) AS total, count(*) FILTER (WHERE receipt.account_id IS NULL) AS unread
                   FROM announcements a LEFT JOIN announcement_receipts receipt ON
                     receipt.announcement_id = a.id AND receipt.account_id = $1
                  WHERE {ACTIVE_WINDOW_CLAUSE}"
            ),
            [account.into()],
        ))
        .await?
        .ok_or_else(|| Error::Internal(anyhow::anyhow!("Missing announcement count")))?;
    let rows = tx
        .query_all(stmt(
            &format!(
                "SELECT a.id, a.title, a.body, a.display_mode, a.starts_at, a.ends_at,
                        a.published_at, receipt.account_id IS NOT NULL AS read
                   FROM announcements a LEFT JOIN announcement_receipts receipt ON
                     receipt.announcement_id = a.id AND receipt.account_id = $1
                  WHERE {ACTIVE_WINDOW_CLAUSE}
                  ORDER BY a.published_at DESC, a.id DESC LIMIT $2 OFFSET $3"
            ),
            [account.into(), PAGE_SIZE.into(), skip.into()],
        ))
        .await?;
    tx.commit().await?;
    let items = rows
        .into_iter()
        .map(|row| {
            Ok(Notice {
                id: row.try_get("", "id")?,
                title: row.try_get("", "title")?,
                body: row.try_get("", "body")?,
                display_mode: row.try_get("", "display_mode")?,
                starts_at: row.try_get("", "starts_at")?,
                ends_at: row.try_get("", "ends_at")?,
                published_at: row.try_get("", "published_at")?,
                read: row.try_get("", "read")?,
            })
        })
        .collect::<Result<_>>()?;
    Ok(Inbox {
        items,
        unread: counts.try_get("", "unread")?,
        total: counts.try_get("", "total")?,
        page_size: PAGE_SIZE,
    })
}

pub async fn unread_summary(db: &DatabaseConnection, account: Uuid) -> Result<UnreadSummary> {
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let count_row = tx
        .query_one(stmt(
            &format!(
                "SELECT count(*) AS unread FROM announcements a
                  WHERE {ACTIVE_WINDOW_CLAUSE} AND NOT EXISTS (
                    SELECT 1 FROM announcement_receipts receipt
                     WHERE receipt.announcement_id = a.id AND receipt.account_id = $1
                  )"
            ),
            [account.into()],
        ))
        .await?
        .ok_or_else(|| Error::Internal(anyhow::anyhow!("Missing unread count")))?;
    let fullscreen_rows = tx
        .query_all(stmt(
            &format!(
                "SELECT a.id, a.title, a.body, a.display_mode, a.starts_at, a.ends_at,
                        a.published_at, false AS read
                   FROM announcements a
                  WHERE {ACTIVE_WINDOW_CLAUSE}
                    AND a.display_mode = 'fullscreen'
                    AND NOT EXISTS (
                      SELECT 1 FROM announcement_receipts receipt
                       WHERE receipt.announcement_id = a.id AND receipt.account_id = $1
                    )
                  ORDER BY a.published_at DESC, a.id DESC
                  LIMIT 10"
            ),
            [account.into()],
        ))
        .await?;
    tx.commit().await?;
    let fullscreen = fullscreen_rows
        .into_iter()
        .map(|row| {
            Ok(Notice {
                id: row.try_get("", "id")?,
                title: row.try_get("", "title")?,
                body: row.try_get("", "body")?,
                display_mode: row.try_get("", "display_mode")?,
                starts_at: row.try_get("", "starts_at")?,
                ends_at: row.try_get("", "ends_at")?,
                published_at: row.try_get("", "published_at")?,
                read: row.try_get("", "read")?,
            })
        })
        .collect::<Result<_>>()?;
    Ok(UnreadSummary {
        unread: count_row.try_get("", "unread")?,
        fullscreen,
    })
}

pub async fn mark_read(
    db: &DatabaseConnection,
    account: Uuid,
    ids: Option<Vec<Uuid>>,
) -> Result<()> {
    if ids
        .as_ref()
        .is_some_and(|ids| ids.is_empty() || ids.len() > 100)
    {
        return Err(Error::BadRequest(problem::ANNOUNCEMENT_SELECTION));
    }
    let everything = ids.is_none();
    let values = serde_json::to_value(ids.unwrap_or_default())
        .map_err(|error| Error::Internal(error.into()))?;
    db.execute(stmt(
        &format!(
            "INSERT INTO announcement_receipts (account_id, announcement_id)
             SELECT $1, a.id FROM announcements a WHERE {ACTIVE_WINDOW_CLAUSE} AND
              ($2::bool OR a.id IN (SELECT value::uuid FROM jsonb_array_elements_text($3) requested(value)))
             ON CONFLICT DO NOTHING"
        ),
        [account.into(), everything.into(), values.into()],
    ))
    .await?;
    Ok(())
}
