use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseBackend, QueryResult, Statement, Value};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{Access, Permission, Role, RoleSummary};
use crate::infra::{
    error::{Error, Result, problem},
    postgres::entities::account,
};
use crate::services::quotas::policy::LinkLimits;

pub const ADMIN_ROLE: Uuid = Uuid::from_u128(0x00000000_0000_4000_8000_000000000000);
pub const MEMBER: Uuid = Uuid::from_u128(0x00000000_0000_4000_8000_000000000001);

pub fn sql(text: &str, values: impl IntoIterator<Item = Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, text, values)
}

pub async fn add_default_role(db: &impl ConnectionTrait, id: Uuid) -> Result<()> {
    db.execute(sql(
        "INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [id.into(), MEMBER.into()],
    ))
    .await?;
    Ok(())
}

pub async fn add_admin_role(db: &impl ConnectionTrait, id: Uuid) -> Result<()> {
    db.execute(sql(
        "INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [id.into(), ADMIN_ROLE.into()],
    ))
    .await?;
    Ok(())
}

pub async fn remove_admin_role(db: &impl ConnectionTrait, id: Uuid) -> Result<()> {
    db.execute(sql(
        "DELETE FROM account_roles WHERE account_id = $1 AND role_id = $2",
        [id.into(), ADMIN_ROLE.into()],
    ))
    .await?;
    Ok(())
}

pub async fn permissions_for(
    db: &impl ConnectionTrait,
    account: &account::Model,
) -> Result<Access> {
    let mut roles = collect_roles(
        db.query_all(sql(
            "SELECT r.*, qp.name AS default_quota_plan_name, p.permission,
                    (SELECT count(*) FROM account_roles ar2 WHERE ar2.role_id = r.id) AS member_count
             FROM account_roles ar
             JOIN roles r ON r.id = ar.role_id
             LEFT JOIN quota_plans qp ON qp.id = r.default_quota_plan_id
             LEFT JOIN role_permissions p ON p.role_id = r.id
             WHERE ar.account_id = $1
             ORDER BY r.locked DESC, r.built_in DESC, r.name, r.id, p.permission",
            [account.id.into()],
        ))
        .await?,
    )?;

    if account.admin {
        // Ensure the locked built-in Administrator role is always present & visible
        // on every admin account (even if an account row was seeded directly).
        if !roles.iter().any(|r| r.id == ADMIN_ROLE) {
            let mut admin_roles = collect_roles(
                db.query_all(sql(
                    "SELECT r.*, qp.name AS default_quota_plan_name, p.permission,
                            (SELECT count(*) FROM account_roles ar2 WHERE ar2.role_id = r.id) AS member_count
                     FROM roles r
                     LEFT JOIN quota_plans qp ON qp.id = r.default_quota_plan_id
                     LEFT JOIN role_permissions p ON p.role_id = r.id
                     WHERE r.id = $1
                     ORDER BY p.permission",
                    [ADMIN_ROLE.into()],
                ))
                .await?,
            )?;
            if let Some(mut admin_role) = admin_roles.pop() {
                admin_role.permissions = Permission::ALL.iter().copied().collect();
                roles.insert(0, admin_role);
            }
        } else if let Some(admin_role) = roles.iter_mut().find(|r| r.id == ADMIN_ROLE) {
            admin_role.permissions = Permission::ALL.iter().copied().collect();
        }
        return Ok(Access {
            owner: true,
            roles,
            permissions: Permission::ALL.iter().copied().collect(),
            overrides: BTreeMap::new(),
        });
    }

    let mut overrides = BTreeMap::new();
    for row in db
        .query_all(sql(
            "SELECT permission, allowed FROM account_permissions WHERE account_id = $1",
            [account.id.into()],
        ))
        .await?
    {
        let key: String = row.try_get("", "permission")?;
        if let Some(point) = Permission::parse(&key) {
            overrides.insert(point, row.try_get("", "allowed")?);
        }
    }
    let mut permissions: BTreeSet<_> = roles
        .iter()
        .flat_map(|role| role.permissions.iter().copied())
        .collect();
    for (&point, &allowed) in &overrides {
        if allowed {
            permissions.insert(point);
        } else {
            permissions.remove(&point);
        }
    }
    Ok(Access {
        owner: false,
        roles,
        permissions,
        overrides,
    })
}

pub async fn roles_for_accounts(
    db: &impl ConnectionTrait,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<RoleSummary>>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = db
        .query_all(sql(
            "SELECT a.id AS account_id, r.id AS role_id, r.name, r.built_in, r.locked
             FROM accounts a
             JOIN jsonb_array_elements_text($1::jsonb) AS wanted(id) ON a.id = wanted.id::uuid
             JOIN account_roles ar ON ar.account_id = a.id
             JOIN roles r ON r.id = ar.role_id
             ORDER BY a.id, r.locked DESC, r.built_in DESC, r.name, r.id",
            [serde_json::json!(ids).into()],
        ))
        .await?;
    let mut map: HashMap<Uuid, Vec<RoleSummary>> = HashMap::new();
    for row in rows {
        let account_id: Uuid = row.try_get("", "account_id")?;
        map.entry(account_id).or_default().push(RoleSummary {
            id: row.try_get("", "role_id")?,
            name: row.try_get("", "name")?,
            built_in: row.try_get("", "built_in")?,
            locked: row.try_get("", "locked")?,
        });
    }
    Ok(map)
}

pub fn collect_roles(rows: Vec<QueryResult>) -> Result<Vec<Role>> {
    let mut roles = Vec::<Role>::new();
    for row in rows {
        let id: Uuid = row.try_get("", "id")?;
        if roles.last().is_none_or(|role| role.id != id) {
            let locked: bool = row.try_get("", "locked")?;
            let member_count: i64 = row.try_get("", "member_count").unwrap_or(0);
            roles.push(Role {
                id,
                name: row.try_get("", "name")?,
                description: row.try_get("", "description")?,
                built_in: row.try_get("", "built_in")?,
                locked,
                member_count,
                permissions: if locked {
                    Permission::ALL.iter().copied().collect()
                } else {
                    BTreeSet::new()
                },
                default_quota_plan_id: row.try_get("", "default_quota_plan_id")?,
                default_quota_plan_name: row.try_get("", "default_quota_plan_name").unwrap_or(None),
                link_limits: LinkLimits::from_row(&row)?,
            });
        }
        let key: Option<String> = row.try_get("", "permission")?;
        if let Some(point) = key.as_deref().and_then(Permission::parse) {
            roles
                .last_mut()
                .expect("role row is initialized")
                .permissions
                .insert(point);
        }
    }
    Ok(roles)
}

/// Derive all entitled account `access_id`s for a specific backend proxy node.
/// Accounts qualify if they are active, quota-eligible, have `subscriptions.read`,
/// AND (are admin OR the node/any active relay child is visible to 'all' OR they
/// hold a role granted access to the node or any active relay child).
pub async fn entitled_ids_for_node(
    db: &impl ConnectionTrait,
    node_id: Uuid,
) -> Result<Vec<String>> {
    let rows = db
        .query_all(sql(
            "WITH target_nodes AS (
                SELECT id, visibility FROM proxy_nodes
                WHERE deleted_at IS NULL AND (
                    id = $2
                    OR (parent_id = $2 AND mode = 'relay' AND enabled AND show)
                )
             )
             SELECT a.access_id::text AS access_id
             FROM accounts a
             JOIN account_quota_status q ON q.account_id = a.id
             WHERE q.eligible
               AND (a.admin OR COALESCE(
                    (SELECT ap.allowed FROM account_permissions ap WHERE ap.account_id = a.id AND ap.permission = $1),
                    EXISTS(SELECT 1 FROM account_roles ar JOIN role_permissions rp ON rp.role_id = ar.role_id
                           WHERE ar.account_id = a.id AND rp.permission = $1)
               ))
               AND (
                    a.admin
                    OR EXISTS (SELECT 1 FROM target_nodes tn WHERE tn.visibility = 'all')
                    OR EXISTS (
                        SELECT 1
                        FROM target_nodes tn
                        JOIN proxy_node_roles pnr ON pnr.node_id = tn.id
                        JOIN account_roles ar ON ar.role_id = pnr.role_id
                        WHERE ar.account_id = a.id
                    )
               )
             ORDER BY a.access_id",
            [Permission::SubscriptionsRead.key().into(), node_id.into()],
        ))
        .await?;
    rows.into_iter()
        .map(|row| row.try_get("", "access_id").map_err(Error::from))
        .collect()
}

pub async fn audit(
    db: &impl ConnectionTrait,
    actor: Uuid,
    action: &'static str,
    target: Uuid,
) -> Result<()> {
    audit_subject(db, actor, action, target, None).await
}

pub async fn audit_subject(
    db: &impl ConnectionTrait,
    actor: Uuid,
    action: &'static str,
    target: Uuid,
    label: Option<&str>,
) -> Result<()> {
    db.execute(sql(
        "INSERT INTO access_audit (actor_id, action, target, target_label) VALUES ($1, $2, $3, $4)",
        [
            actor.into(),
            action.into(),
            target.to_string().into(),
            label.into(),
        ],
    ))
    .await?;
    Ok(())
}

#[derive(Serialize)]
pub struct AuditEntry {
    pub id: i64,
    pub actor: String,
    pub action: String,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_label: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditKind {
    Accounts,
    Permissions,
    Quotas,
    Sessions,
    Portal,
    Infrastructure,
}

pub async fn audit_entries(
    db: &impl ConnectionTrait,
    before: Option<i64>,
    query: Option<&str>,
    kind: Option<AuditKind>,
    can_read_announcements: bool,
) -> Result<Vec<AuditEntry>> {
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    if query.is_some_and(|value| value.chars().count() > 120) {
        return Err(Error::BadRequest(problem::AUDIT_SEARCH));
    }
    let kind = kind.map(|kind| match kind {
        AuditKind::Accounts => "accounts",
        AuditKind::Permissions => "permissions",
        AuditKind::Quotas => "quotas",
        AuditKind::Sessions => "sessions",
        AuditKind::Portal => "portal",
        AuditKind::Infrastructure => "infrastructure",
    });
    let rows = db.query_all(sql(
        "WITH matching_actors AS (
            SELECT id FROM accounts WHERE position(lower($2::text) in lower(email)) > 0
         ), page AS (
            SELECT log.id, log.actor_id, log.action, log.target, log.occurred_at,
                CASE WHEN $4::boolean OR log.action LIKE 'server.%' OR log.action LIKE 'node.%' THEN log.target_label END AS target_label
            FROM access_audit log
            WHERE ($1::bigint IS NULL OR log.id < $1)
              AND ($2::text IS NULL OR log.actor_id IN (SELECT id FROM matching_actors)
                              OR position(lower($2) in lower(log.target)) > 0
                              OR (($4 OR log.action LIKE 'server.%' OR log.action LIKE 'node.%')
                                  AND position(lower($2) in lower(log.target_label)) > 0))
              AND CASE $3::text
                  WHEN 'permissions' THEN log.action LIKE 'role.%' OR log.action = 'account.access_updated'
                  WHEN 'quotas' THEN log.action = 'account.quota_updated'
                  WHEN 'sessions' THEN log.action LIKE 'session.%'
                  WHEN 'portal' THEN log.action LIKE 'announcement.%' OR log.action LIKE 'panel.%'
                  WHEN 'infrastructure' THEN log.action LIKE 'server.%' OR log.action LIKE 'node.%'
                  WHEN 'accounts' THEN log.action LIKE 'account.%' AND log.action NOT IN
                       ('account.access_updated', 'account.quota_updated')
                  ELSE true
                  END
            ORDER BY log.id DESC LIMIT 50
         )
         SELECT page.id, a.email AS actor, page.action, page.target, page.occurred_at, page.target_label
         FROM page JOIN accounts a ON a.id=page.actor_id ORDER BY page.id DESC",
        [before.into(), query.into(), kind.into(), can_read_announcements.into()],
    )).await?;
    rows.into_iter()
        .map(|row| {
            Ok(AuditEntry {
                id: row.try_get("", "id")?,
                actor: row.try_get("", "actor")?,
                action: row.try_get("", "action")?,
                target: row.try_get("", "target")?,
                target_label: row.try_get("", "target_label")?,
                occurred_at: row.try_get("", "occurred_at")?,
            })
        })
        .collect()
}
