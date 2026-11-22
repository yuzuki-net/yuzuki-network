use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::MethodFilter as Method,
};
use sea_orm::{ConnectionTrait, DatabaseBackend, EntityTrait, Statement};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::permit;
use crate::{
    app::State as App,
    infra::{
        error::{Error, Result},
        postgres::entities::account,
    },
    services::{
        access::{Permission, Rules::Require, permissions_for},
        auth::Session,
        quotas::policy::{self, GrantInput, LinkLimits, PolicyInput, QuotaPlan, QuotaPlanInput, Status},
        subscriptions::devices,
    },
};

#[derive(Serialize)]
struct View {
    #[serde(flatten)]
    status: Status,
    active_devices: i64,
    effective_link_limits: [i32; 4],
    inherited_link_limits: [i32; 4],
    can_edit: bool,
}

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/api/v1/me/quota", axum::routing::get(personal))
        .route(
            "/api/v1/me/usage/heatmap",
            axum::routing::get(personal_usage_heatmap),
        )
        .route(
            "/api/v1/admin/quota-plans",
            permit(Method::GET, list_plans, Require(&[Permission::QuotasRead])),
        )
        .route(
            "/api/v1/admin/quota-plans",
            permit(Method::POST, create_plan, Require(&[Permission::QuotasManage])),
        )
        .route(
            "/api/v1/admin/quota-plans/{id}",
            permit(Method::PUT, update_plan, Require(&[Permission::QuotasManage])),
        )
        .route(
            "/api/v1/admin/quota-plans/{id}",
            permit(Method::DELETE, delete_plan, Require(&[Permission::QuotasManage])),
        )
        .route(
            "/api/v1/admin/quotas/{id}/policy",
            permit(Method::GET, account, Require(&[Permission::QuotasRead])),
        )
        .route(
            "/api/v1/admin/quotas/{id}/policy",
            permit(Method::PUT, edit, Require(&[Permission::QuotasManage])),
        )
        .route(
            "/api/v1/admin/quotas/{id}/grants",
            permit(Method::POST, issue_grant, Require(&[Permission::QuotasManage])),
        )
        .route(
            "/api/v1/admin/quotas/{id}/grants/{grant_id}",
            permit(Method::DELETE, revoke_grant, Require(&[Permission::QuotasManage])),
        )
        .route(
            "/api/v1/admin/quotas/{id}/grants/{grant_id}/reset",
            permit(Method::POST, reset_grant, Require(&[Permission::QuotasManage])),
        )
}

#[derive(Deserialize)]
struct HeatmapQuery {
    days: Option<i32>,
}

#[derive(Serialize)]
struct UsageHeatmapDay {
    date: String,
    uploaded: String,
    downloaded: String,
    billed_bytes: String,
}

#[derive(Serialize)]
struct UsageHeatmapPeak {
    date: String,
    billed_bytes: String,
}

#[derive(Serialize)]
struct UsageHeatmapView {
    window_days: i32,
    days: Vec<UsageHeatmapDay>,
    total_uploaded: String,
    total_downloaded: String,
    total_billed: String,
    active_days: usize,
    peak_day: Option<UsageHeatmapPeak>,
}

async fn personal_usage_heatmap(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Query(query): Query<HeatmapQuery>,
) -> Result<Json<UsageHeatmapView>> {
    let window_days = query.days.unwrap_or(365).clamp(30, 365);
    let rows = app
        .db
        .query_all(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT to_char((received_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
                    COALESCE(SUM(uploaded), 0)::bigint AS uploaded,
                    COALESCE(SUM(downloaded), 0)::bigint AS downloaded,
                    COALESCE(SUM(billed_bytes), 0)::bigint AS billed_bytes
             FROM usage_events
             WHERE account_id = $1
               AND received_at >= ((date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - make_interval(days => $2))
             GROUP BY 1
             ORDER BY 1 ASC",
            [session.account.id.into(), (window_days - 1).into()],
        ))
        .await?;

    let mut days = Vec::with_capacity(rows.len());
    let mut total_uploaded: i128 = 0;
    let mut total_downloaded: i128 = 0;
    let mut total_billed: i128 = 0;
    let mut active_days = 0usize;
    let mut peak: Option<(String, i64)> = None;

    for row in rows {
        let date: String = row.try_get("", "day")?;
        let uploaded: i64 = row.try_get("", "uploaded")?;
        let downloaded: i64 = row.try_get("", "downloaded")?;
        let billed: i64 = row.try_get("", "billed_bytes")?;
        total_uploaded += i128::from(uploaded.max(0));
        total_downloaded += i128::from(downloaded.max(0));
        total_billed += i128::from(billed.max(0));
        if billed > 0 || uploaded > 0 || downloaded > 0 {
            active_days += 1;
        }
        if billed > 0 && peak.as_ref().is_none_or(|(_, best)| billed > *best) {
            peak = Some((date.clone(), billed));
        }
        days.push(UsageHeatmapDay {
            date,
            uploaded: uploaded.to_string(),
            downloaded: downloaded.to_string(),
            billed_bytes: billed.to_string(),
        });
    }

    Ok(Json(UsageHeatmapView {
        window_days,
        days,
        total_uploaded: total_uploaded.to_string(),
        total_downloaded: total_downloaded.to_string(),
        total_billed: total_billed.to_string(),
        active_days,
        peak_day: peak.map(|(date, billed)| UsageHeatmapPeak {
            date,
            billed_bytes: billed.to_string(),
        }),
    }))
}

async fn personal(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Result<Json<View>> {
    let id = session.account.id;
    let status = policy::read(&app.db, id).await?;
    Ok(Json(View {
        effective_link_limits: status.link_limits.resolve(&session.access),
        inherited_link_limits: LinkLimits::default().resolve(&session.access),
        status,
        active_devices: devices::count(&app.db, id).await?,
        can_edit: false,
    }))
}

async fn list_plans(State(app): State<App>) -> Result<Json<Vec<QuotaPlan>>> {
    Ok(Json(policy::list_plans(&app.db).await?))
}

async fn create_plan(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<QuotaPlanInput>,
) -> Result<(StatusCode, Json<QuotaPlan>)> {
    let plan = policy::save_plan(&app.db, session.account.id, None, input).await?;
    Ok((StatusCode::CREATED, Json(plan)))
}

async fn update_plan(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<QuotaPlanInput>,
) -> Result<Json<QuotaPlan>> {
    Ok(Json(
        policy::save_plan(&app.db, session.account.id, Some(id), input).await?,
    ))
}

async fn delete_plan(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    policy::delete_plan(&app.db, session.account.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn account(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<Json<View>> {
    let target = account::Entity::find_by_id(id)
        .one(&app.db)
        .await?
        .ok_or(Error::NotFound)?;
    let access = permissions_for(&app.db, &target).await?;
    let status = policy::read(&app.db, id).await?;
    Ok(Json(View {
        effective_link_limits: status.link_limits.resolve(&access),
        inherited_link_limits: LinkLimits::default().resolve(&access),
        status,
        active_devices: devices::count(&app.db, id).await?,
        can_edit: session.access.allows(Permission::QuotasManage)
            && session.access.can_manage(&access),
    }))
}

async fn edit(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<PolicyInput>,
) -> Result<Json<Status>> {
    Ok(Json(
        policy::update(&app.db, session.account.id, id, input).await?,
    ))
}

async fn issue_grant(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<GrantInput>,
) -> Result<(StatusCode, Json<Status>)> {
    let status = policy::issue_grant(&app.db, session.account.id, id, input).await?;
    Ok((StatusCode::CREATED, Json(status)))
}

async fn revoke_grant(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path((id, grant_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Status>> {
    Ok(Json(
        policy::revoke_grant(&app.db, session.account.id, id, grant_id).await?,
    ))
}

async fn reset_grant(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path((id, grant_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Status>> {
    Ok(Json(
        policy::reset_grant_usage(&app.db, session.account.id, id, grant_id).await?,
    ))
}
