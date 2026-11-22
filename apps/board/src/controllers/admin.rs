use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;
use yuzuki_core_config::routing::Policy;

use crate::{
    app::State as App,
    infra::error::Result,
    services::{
        access::Permission,
        auth::Session,
        nodes::{
            catalog::{self, BatchInput, ProxyNodeInput, ProxyNodePatch, ProxyNodeView, ReorderInput},
            cores::{self, CoreCatalog, CoreTaskView, InstallCoreInput},
            inventory::{self, ServerInput, ServerView},
        },
        subscriptions::policy,
    },
};

#[derive(Default, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub include_deleted: bool,
}

#[derive(Default, Deserialize)]
pub struct DeleteQuery {
    #[serde(default)]
    pub cascade: bool,
}

// ── Servers (Managed Hosts / Agents) ─────────────────────────────────────────

pub async fn servers(
    State(app): State<App>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<ServerView>>> {
    Ok(Json(inventory::list(&app.db, query.include_deleted).await?))
}

pub async fn server_control(State(app): State<App>) -> Json<Value> {
    Json(json!({"available": app.settings.control.is_some()}))
}

pub async fn core_catalog() -> Json<CoreCatalog> {
    Json(cores::catalog())
}

pub async fn create_server(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<ServerInput>,
) -> Result<(StatusCode, Json<ServerView>)> {
    Ok((
        StatusCode::CREATED,
        Json(inventory::create(&app.db, session.account.id, input).await?),
    ))
}

pub async fn update_server(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<ServerInput>,
) -> Result<Json<ServerView>> {
    Ok(Json(
        inventory::update(&app.db, session.account.id, id, input).await?,
    ))
}

pub async fn delete_server(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Query(query): Query<DeleteQuery>,
) -> Result<StatusCode> {
    inventory::soft_delete(&app.db, &app.broker, session.account.id, id, query.cascade).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_server(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<Json<ServerView>> {
    Ok(Json(
        inventory::restore(&app.db, session.account.id, id).await?,
    ))
}

pub async fn purge_server(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    inventory::purge(&app.db, session.account.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn purge_server_trash(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<Json<Value>> {
    let purged = inventory::purge_trash(&app.db, session.account.id).await?;
    Ok(Json(json!({ "purged": purged })))
}

pub async fn enrollment(State(app): State<App>, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    Ok(Json(
        json!({"token": inventory::enroll_token(&app.db, id).await?, "expires_seconds": 900}),
    ))
}

pub async fn revoke_server(State(app): State<App>, Path(id): Path<Uuid>) -> Result<StatusCode> {
    inventory::revoke_identities(&app.db, &app.broker, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn server_core_tasks(
    State(app): State<App>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<CoreTaskView>>> {
    Ok(Json(cores::list_tasks(&app.db, id).await?))
}

pub async fn install_server_core(
    State(app): State<App>,
    Path((id, core)): Path<(Uuid, String)>,
    Json(input): Json<InstallCoreInput>,
) -> Result<(StatusCode, Json<CoreTaskView>)> {
    let core = cores::parse_core(&core)?;
    let task = cores::install_core(&app.db, &app.broker, id, core, input).await?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub async fn remove_server_core(
    State(app): State<App>,
    Path((id, core)): Path<(Uuid, String)>,
) -> Result<(StatusCode, Json<CoreTaskView>)> {
    let core = cores::parse_core(&core)?;
    let task = cores::remove_core(&app.db, &app.broker, id, core).await?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub async fn probe_server_cores(
    State(app): State<App>,
    Path(id): Path<Uuid>,
) -> Result<(StatusCode, Json<CoreTaskView>)> {
    let task = cores::probe_cores(&app.db, &app.broker, id).await?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

// ── Proxy Nodes (V2Board / XBoard Style Lines) ───────────────────────────────

pub async fn nodes(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<ProxyNodeView>>> {
    let secrets = session.access.allows(Permission::NodesManage);
    Ok(Json(
        catalog::list(&app.db, query.include_deleted, secrets).await?,
    ))
}

pub async fn create_node(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<ProxyNodeInput>,
) -> Result<(StatusCode, Json<ProxyNodeView>)> {
    Ok((
        StatusCode::CREATED,
        Json(catalog::save_node(&app.db, session.account.id, None, input).await?),
    ))
}

pub async fn update_node(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<ProxyNodeInput>,
) -> Result<Json<ProxyNodeView>> {
    Ok(Json(
        catalog::save_node(&app.db, session.account.id, Some(id), input).await?,
    ))
}

pub async fn patch_node(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<ProxyNodePatch>,
) -> Result<Json<ProxyNodeView>> {
    Ok(Json(
        catalog::patch_node(&app.db, session.account.id, id, input).await?,
    ))
}

pub async fn delete_node(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Query(query): Query<DeleteQuery>,
) -> Result<StatusCode> {
    catalog::soft_delete_node(&app.db, session.account.id, id, query.cascade).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_node(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<Json<ProxyNodeView>> {
    Ok(Json(
        catalog::restore_node(&app.db, session.account.id, id).await?,
    ))
}

pub async fn purge_node(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    catalog::purge_node(&app.db, session.account.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn purge_node_trash(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<Json<Value>> {
    let purged = catalog::purge_trash(&app.db, session.account.id).await?;
    Ok(Json(json!({ "purged": purged })))
}

pub async fn clone_node(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<(StatusCode, Json<ProxyNodeView>)> {
    Ok((
        StatusCode::CREATED,
        Json(catalog::clone_node(&app.db, session.account.id, id).await?),
    ))
}

pub async fn restart_node(
    State(app): State<App>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    catalog::restart_node(&app.db, &app.broker, id).await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn reorder_nodes(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<ReorderInput>,
) -> Result<StatusCode> {
    catalog::reorder_nodes(&app.db, session.account.id, input.items).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn batch_nodes(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<BatchInput>,
) -> Result<Json<Value>> {
    let updated = catalog::batch_nodes(&app.db, session.account.id, input).await?;
    Ok(Json(json!({ "updated": updated })))
}

// ── Routing Policies ─────────────────────────────────────────────────────────

pub async fn policies(State(app): State<App>) -> Result<Json<policy::Policies>> {
    Ok(Json(policy::read(&app.db).await?))
}

pub async fn save_policy(State(app): State<App>, Json(input): Json<Policy>) -> Result<StatusCode> {
    policy::save(&app.db, input).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn publish(State(app): State<App>) -> Result<Json<Value>> {
    Ok(Json(json!({"revision": policy::publish(&app.db).await?})))
}

pub async fn discard_policy(State(app): State<App>) -> Result<StatusCode> {
    policy::discard(&app.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn revisions(State(app): State<App>) -> Result<Json<Vec<i64>>> {
    Ok(Json(policy::revisions(&app.db).await?))
}

pub async fn rollback(State(app): State<App>, Path(id): Path<i64>) -> Result<StatusCode> {
    policy::rollback(&app.db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
