use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    app::State as App,
    infra::error::Result,
    services::{
        auth::Session,
        dashboard::{self, Location, Overview, Range},
    },
};

#[derive(Deserialize)]
pub struct Options {
    #[serde(default)]
    range: Range,
}

pub async fn overview(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Query(options): Query<Options>,
) -> Result<Json<Overview>> {
    Ok(Json(
        dashboard::overview(&app.db, &session.access, options.range).await?,
    ))
}

pub async fn location(
    State(app): State<App>,
    Path(id): Path<Uuid>,
) -> Result<Json<Option<Location>>> {
    Ok(Json(dashboard::read_location(&app.db, id).await?))
}

pub async fn save_location(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    Json(location): Json<Location>,
) -> Result<StatusCode> {
    dashboard::write_location(&app.db, id, location).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_location(State(app): State<App>, Path(id): Path<Uuid>) -> Result<StatusCode> {
    dashboard::clear_location(&app.db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
