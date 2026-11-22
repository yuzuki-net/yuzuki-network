use axum::{Extension, Json, extract::State};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    app::State as App,
    infra::error::Result,
    services::{accounts::management, auth::Session},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusChange {
    account_ids: Vec<Uuid>,
    active: bool,
}

pub async fn account_status(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<StatusChange>,
) -> Result<Json<Value>> {
    let processed =
        management::batch_status(&app.db, session.account.id, input.account_ids, input.active)
            .await?;
    Ok(Json(json!({ "processed": processed })))
}
