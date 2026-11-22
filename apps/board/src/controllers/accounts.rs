use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use sea_orm::EntityTrait;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    app::State as App,
    controllers::auth::Credentials,
    infra::{
        error::{Error, Result},
        postgres::entities::account,
    },
    services::{
        access::{self, Permission},
        accounts::{
            self,
            management::{self, DirectoryQuery, Profile, Update},
        },
        auth::Session,
        quotas::policy,
    },
    views::json::Account,
};

pub async fn directory(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Query(query): Query<DirectoryQuery>,
) -> Result<Json<Value>> {
    let read_quota = session.access.allows(Permission::QuotasRead);
    let (rows, count) = management::directory(&app.db, query).await?;
    let ids: Vec<_> = rows.iter().map(|row| row.id).collect();
    let edit_status = session.access.allows(Permission::UsersUpdate);
    let edit_quota = read_quota && session.access.allows(Permission::QuotasManage);
    let manageable = if edit_status || edit_quota {
        management::manageable_accounts(&app.db, &session.access, &ids).await?
    } else {
        Default::default()
    };
    let mut quota = if read_quota {
        policy::summaries(&app.db, &ids).await?
    } else {
        Default::default()
    };
    let mut roles = access::roles_for_accounts(&app.db, &ids).await?;
    let items: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let details = quota.remove(&row.id);
            let account_roles = roles.remove(&row.id).unwrap_or_default();
            let within_scope = manageable.contains(&row.id);
            let can_change_status =
                edit_status && within_scope && row.id != session.account.id && !row.admin;
            Account::directory(row, read_quota)
                .with_roles(Some(account_roles))
                .with_quota(details)
                .with_directory_actions(can_change_status, edit_quota && within_scope)
        })
        .collect();
    Ok(Json(json!({"items":items,"total":count,"page_size":25})))
}

pub async fn user(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let row = account::Entity::find_by_id(id)
        .one(&app.db)
        .await?
        .ok_or(Error::NotFound)?;
    let subject = access::permissions_for(&app.db, &row).await?;
    let editable = session.access.can_manage(&subject);
    let other = session.account.id != id && !row.admin;
    let allows = |permission| session.access.allows(permission);
    let quota = if allows(Permission::QuotasRead) {
        Some(policy::read(&app.db, id).await?)
    } else {
        None
    };
    let role_summaries: Vec<_> = subject
        .roles
        .iter()
        .map(|r| access::RoleSummary {
            id: r.id,
            name: r.name.clone(),
            built_in: r.built_in,
            locked: r.locked,
        })
        .collect();
    Ok(Json(json!({
        "account": Account::directory(row, allows(Permission::QuotasRead))
            .with_roles(Some(role_summaries))
            .with_quota(quota),
        "actions": {
            "profile": editable && allows(Permission::UsersUpdate),
            "status": editable && other && allows(Permission::UsersUpdate),
            "credentials": editable && other && allows(Permission::UsersCredentials),
            "access": editable && other && allows(Permission::RolesAssign),
            "quota": editable && allows(Permission::QuotasManage),
        }
    })))
}

pub async fn create_user(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Json(input): Json<Credentials>,
) -> Result<(StatusCode, Json<Account>)> {
    let user = accounts::create_managed(
        &app.db,
        &app.auth,
        input.email,
        input.password,
        session.account.id,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(user.into())))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusInput {
    active: bool,
}

pub async fn profile(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<Profile>,
) -> Result<Json<Account>> {
    update_account(app, session, id, Update::Profile(input)).await
}

pub async fn status(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<StatusInput>,
) -> Result<Json<Account>> {
    update_account(app, session, id, Update::Enabled(input.active)).await
}

async fn update_account(
    app: App,
    session: Session,
    id: Uuid,
    update: Update,
) -> Result<Json<Account>> {
    let updated = management::update(&app.db, session.account.id, id, update).await?;
    Ok(Json(Account::directory(
        updated,
        session.access.allows(Permission::QuotasRead),
    )))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetInput {
    password: String,
}

pub async fn reset(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<ResetInput>,
) -> Result<StatusCode> {
    management::reset_credentials(
        &app.db,
        &app.auth,
        session.account.id,
        id,
        Some(input.password),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn revoke_sessions(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    management::reset_credentials(&app.db, &app.auth, session.account.id, id, None).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn account_access(
    State(app): State<App>,
    Path(id): Path<Uuid>,
) -> Result<Json<access::Access>> {
    let account = account::Entity::find_by_id(id)
        .one(&app.db)
        .await?
        .ok_or(Error::NotFound)?;
    Ok(Json(access::permissions_for(&app.db, &account).await?))
}

pub async fn assign(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<Uuid>,
    Json(input): Json<access::Assignment>,
) -> Result<Json<access::Access>> {
    Ok(Json(
        access::update_assignment(&app.db, session.account.id, id, input).await?,
    ))
}
