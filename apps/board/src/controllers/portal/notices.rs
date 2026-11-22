use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::Response,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    app::State as App,
    controllers::pages,
    infra::error::{Error, Result},
    services::{
        announcements::{
            self, AdminView, Bulk, Draft, DraftUpdate, Filter, Inbox, Read, UnreadSummary,
        },
        auth::Session,
        settings,
    },
};

async fn enabled(app: &App) -> Result<()> {
    if !settings::public(&app.db, app.settings.allow_registration)
        .await?
        .features
        .announcements
    {
        return Err(Error::NotFound);
    }
    Ok(())
}

pub async fn page(State(app): State<App>) -> Result<Response> {
    enabled(&app).await?;
    pages::workspace().await
}

#[derive(Deserialize)]
pub struct Page {
    #[serde(default)]
    page: i64,
}

pub async fn inbox(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Query(page): Query<Page>,
) -> Result<Json<Inbox>> {
    enabled(&app).await?;
    Ok(Json(
        announcements::inbox(&app.db, session.account.id, page.page).await?,
    ))
}

pub async fn unread(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<Json<UnreadSummary>> {
    enabled(&app).await?;
    Ok(Json(
        announcements::unread_summary(&app.db, session.account.id).await?,
    ))
}

pub async fn mark_read(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<Read>,
) -> Result<StatusCode> {
    enabled(&app).await?;
    announcements::mark_read(&app.db, session.account.id, input.ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn admin_view(
    State(app): State<App>,
    Query(filter): Query<Filter>,
) -> Result<Json<AdminView>> {
    Ok(Json(announcements::admin_view(&app.db, filter).await?))
}

pub async fn create(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<Draft>,
) -> Result<(StatusCode, Json<Value>)> {
    let id = announcements::create(&app.db, session.account.id, input).await?;
    Ok((StatusCode::CREATED, Json(json!({"id": id}))))
}

pub async fn bulk(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<Bulk>,
) -> Result<StatusCode> {
    announcements::bulk(&app.db, session.account.id, input).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<DraftUpdate>,
) -> Result<StatusCode> {
    announcements::update(&app.db, session.account.id, id, input).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn publish(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<(StatusCode, Json<Value>)> {
    announcements::publish(&app.db, session.account.id, id).await?;
    Ok((StatusCode::ACCEPTED, Json(json!({"queued": true}))))
}

pub async fn archive(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    announcements::archive(&app.db, session.account.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    announcements::delete(&app.db, session.account.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
