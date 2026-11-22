use axum::{
    Extension, Json,
    extract::{Request, State},
    http::{
        HeaderMap, HeaderValue, Method, StatusCode,
        header::{SET_COOKIE, USER_AGENT},
    },
    middleware::Next,
    response::Response,
};
use serde::{Deserialize, Serialize};

use crate::{
    app::State as App,
    infra::error::{Error, Result},
    services::{accounts, auth::Session, settings},
    views::json::Account,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub email: String,
    pub password: String,
}

pub async fn browser_request(request: Request, next: Next) -> Result<Response> {
    if !matches!(*request.method(), Method::GET | Method::HEAD)
        && request
            .headers()
            .get("x-workspace-request")
            .and_then(|value| value.to_str().ok())
            != Some("1")
    {
        return Err(Error::NotFound);
    }
    Ok(next.run(request).await)
}

pub async fn session(State(app): State<App>, mut request: Request, next: Next) -> Result<Response> {
    let session = app.auth.session(&app.db, request.headers()).await?;
    request.extensions_mut().insert(session);
    Ok(next.run(request).await)
}

#[derive(Serialize)]
pub struct PublicAuthState {
    signed_in: bool,
    workspace: Option<&'static str>,
}

#[derive(Serialize)]
pub struct Options {
    #[serde(flatten)]
    session: PublicAuthState,
    registration: bool,
    panel: settings::Panel,
}

pub async fn options(State(app): State<App>, headers: HeaderMap) -> Result<Json<Options>> {
    let session = public_auth_state(&app, &headers).await?;
    let panel = settings::public(&app.db, app.settings.allow_registration).await?;
    Ok(Json(Options {
        session,
        registration: panel.features.registration,
        panel,
    }))
}

pub async fn public_session(
    State(app): State<App>,
    headers: HeaderMap,
) -> Result<Json<PublicAuthState>> {
    Ok(Json(public_auth_state(&app, &headers).await?))
}

async fn public_auth_state(app: &App, headers: &HeaderMap) -> Result<PublicAuthState> {
    let workspace = workspace_destination(app, headers).await?;
    Ok(PublicAuthState {
        signed_in: workspace.is_some(),
        workspace,
    })
}

pub(super) async fn workspace_destination(
    app: &App,
    headers: &HeaderMap,
) -> Result<Option<&'static str>> {
    match app.auth.session(&app.db, headers).await {
        Ok(session) => Ok(Some(workspace_path(session.access.can_open_admin()))),
        Err(Error::NotFound) => Ok(None),
        Err(error) => Err(error),
    }
}

fn workspace_path(administration: bool) -> &'static str {
    if administration {
        "/admin"
    } else {
        "/workspace"
    }
}

pub async fn login(
    State(app): State<App>,
    request_headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> Result<(HeaderMap, StatusCode)> {
    let signed_in = app
        .auth
        .sign_in(
            &app.db,
            input.email,
            input.password,
            request_headers
                .get(USER_AGENT)
                .and_then(|header| header.to_str().ok()),
        )
        .await?;
    let mut headers = HeaderMap::new();
    headers.insert(SET_COOKIE, signed_in.cookie);
    headers.insert(
        "x-workspace-path",
        HeaderValue::from_static(workspace_path(signed_in.admin_workspace)),
    );
    Ok((headers, StatusCode::NO_CONTENT))
}

pub async fn register(
    State(app): State<App>,
    Json(input): Json<Credentials>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    if !settings::public(&app.db, app.settings.allow_registration)
        .await?
        .features
        .registration
    {
        return Err(Error::NotFound);
    }
    accounts::create(
        &app.db,
        &app.auth,
        input.email,
        input.password,
        false,
        false,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({"pending": true})),
    ))
}

pub async fn logout(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<(HeaderMap, StatusCode)> {
    let mut headers = HeaderMap::new();
    headers.insert(SET_COOKIE, app.auth.sign_out(&app.db, session).await?);
    Ok((headers, StatusCode::NO_CONTENT))
}

#[derive(Serialize)]
pub struct SessionView {
    #[serde(flatten)]
    account: Account,
    access: crate::services::access::Access,
    admin_workspace: bool,
}

pub async fn me(Extension(session): Extension<Session>) -> Json<SessionView> {
    let admin_workspace = session.access.can_open_admin();
    Json(SessionView {
        account: Account::from(session.account),
        access: session.access,
        admin_workspace,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasswordInput {
    current_password: String,
    new_password: String,
}

pub async fn change_password(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<PasswordInput>,
) -> Result<StatusCode> {
    accounts::management::change_own_password(
        &app.db,
        &app.auth,
        session.account.id,
        input.current_password,
        input.new_password,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
