use crate::{
    app::State as App,
    infra::error::Result,
    services::{
        auth::{
            Session,
            profile::{self, LocaleInput, ProfileInput},
            sessions::{self, ListedSession},
        },
        settings::{self, PanelRecord},
    },
    views::json::Account,
};
use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use uuid::Uuid;

pub async fn settings(State(app): State<App>) -> Result<Json<PanelRecord>> {
    Ok(Json(
        settings::read(&app.db, app.settings.allow_registration).await?,
    ))
}

pub async fn update_settings(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<PanelRecord>,
) -> Result<Json<PanelRecord>> {
    Ok(Json(
        settings::update(&app.db, session.account.id, input).await?,
    ))
}

pub async fn sessions(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<Json<Vec<ListedSession>>> {
    Ok(Json(sessions::list(&app.db, &session).await?))
}

pub async fn revoke_session(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    sessions::revoke(&app.db, &session, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn revoke_other(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<StatusCode> {
    sessions::revoke_other(&app.db, &session).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn profile(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<ProfileInput>,
) -> Result<Json<Account>> {
    let account = profile::update(&app.db, &app.auth, session.account.id, input).await?;
    Ok(Json(Account::from(account)))
}

pub async fn locale(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<LocaleInput>,
) -> Result<Json<Account>> {
    let account = profile::update_locale(&app.db, session.account.id, input).await?;
    Ok(Json(Account::from(account)))
}
