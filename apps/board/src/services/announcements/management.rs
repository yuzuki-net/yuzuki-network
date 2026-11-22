use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseTransaction, TransactionTrait};
use uuid::Uuid;

use super::{Bulk, Draft, DraftUpdate, model::BulkAction, stmt};
use crate::{
    infra::error::{Error, Result, problem},
    services::{
        access::{self, Permission},
        messages::{self, Message},
        settings,
    },
};

fn normalize(draft: Draft) -> Result<Draft> {
    let title = draft.title.trim();
    let body = draft.body.trim();
    if title.is_empty() || title.chars().count() > 120 || title.chars().any(char::is_control) {
        return Err(Error::BadRequest(problem::ANNOUNCEMENT_TITLE));
    }
    if body.is_empty()
        || body.chars().count() > 10_000
        || body
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(Error::BadRequest(problem::ANNOUNCEMENT_BODY));
    }
    if let (Some(starts_at), Some(ends_at)) = (draft.starts_at, draft.ends_at)
        && ends_at <= starts_at
    {
        return Err(Error::BadRequest(problem::ANNOUNCEMENT_SCHEDULE));
    }
    Ok(Draft {
        title: title.to_owned(),
        body: body.to_owned(),
        display_mode: draft.display_mode,
        starts_at: draft.starts_at,
        ends_at: draft.ends_at,
    })
}

async fn changing(db: &DatabaseConnection, actor: Uuid) -> Result<DatabaseTransaction> {
    let tx = db.begin().await?;
    access::begin_change(&tx).await?;
    access::actor(&tx, actor, &[Permission::AnnouncementsManage]).await?;
    Ok(tx)
}

pub async fn create(db: &DatabaseConnection, actor: Uuid, draft: Draft) -> Result<Uuid> {
    let draft = normalize(draft)?;
    let tx = changing(db, actor).await?;
    let id = Uuid::new_v4();
    tx.execute(stmt(
        "INSERT INTO announcements (id, title, body, status, display_mode, starts_at, ends_at, created_by)
         VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7)",
        [
            id.into(),
            draft.title.as_str().into(),
            draft.body.into(),
            draft.display_mode.as_str().into(),
            draft.starts_at.into(),
            draft.ends_at.into(),
            actor.into(),
        ],
    ))
    .await?;
    access::audit_subject(&tx, actor, "announcement.created", id, Some(&draft.title)).await?;
    tx.commit().await?;
    Ok(id)
}

pub async fn update(
    db: &DatabaseConnection,
    actor: Uuid,
    id: Uuid,
    input: DraftUpdate,
) -> Result<()> {
    let draft = normalize(Draft {
        title: input.title,
        body: input.body,
        display_mode: input.display_mode,
        starts_at: input.starts_at,
        ends_at: input.ends_at,
    })?;
    let tx = changing(db, actor).await?;
    let write = tx
        .execute(stmt(
            "UPDATE announcements
                SET title = $2, body = $3, display_mode = $4, starts_at = $5, ends_at = $6,
                    revision = revision + 1, updated_at = now()
              WHERE id = $1 AND status = 'draft' AND revision = $7",
            [
                id.into(),
                draft.title.as_str().into(),
                draft.body.into(),
                draft.display_mode.as_str().into(),
                draft.starts_at.into(),
                draft.ends_at.into(),
                input.revision.into(),
            ],
        ))
        .await?;
    if write.rows_affected() != 1 {
        return Err(Error::Conflict(problem::ANNOUNCEMENT_CHANGED));
    }
    access::audit_subject(&tx, actor, "announcement.updated", id, Some(&draft.title)).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn publish(db: &DatabaseConnection, actor: Uuid, id: Uuid) -> Result<()> {
    let tx = changing(db, actor).await?;
    if !settings::read(&tx, false)
        .await?
        .panel
        .features
        .announcements
    {
        return Err(Error::NotFound);
    }
    let existing = tx
        .query_one(stmt(
            "SELECT status, title FROM announcements WHERE id = $1 FOR UPDATE",
            [id.into()],
        ))
        .await?
        .ok_or(Error::NotFound)?;
    let status: String = existing.try_get("", "status")?;
    match status.as_str() {
        "draft" => {
            tx.execute(stmt(
                "UPDATE announcements SET status = 'queued', revision = revision + 1, updated_at = now() WHERE id = $1",
                [id.into()],
            )).await?;
        }
        "queued" => {
            let latest = tx
                .query_one(stmt(
                    "SELECT failed_at IS NOT NULL AS failed
                 FROM message_jobs WHERE kind = 'announcement.publish'
                   AND payload->>'announcement_id' = $1
                 ORDER BY id DESC LIMIT 1",
                    [id.to_string().into()],
                ))
                .await?;
            if let Some(latest) = latest
                && !latest.try_get::<bool>("", "failed")?
            {
                return Err(Error::Conflict(problem::ANNOUNCEMENT_QUEUED));
            }
        }
        _ => return Err(Error::Conflict(problem::ANNOUNCEMENT_PUBLISH_STATUS)),
    }
    messages::enqueue(
        &tx,
        Message::PublishAnnouncement {
            announcement_id: id,
        },
    )
    .await?;
    let title: String = existing.try_get("", "title")?;
    access::audit_subject(&tx, actor, "announcement.queued", id, Some(&title)).await?;
    tx.commit().await?;
    Ok(())
}

pub(in crate::services) async fn deliver(db: &impl ConnectionTrait, id: Uuid) -> Result<()> {
    db.execute(stmt(
        "UPDATE announcements SET status = 'published', published_at = now(),
             updated_at = now(), revision = revision + 1 WHERE id = $1 AND status = 'queued'",
        [id.into()],
    ))
    .await?;
    Ok(())
}

pub async fn archive(db: &DatabaseConnection, actor: Uuid, id: Uuid) -> Result<()> {
    let tx = changing(db, actor).await?;
    let archived = tx.query_one(stmt(
        "UPDATE announcements SET status = 'archived', revision = revision + 1, updated_at = now()
         WHERE id = $1 AND status IN ('queued','published') RETURNING title",
        [id.into()],
    )).await?.ok_or(Error::Conflict(problem::ANNOUNCEMENT_ARCHIVE_STATUS))?;
    let title: String = archived.try_get("", "title")?;
    access::audit_subject(&tx, actor, "announcement.archived", id, Some(&title)).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn delete(db: &DatabaseConnection, actor: Uuid, id: Uuid) -> Result<()> {
    let tx = changing(db, actor).await?;
    let removed = tx
        .query_one(stmt(
            "DELETE FROM announcements WHERE id = $1 AND status IN ('draft','archived') RETURNING title",
            [id.into()],
        ))
        .await?.ok_or(Error::Conflict(problem::ANNOUNCEMENT_DELETE_STATUS))?;
    let title: String = removed.try_get("", "title")?;
    access::audit_subject(&tx, actor, "announcement.deleted", id, Some(&title)).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn bulk(db: &DatabaseConnection, actor: Uuid, mut input: Bulk) -> Result<()> {
    if input.ids.is_empty() || input.ids.len() > 100 {
        return Err(Error::BadRequest(problem::ANNOUNCEMENT_SELECTION));
    }
    input.ids.sort_unstable();
    input.ids.dedup();
    let tx = changing(db, actor).await?;
    let (sql, event) = match input.action {
        BulkAction::Archive => (
            "UPDATE announcements SET status = 'archived', revision = revision + 1, updated_at = now()
              WHERE status IN ('queued','published') AND id IN
                 (SELECT value::uuid FROM jsonb_array_elements_text($1) requested(value))",
            "announcement.archived",
        ),
        BulkAction::Delete => (
            "DELETE FROM announcements WHERE status IN ('draft','archived') AND id IN
                 (SELECT value::uuid FROM jsonb_array_elements_text($1) requested(value))",
            "announcement.deleted",
        ),
    };
    let ids = serde_json::to_value(&input.ids).map_err(|error| Error::Internal(error.into()))?;
    let changed = tx
        .execute(stmt(
            &format!(
                "WITH changed AS ({sql} RETURNING id, title)
         INSERT INTO access_audit (actor_id, action, target, target_label)
         SELECT $2, $3, id::text, title FROM changed"
            ),
            [ids.into(), actor.into(), event.into()],
        ))
        .await?;
    if changed.rows_affected() != input.ids.len() as u64 {
        return Err(Error::Conflict(problem::ANNOUNCEMENT_BULK_CHANGED));
    }
    tx.commit().await?;
    Ok(())
}
