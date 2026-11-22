use std::collections::{BTreeMap, BTreeSet};

use sea_orm::{ConnectionTrait, DatabaseConnection, SqlErr, TransactionTrait};
use serde::Deserialize;
use uuid::Uuid;

use super::{
    Access, Permission, Role, actor, audit, begin_change,
    repository::{ADMIN_ROLE, collect_roles, sql},
    subject,
};
use crate::infra::error::{Error, Result, problem};
use crate::services::quotas::policy::{self, LinkLimits};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleInput {
    pub name: String,
    pub description: String,
    pub permissions: BTreeSet<Permission>,
    #[serde(default)]
    pub default_quota_plan_id: Option<Uuid>,
    #[serde(default)]
    pub link_limits: Option<LinkLimits>,
}

pub async fn roles(db: &impl ConnectionTrait) -> Result<Vec<Role>> {
    roles_matching(db, None).await
}

async fn roles_matching(db: &impl ConnectionTrait, id: Option<Uuid>) -> Result<Vec<Role>> {
    collect_roles(
        db.query_all(sql(
            "SELECT r.*, qp.name AS default_quota_plan_name, p.permission,
                    (SELECT count(*) FROM account_roles ar WHERE ar.role_id = r.id) AS member_count
             FROM roles r
             LEFT JOIN quota_plans qp ON qp.id = r.default_quota_plan_id
             LEFT JOIN role_permissions p ON r.id = p.role_id
             WHERE ($1::uuid IS NULL OR r.id = $1)
             ORDER BY r.locked DESC, r.built_in DESC, r.name, r.id, p.permission",
            [id.into()],
        ))
        .await?,
    )
}

fn may_delegate(actor: &Access, points: impl IntoIterator<Item = Permission>) -> Result<()> {
    if points.into_iter().any(|point| !actor.allows(point)) {
        return Err(Error::NotFound);
    }
    Ok(())
}

pub async fn update_role(
    db: &DatabaseConnection,
    who: Uuid,
    id: Option<Uuid>,
    input: RoleInput,
) -> Result<Role> {
    let raw_name = input.name.trim();
    let description = input.description.trim();
    if raw_name.is_empty()
        || raw_name.chars().count() > 72
        || description.chars().count() > 400
        || raw_name.chars().any(char::is_control)
        || raw_name.eq_ignore_ascii_case("Owner")
        || raw_name.eq_ignore_ascii_case("Administrator")
    {
        return Err(Error::BadRequest(problem::ROLE_FIELDS));
    }

    let tx = db.begin().await?;
    begin_change(&tx).await?;
    let actor = actor(&tx, who, &[Permission::RolesManage]).await?;
    may_delegate(&actor, input.permissions.iter().copied())?;
    let role_id = id.unwrap_or_else(Uuid::new_v4);

    let (existing, name, built_in) = if id.is_some() {
        let current = roles_matching(&tx, Some(role_id))
            .await?
            .pop()
            .ok_or(Error::NotFound)?;
        if current.locked {
            return Err(Error::Conflict(problem::ROLE_LOCKED));
        }
        may_delegate(&actor, current.permissions.iter().copied())?;
        let effective_name = if current.built_in {
            current.name.clone()
        } else {
            raw_name.to_string()
        };
        let is_built_in = current.built_in;
        (Some(current), effective_name, is_built_in)
    } else {
        (None, raw_name.to_string(), false)
    };

    if let Some(plan_id) = input.default_quota_plan_id
        && policy::get_plan(&tx, plan_id).await?.is_none()
    {
        return Err(Error::NotFound);
    }

    let previous_limits = existing.as_ref().map(|r| r.link_limits).unwrap_or_default();
    let link_limits = input.link_limits.unwrap_or(previous_limits).validate()?;

    if existing.is_some() {
        tx.execute(sql(
            "UPDATE roles
             SET name = $2, description = $3,
                 default_quota_plan_id = $4,
                 max_links_xray = $5, max_links_sing_box = $6,
                 max_links_mihomo = $7, max_links_universal = $8
             WHERE id = $1",
            [
                role_id.into(),
                name.into(),
                description.into(),
                input.default_quota_plan_id.into(),
                link_limits.xray.into(),
                link_limits.sing_box.into(),
                link_limits.mihomo.into(),
                link_limits.universal.into(),
            ],
        ))
        .await
        .map_err(duplicate)?;
    } else {
        let count: i64 = tx
            .query_one(sql("SELECT count(*) AS count FROM roles", []))
            .await?
            .ok_or(Error::NotFound)?
            .try_get("", "count")?;
        if count >= 128 {
            return Err(Error::Conflict(problem::ROLE_LIMIT));
        }
        tx.execute(sql(
            "INSERT INTO roles (
                 id, name, description, built_in, locked,
                 default_quota_plan_id,
                 max_links_xray, max_links_sing_box, max_links_mihomo, max_links_universal
             ) VALUES ($1,$2,$3,$4,false,$5,$6,$7,$8,$9)",
            [
                role_id.into(),
                name.into(),
                description.into(),
                built_in.into(),
                input.default_quota_plan_id.into(),
                link_limits.xray.into(),
                link_limits.sing_box.into(),
                link_limits.mihomo.into(),
                link_limits.universal.into(),
            ],
        ))
        .await
        .map_err(duplicate)?;
    }

    tx.execute(sql(
        "DELETE FROM role_permissions WHERE role_id = $1",
        [role_id.into()],
    ))
    .await?;
    for point in &input.permissions {
        tx.execute(sql(
            "INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)",
            [role_id.into(), point.key().into()],
        ))
        .await?;
    }
    audit(
        &tx,
        who,
        if existing.is_some() {
            "role.updated"
        } else {
            "role.created"
        },
        role_id,
    )
    .await?;
    let role = roles_matching(&tx, Some(role_id))
        .await?
        .pop()
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(role)
}

pub async fn remove_role(db: &DatabaseConnection, who: Uuid, id: Uuid) -> Result<()> {
    let tx = db.begin().await?;
    begin_change(&tx).await?;
    let actor = actor(&tx, who, &[Permission::RolesManage]).await?;
    let role = roles_matching(&tx, Some(id))
        .await?
        .pop()
        .ok_or(Error::NotFound)?;
    if role.locked {
        return Err(Error::Conflict(problem::ROLE_LOCKED));
    }
    if role.built_in {
        return Err(Error::NotFound);
    }
    may_delegate(&actor, role.permissions.iter().copied())?;
    let members: i64 = tx
        .query_one(sql(
            "SELECT count(*) AS count FROM account_roles WHERE role_id = $1",
            [id.into()],
        ))
        .await?
        .ok_or(Error::NotFound)?
        .try_get("", "count")?;
    if members > 0 {
        return Err(Error::Conflict(problem::ROLE_ASSIGNED));
    }
    tx.execute(sql("DELETE FROM roles WHERE id = $1", [id.into()]))
        .await?;
    audit(&tx, who, "role.deleted", id).await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    pub roles: BTreeSet<Uuid>,
    pub overrides: BTreeMap<Permission, bool>,
}

pub async fn update_assignment(
    db: &DatabaseConnection,
    who: Uuid,
    target: Uuid,
    input: Assignment,
) -> Result<Access> {
    let tx = db.begin().await?;
    begin_change(&tx).await?;
    let actor = actor(&tx, who, &[Permission::RolesAssign]).await?;
    if who == target {
        return Err(Error::NotFound);
    }
    let (account, current) = subject(&tx, &actor, target).await?;
    if account.admin {
        return Err(Error::Conflict(problem::ROLE_LOCKED));
    }
    if input.roles.contains(&ADMIN_ROLE) {
        return Err(Error::Conflict(problem::ROLE_LOCKED));
    }
    let catalog: BTreeMap<_, _> = roles(&tx)
        .await?
        .into_iter()
        .map(|role| (role.id, role))
        .collect();
    for id in &input.roles {
        let role = catalog.get(id).ok_or(Error::NotFound)?;
        if role.locked {
            return Err(Error::Conflict(problem::ROLE_LOCKED));
        }
        may_delegate(&actor, role.permissions.iter().copied())?;
    }
    let old_roles: BTreeSet<_> = current.roles.iter().map(|role| role.id).collect();
    for removed in old_roles.difference(&input.roles) {
        if let Some(role) = catalog.get(removed) {
            may_delegate(&actor, role.permissions.iter().copied())?;
        }
    }
    let changed_overrides = current
        .overrides
        .keys()
        .chain(input.overrides.keys())
        .copied()
        .filter(|point| current.overrides.get(point) != input.overrides.get(point));
    may_delegate(&actor, changed_overrides)?;

    tx.execute(sql(
        "DELETE FROM account_roles WHERE account_id = $1",
        [account.id.into()],
    ))
    .await?;
    for id in &input.roles {
        tx.execute(sql(
            "INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2)",
            [account.id.into(), (*id).into()],
        ))
        .await?;
    }
    tx.execute(sql(
        "DELETE FROM account_permissions WHERE account_id = $1",
        [account.id.into()],
    ))
    .await?;
    for (&point, &allowed) in &input.overrides {
        tx.execute(sql(
            "INSERT INTO account_permissions (account_id, permission, allowed) VALUES ($1, $2, $3)",
            [account.id.into(), point.key().into(), allowed.into()],
        ))
        .await?;
    }
    audit(&tx, who, "account.access_updated", account.id).await?;
    let updated = super::permissions_for(&tx, &account).await?;
    tx.commit().await?;
    Ok(updated)
}

fn duplicate(error: sea_orm::DbErr) -> Error {
    match error.sql_err() {
        Some(SqlErr::UniqueConstraintViolation(_)) => Error::Conflict(problem::ROLE_DUPLICATE),
        _ => error.into(),
    }
}
