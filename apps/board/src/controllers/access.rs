use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    app::State as App,
    infra::error::Result,
    services::{
        access::{self, Permission, Role, RoleInput},
        auth::Session,
    },
};

pub async fn roles(State(app): State<App>) -> Result<Json<Vec<Role>>> {
    Ok(Json(access::roles(&app.db).await?))
}

pub async fn permissions() -> Json<Vec<Value>> {
    Json(
        Permission::ALL
            .iter()
            .map(
                |point| json!({"key": point.key(), "group": point.group(), "label": point.label()}),
            )
            .collect(),
    )
}

pub async fn create_role(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<RoleInput>,
) -> Result<(StatusCode, Json<Role>)> {
    Ok((
        StatusCode::CREATED,
        Json(access::update_role(&app.db, session.account.id, None, input).await?),
    ))
}

pub async fn update_role(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<RoleInput>,
) -> Result<Json<Role>> {
    Ok(Json(
        access::update_role(&app.db, session.account.id, Some(id), input).await?,
    ))
}

pub async fn remove_role(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    access::remove_role(&app.db, session.account.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct AuditQuery {
    before: Option<i64>,
    q: Option<String>,
    kind: Option<access::AuditKind>,
}

pub async fn audit(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Vec<access::AuditEntry>>> {
    Ok(Json(
        access::audit_entries(
            &app.db,
            query.before,
            query.q.as_deref(),
            query.kind,
            session.access.allows(Permission::AnnouncementsRead),
        )
        .await?,
    ))
}
