use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::MethodFilter as Method,
};
use sea_orm::{AccessMode, IsolationLevel, TransactionTrait};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::permit;
use crate::{
    app::State as App,
    infra::error::Result,
    services::{
        access::{
            Permission::{SubscriptionsManage, SubscriptionsRead},
            Rules::Require,
        },
        auth::Session,
        quotas::policy::{self, Status},
        subscriptions::{self, devices, links},
    },
};

#[derive(Serialize)]
struct Snapshot {
    links: Vec<links::View>,
    effective_link_limits: [i32; 4],
    endpoints: [usize; 4],
    requires_proxy: bool,
    quota: Status,
}

#[derive(Serialize)]
struct Devices {
    active_for_days: u8,
    items: Vec<devices::DeviceView>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ids {
    ids: Vec<Uuid>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkName {
    name: String,
}

pub(super) fn routes() -> Router<App> {
    let read = Require(&[SubscriptionsRead]);
    let manage = Require(&[SubscriptionsRead, SubscriptionsManage]);
    Router::new()
        .route("/api/v1/me/subscriptions", permit(Method::GET, list, read))
        .route(
            "/api/v1/me/subscriptions",
            permit(Method::POST, create, manage),
        )
        .route(
            "/api/v1/me/subscriptions/provision",
            permit(Method::POST, provision, manage),
        )
        .route(
            "/api/v1/me/subscriptions/{id}",
            permit(Method::DELETE, remove, manage),
        )
        .route(
            "/api/v1/me/subscriptions/{id}",
            permit(Method::PATCH, rename, manage),
        )
        .route(
            "/api/v1/me/subscriptions/remove",
            permit(Method::POST, remove_many, manage),
        )
        .route(
            "/api/v1/me/subscription-devices",
            permit(Method::GET, list_devices, read),
        )
        .route(
            "/api/v1/me/subscription-devices/{id}",
            permit(Method::DELETE, remove_device, manage),
        )
        .route("/api/v1/me/nodes", permit(Method::GET, list_nodes, read))
}

async fn list(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<Json<Snapshot>> {
    let tx = app
        .db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let quota = policy::read(&tx, session.account.id).await?;
    let effective_link_limits = quota.link_limits.resolve(&session.access);
    let route = &app.settings.subscription_route;
    let links = links::list(&tx, session.account.id, route, effective_link_limits).await?;
    let (endpoints, requires_proxy) = subscriptions::availability(
        &tx,
        session.account.id,
        session.account.access_id,
        session.account.admin,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(Snapshot {
        links,
        effective_link_limits,
        endpoints,
        requires_proxy,
        quota,
    }))
}

async fn provision(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<Json<Vec<links::View>>> {
    let links = links::provision_for_session(&app.db, &session, &app.settings.subscription_route).await?;
    Ok(Json(links))
}

async fn create(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<links::NewLink>,
) -> Result<(StatusCode, Json<links::View>)> {
    let link = links::create(&app.db, &session, &app.settings.subscription_route, input).await?;
    Ok((StatusCode::CREATED, Json(link)))
}

async fn remove(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    links::remove(&app.db, &session, vec![id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn rename(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<LinkName>,
) -> Result<StatusCode> {
    links::rename(&app.db, &session, id, &input.name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_many(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(ids): Json<Ids>,
) -> Result<StatusCode> {
    links::remove(&app.db, &session, ids.ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_devices(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<Json<Devices>> {
    Ok(Json(Devices {
        active_for_days: devices::BINDING_DAYS,
        items: devices::list(&app.db, session.account.id).await?,
    }))
}

async fn remove_device(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    devices::remove(&app.db, &session, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_nodes(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<Json<Vec<subscriptions::SubscriberNode>>> {
    Ok(Json(
        subscriptions::published_nodes(
            &app.db,
            session.account.id,
            session.account.access_id,
            session.account.admin,
        )
        .await?,
    ))
}
