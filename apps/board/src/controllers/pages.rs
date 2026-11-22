use axum::{
    Extension,
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Redirect, Response},
};

use crate::{
    app::State as App,
    infra::{
        error::{Error, Result},
        frontend,
    },
    services::{auth::Session, settings},
};

pub async fn home(State(app): State<App>) -> Result<Response> {
    frontend::public(&app.public_dir, "index.html").await
}

pub async fn login(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    if let Some(path) = super::auth::workspace_destination(&app, &headers).await? {
        return Ok(Redirect::to(path).into_response());
    }
    frontend::public(&app.public_dir, "login.html").await
}

pub async fn register(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    if let Some(path) = super::auth::workspace_destination(&app, &headers).await? {
        return Ok(Redirect::to(path).into_response());
    }
    if !settings::public(&app.db, app.settings.allow_registration)
        .await?
        .features
        .registration
    {
        return Err(Error::NotFound);
    }
    frontend::public(&app.public_dir, "register.html").await
}

pub async fn assets(State(app): State<App>, Path(name): Path<String>) -> Result<Response> {
    frontend::public(&app.public_dir, &format!("assets/{name}")).await
}

pub async fn workspace() -> Result<Response> {
    frontend::private("workspace.html")
}

pub async fn workspace_assets(
    Extension(session): Extension<Session>,
    Path(name): Path<String>,
) -> Result<Response> {
    if name.starts_with("admin-") && !session.access.can_open_admin() {
        return Err(Error::NotFound);
    }
    frontend::private(&format!("assets/{name}"))
}

pub async fn admin() -> Result<Response> {
    frontend::private("admin.html")
}
