use std::collections::HashMap;

use chrono::{DateTime, Duration, Months, Utc};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, EntityTrait, QueryResult, QuerySelect, SqlErr,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    infra::{
        error::{Error, Result, problem},
        postgres::entities::account,
    },
    services::access::{self, Access, Permission, sql},
};

const DEFAULT_LINK_LIMIT: i32 = 1;
pub const UNLIMITED_PLAN_ID: Uuid = Uuid::from_u128(0x00000000_0000_4000_8000_000000000100);

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurationKind {
    #[default]
    Unlimited,
    Hours,
    Days,
    Months,
    Years,
}

impl DurationKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unlimited => "unlimited",
            Self::Hours => "hours",
            Self::Days => "days",
            Self::Months => "months",
            Self::Years => "years",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "hours" => Self::Hours,
            "days" => Self::Days,
            "months" => Self::Months,
            "years" => Self::Years,
            _ => Self::Unlimited,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    #[default]
    None,
    Cycle,
}

impl ResetMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Cycle => "cycle",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "cycle" => Self::Cycle,
            _ => Self::None,
        }
    }
}

/// Calendar-accurate duration advancement from a fixed anchor timestamp.
/// Preserves calendar day semantics across 28/29/30/31-day months and leap years:
/// e.g. Jan 31 + 1 month -> Feb 28/29; Jan 31 + 2 months -> Mar 31.
pub fn add_calendar_duration(
    anchor: DateTime<Utc>,
    kind: DurationKind,
    value: i32,
    cycles: i32,
) -> Option<DateTime<Utc>> {
    let total = i64::from(value).checked_mul(i64::from(cycles))?;
    match kind {
        DurationKind::Unlimited => None,
        DurationKind::Hours => anchor.checked_add_signed(Duration::hours(total)),
        DurationKind::Days => anchor.checked_add_signed(Duration::days(total)),
        DurationKind::Months => {
            let months = u32::try_from(total).ok()?;
            anchor.checked_add_months(Months::new(months))
        }
        DurationKind::Years => {
            let months = u32::try_from(total.checked_mul(12)?).ok()?;
            anchor.checked_add_months(Months::new(months))
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LinkLimits {
    pub xray: Option<i32>,
    pub sing_box: Option<i32>,
    pub mihomo: Option<i32>,
    #[serde(default)]
    pub universal: Option<i32>,
}

impl LinkLimits {
    pub fn slots(self) -> [Option<i32>; 4] {
        [self.xray, self.sing_box, self.mihomo, self.universal]
    }

    pub fn validate(self) -> Result<Self> {
        if self
            .slots()
            .into_iter()
            .flatten()
            .any(|value| !(0..=100).contains(&value))
        {
            return Err(Error::BadRequest(problem::QUOTA_LINK_RANGE));
        }
        Ok(self)
    }

    pub fn from_row(row: &QueryResult) -> Result<Self> {
        Ok(Self {
            xray: row.try_get("", "max_links_xray")?,
            sing_box: row.try_get("", "max_links_sing_box")?,
            mihomo: row.try_get("", "max_links_mihomo")?,
            universal: row.try_get("", "max_links_universal").unwrap_or(None),
        })
    }

    pub fn resolve(self, access: &Access) -> [i32; 4] {
        let slots = self.slots();
        std::array::from_fn(|index| {
            slots[index].unwrap_or_else(|| {
                access
                    .roles
                    .iter()
                    .filter_map(|role| role.link_limits.slots()[index])
                    .max()
                    .unwrap_or(DEFAULT_LINK_LIMIT)
            })
        })
    }
}

// ── Standalone Quota Plans ───────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct QuotaPlan {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub built_in: bool,
    pub quota_bytes: Option<String>,
    pub duration_kind: DurationKind,
    pub duration_value: Option<i32>,
    pub reset_mode: ResetMode,
    pub max_devices: Option<i32>,
    pub link_limits: LinkLimits,
    pub priority: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuotaPlanInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub quota_bytes: Option<String>,
    #[serde(default)]
    pub duration_kind: DurationKind,
    #[serde(default)]
    pub duration_value: Option<i32>,
    #[serde(default)]
    pub reset_mode: ResetMode,
    #[serde(default)]
    pub max_devices: Option<i32>,
    #[serde(default)]
    pub link_limits: LinkLimits,
    #[serde(default)]
    pub priority: i32,
}

fn parse_optional_bytes(raw: Option<&str>) -> Result<Option<i64>> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let bytes = raw
        .parse::<i64>()
        .map_err(|_| Error::BadRequest(problem::QUOTA_ALLOWANCE_BYTES))?;
    if bytes < 0 {
        return Err(Error::BadRequest(problem::QUOTA_ALLOWANCE_RANGE));
    }
    Ok(Some(bytes))
}

fn validate_duration(kind: DurationKind, value: Option<i32>, reset: ResetMode) -> Result<Option<i32>> {
    match kind {
        DurationKind::Unlimited => {
            if reset == ResetMode::Cycle {
                return Err(Error::BadRequest(problem::QUOTA_DURATION_INVALID));
            }
            Ok(None)
        }
        _ => {
            let v = value.ok_or(Error::BadRequest(problem::QUOTA_DURATION_INVALID))?;
            if !(1..=36500).contains(&v) {
                return Err(Error::BadRequest(problem::QUOTA_DURATION_INVALID));
            }
            Ok(Some(v))
        }
    }
}

fn validate_devices(max_devices: Option<i32>) -> Result<Option<i32>> {
    if let Some(d) = max_devices
        && !(0..=1000).contains(&d)
    {
        return Err(Error::BadRequest(problem::QUOTA_DEVICE_RANGE));
    }
    Ok(max_devices)
}

fn validate_plan_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(Error::BadRequest(problem::QUOTA_PLAN_NAME));
    }
    Ok(name.to_string())
}

fn plan_from_row(row: &QueryResult) -> Result<QuotaPlan> {
    let kind: String = row.try_get("", "duration_kind")?;
    let reset: String = row.try_get("", "reset_mode")?;
    Ok(QuotaPlan {
        id: row.try_get("", "id")?,
        name: row.try_get("", "name")?,
        description: row.try_get("", "description")?,
        built_in: row.try_get("", "built_in")?,
        quota_bytes: row
            .try_get::<Option<i64>>("", "quota_bytes")?
            .map(|n| n.to_string()),
        duration_kind: DurationKind::parse(&kind),
        duration_value: row.try_get("", "duration_value")?,
        reset_mode: ResetMode::parse(&reset),
        max_devices: row.try_get("", "max_devices")?,
        link_limits: LinkLimits::from_row(row)?,
        priority: row.try_get("", "priority")?,
        created_at: row.try_get("", "created_at")?,
    })
}

pub async fn list_plans(db: &impl ConnectionTrait) -> Result<Vec<QuotaPlan>> {
    let rows = db
        .query_all(sql(
            "SELECT * FROM quota_plans ORDER BY built_in DESC, priority DESC, name ASC, id ASC",
            [],
        ))
        .await?;
    rows.iter().map(plan_from_row).collect()
}

pub async fn get_plan(db: &impl ConnectionTrait, id: Uuid) -> Result<Option<QuotaPlan>> {
    let row = db
        .query_one(sql("SELECT * FROM quota_plans WHERE id = $1", [id.into()]))
        .await?;
    row.as_ref().map(plan_from_row).transpose()
}

pub async fn save_plan(
    db: &DatabaseConnection,
    actor_id: Uuid,
    id: Option<Uuid>,
    input: QuotaPlanInput,
) -> Result<QuotaPlan> {
    let name = validate_plan_name(&input.name)?;
    let description = input.description.trim();
    if description.chars().count() > 400 {
        return Err(Error::BadRequest(problem::ROLE_FIELDS));
    }
    let quota_bytes = parse_optional_bytes(input.quota_bytes.as_deref())?;
    let duration_value = validate_duration(input.duration_kind, input.duration_value, input.reset_mode)?;
    let max_devices = validate_devices(input.max_devices)?;
    let link_limits = input.link_limits.validate()?;

    let tx = db.begin().await?;
    let plan_id = id.unwrap_or_else(Uuid::new_v4);
    if let Some(existing_id) = id {
        let existing = get_plan(&tx, existing_id).await?.ok_or(Error::NotFound)?;
        let effective_name = if existing.built_in { existing.name } else { name };
        tx.execute(sql(
            "UPDATE quota_plans
             SET name = $2, description = $3, quota_bytes = $4, duration_kind = $5,
                 duration_value = $6, reset_mode = $7, max_devices = $8,
                 max_links_xray = $9, max_links_sing_box = $10, max_links_mihomo = $11,
                 max_links_universal = $12, priority = $13
             WHERE id = $1",
            [
                plan_id.into(),
                effective_name.into(),
                description.into(),
                quota_bytes.into(),
                input.duration_kind.as_str().into(),
                duration_value.into(),
                input.reset_mode.as_str().into(),
                max_devices.into(),
                link_limits.xray.into(),
                link_limits.sing_box.into(),
                link_limits.mihomo.into(),
                link_limits.universal.into(),
                input.priority.into(),
            ],
        ))
        .await
        .map_err(|err| match err.sql_err() {
            Some(SqlErr::UniqueConstraintViolation(_)) => {
                Error::Conflict(problem::QUOTA_PLAN_DUPLICATE)
            }
            _ => err.into(),
        })?;
        access::audit(&tx, actor_id, "quota_plan.updated", plan_id).await?;
    } else {
        tx.execute(sql(
            "INSERT INTO quota_plans (
                 id, name, description, built_in, quota_bytes, duration_kind,
                 duration_value, reset_mode, max_devices,
                 max_links_xray, max_links_sing_box, max_links_mihomo, max_links_universal, priority
             ) VALUES ($1,$2,$3,false,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
            [
                plan_id.into(),
                name.into(),
                description.into(),
                quota_bytes.into(),
                input.duration_kind.as_str().into(),
                duration_value.into(),
                input.reset_mode.as_str().into(),
                max_devices.into(),
                link_limits.xray.into(),
                link_limits.sing_box.into(),
                link_limits.mihomo.into(),
                link_limits.universal.into(),
                input.priority.into(),
            ],
        ))
        .await
        .map_err(|err| match err.sql_err() {
            Some(SqlErr::UniqueConstraintViolation(_)) => {
                Error::Conflict(problem::QUOTA_PLAN_DUPLICATE)
            }
            _ => err.into(),
        })?;
        access::audit(&tx, actor_id, "quota_plan.created", plan_id).await?;
    }
    let saved = get_plan(&tx, plan_id).await?.ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(saved)
}

pub async fn delete_plan(db: &DatabaseConnection, actor_id: Uuid, id: Uuid) -> Result<()> {
    let tx = db.begin().await?;
    let plan = get_plan(&tx, id).await?.ok_or(Error::NotFound)?;
    if plan.built_in {
        return Err(Error::Conflict(problem::QUOTA_PLAN_BUILT_IN));
    }
    tx.execute(sql("DELETE FROM quota_plans WHERE id = $1", [id.into()]))
        .await?;
    access::audit(&tx, actor_id, "quota_plan.deleted", id).await?;
    tx.commit().await?;
    Ok(())
}

// ── Account Quota Grants (Stackable Packages) ────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct QuotaGrant {
    pub id: Uuid,
    pub account_id: Uuid,
    pub plan_id: Option<Uuid>,
    pub name: String,
    pub quota_bytes: Option<String>,
    pub used_bytes: String,
    pub remaining_bytes: Option<String>,
    pub duration_kind: DurationKind,
    pub duration_value: Option<i32>,
    pub reset_mode: ResetMode,
    pub anchor_at: DateTime<Utc>,
    pub cycle_index: i32,
    pub starts_at: DateTime<Utc>,
    pub cycle_starts_at: DateTime<Utc>,
    pub cycle_ends_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub max_devices: Option<i32>,
    pub priority: i32,
    pub revoked: bool,
    pub state: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrantInput {
    #[serde(default)]
    pub plan_id: Option<Uuid>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub quota_bytes: Option<String>,
    #[serde(default)]
    pub duration_kind: Option<DurationKind>,
    #[serde(default)]
    pub duration_value: Option<i32>,
    #[serde(default)]
    pub reset_mode: Option<ResetMode>,
    #[serde(default)]
    pub starts_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub max_devices: Option<i32>,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub replace_existing: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyInput {
    #[serde(default)]
    pub max_devices: Option<i32>,
    #[serde(default)]
    pub link_limits: LinkLimits,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub quota_bytes: Option<String>,
    pub used_bytes: String,
    pub remaining_bytes: Option<String>,
    pub lifetime_used_bytes: String,
    pub eligible: bool,
    pub state: String,
    pub window_starts_at: Option<DateTime<Utc>>,
    pub window_ends_at: Option<DateTime<Utc>>,
    pub max_devices: Option<i32>,
    pub override_max_devices: Option<i32>,
    pub link_limits: LinkLimits,
    pub grants: Vec<QuotaGrant>,
}

#[derive(Clone)]
struct RawGrant {
    id: Uuid,
    account_id: Uuid,
    plan_id: Option<Uuid>,
    name: String,
    quota_bytes: Option<i64>,
    used_bytes: i64,
    duration_kind: DurationKind,
    duration_value: Option<i32>,
    reset_mode: ResetMode,
    anchor_at: DateTime<Utc>,
    cycle_index: i32,
    starts_at: DateTime<Utc>,
    cycle_starts_at: DateTime<Utc>,
    cycle_ends_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
    max_devices: Option<i32>,
    priority: i32,
    revoked: bool,
    created_at: DateTime<Utc>,
}

impl RawGrant {
    fn from_row(row: &QueryResult) -> Result<Self> {
        let kind: String = row.try_get("", "duration_kind")?;
        let reset: String = row.try_get("", "reset_mode")?;
        Ok(Self {
            id: row.try_get("", "id")?,
            account_id: row.try_get("", "account_id")?,
            plan_id: row.try_get("", "plan_id")?,
            name: row.try_get("", "name")?,
            quota_bytes: row.try_get("", "quota_bytes")?,
            used_bytes: row.try_get("", "used_bytes")?,
            duration_kind: DurationKind::parse(&kind),
            duration_value: row.try_get("", "duration_value")?,
            reset_mode: ResetMode::parse(&reset),
            anchor_at: row.try_get("", "anchor_at")?,
            cycle_index: row.try_get("", "cycle_index")?,
            starts_at: row.try_get("", "starts_at")?,
            cycle_starts_at: row.try_get("", "cycle_starts_at")?,
            cycle_ends_at: row.try_get("", "cycle_ends_at")?,
            expires_at: row.try_get("", "expires_at")?,
            max_devices: row.try_get("", "max_devices")?,
            priority: row.try_get("", "priority")?,
            revoked: row.try_get("", "revoked")?,
            created_at: row.try_get("", "created_at")?,
        })
    }

    /// Compute effective state & calendar-advanced cycle bounds at `now` without mutating DB.
    fn projected(&self, now: DateTime<Utc>) -> (Self, &'static str) {
        let mut g = self.clone();
        if g.revoked {
            return (g, "revoked");
        }
        if now < g.starts_at {
            return (g, "scheduled");
        }
        if let Some(exp) = g.expires_at
            && now >= exp
        {
            return (g, "expired");
        }
        if g.reset_mode == ResetMode::Cycle
            && let Some(val) = g.duration_value
            && g.duration_kind != DurationKind::Unlimited
        {
            // Advance calendar cycles cleanly from `anchor_at` without drift.
            let mut idx = g.cycle_index;
            let mut end = g
                .cycle_ends_at
                .or_else(|| add_calendar_duration(g.anchor_at, g.duration_kind, val, idx + 1));
            let mut advanced = false;
            while let Some(e) = end
                && now >= e
            {
                idx += 1;
                advanced = true;
                end = add_calendar_duration(g.anchor_at, g.duration_kind, val, idx + 1);
                if idx > 100_000 {
                    break;
                }
            }
            if advanced {
                g.cycle_index = idx;
                g.cycle_starts_at = add_calendar_duration(g.anchor_at, g.duration_kind, val, idx)
                    .unwrap_or(g.anchor_at);
                g.cycle_ends_at = end;
                g.used_bytes = 0;
            }
        }
        if let Some(limit) = g.quota_bytes
            && g.used_bytes >= limit
        {
            return (g, "exhausted");
        }
        (g, "active")
    }

    fn to_view(&self, now: DateTime<Utc>) -> (QuotaGrant, &'static str) {
        let (p, state) = self.projected(now);
        let remaining = p.quota_bytes.map(|limit| (limit - p.used_bytes).max(0));
        let view = QuotaGrant {
            id: p.id,
            account_id: p.account_id,
            plan_id: p.plan_id,
            name: p.name,
            quota_bytes: p.quota_bytes.map(|n| n.to_string()),
            used_bytes: p.used_bytes.to_string(),
            remaining_bytes: remaining.map(|n| n.to_string()),
            duration_kind: p.duration_kind,
            duration_value: p.duration_value,
            reset_mode: p.reset_mode,
            anchor_at: p.anchor_at,
            cycle_index: p.cycle_index,
            starts_at: p.starts_at,
            cycle_starts_at: p.cycle_starts_at,
            cycle_ends_at: p.cycle_ends_at,
            expires_at: p.expires_at,
            max_devices: p.max_devices,
            priority: p.priority,
            revoked: p.revoked,
            state: state.to_string(),
            created_at: p.created_at,
        };
        (view, state)
    }
}

pub async fn issue_from_plan(
    db: &impl ConnectionTrait,
    account_id: Uuid,
    plan: &QuotaPlan,
    starts_at: DateTime<Utc>,
) -> Result<QuotaGrant> {
    let quota_bytes = parse_optional_bytes(plan.quota_bytes.as_deref())?;
    let cycle_ends_at = plan
        .duration_value
        .and_then(|v| add_calendar_duration(starts_at, plan.duration_kind, v, 1));
    let expires_at = if plan.reset_mode == ResetMode::None {
        cycle_ends_at
    } else {
        None
    };
    let id = Uuid::new_v4();
    let row = db
        .query_one(sql(
            "INSERT INTO account_quotas (
                 id, account_id, plan_id, name, quota_bytes, used_bytes,
                 duration_kind, duration_value, reset_mode, anchor_at, cycle_index,
                 starts_at, cycle_starts_at, cycle_ends_at, expires_at,
                 max_devices, priority, revoked
             ) VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,0,$9,$9,$10,$11,$12,$13,false)
             RETURNING *",
            [
                id.into(),
                account_id.into(),
                Some(plan.id).into(),
                plan.name.clone().into(),
                quota_bytes.into(),
                plan.duration_kind.as_str().into(),
                plan.duration_value.into(),
                plan.reset_mode.as_str().into(),
                starts_at.into(),
                cycle_ends_at.into(),
                expires_at.into(),
                plan.max_devices.into(),
                plan.priority.into(),
            ],
        ))
        .await?
        .ok_or(Error::NotFound)?;
    Ok(RawGrant::from_row(&row)?.to_view(Utc::now()).0)
}

/// Issue the default quota grant from a role's configured `default_quota_plan_id`
/// (used when creating a new account).
pub async fn issue_default_for_role(
    db: &impl ConnectionTrait,
    account_id: Uuid,
    role_id: Uuid,
) -> Result<()> {
    let row = db
        .query_one(sql(
            "SELECT qp.*
             FROM roles r
             JOIN quota_plans qp ON qp.id = r.default_quota_plan_id
             WHERE r.id = $1",
            [role_id.into()],
        ))
        .await?;
    if let Some(row) = row {
        let plan = plan_from_row(&row)?;
        issue_from_plan(db, account_id, &plan, Utc::now()).await?;
    }
    Ok(())
}

pub async fn issue_grant(
    db: &DatabaseConnection,
    actor_id: Uuid,
    account_id: Uuid,
    input: GrantInput,
) -> Result<Status> {
    let tx = db.begin().await?;
    access::begin_change(&tx).await?;
    let actor = access::actor(&tx, actor_id, &[Permission::QuotasManage]).await?;
    let (target, _) = access::subject(&tx, &actor, account_id).await?;

    let plan = match input.plan_id {
        Some(pid) => Some(get_plan(&tx, pid).await?.ok_or(Error::NotFound)?),
        None => None,
    };

    let name = match input.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => validate_plan_name(n)?,
        None => plan
            .as_ref()
            .map(|p| p.name.clone())
            .unwrap_or_else(|| "Custom quota".to_string()),
    };

    let quota_bytes = if input.quota_bytes.is_some() {
        parse_optional_bytes(input.quota_bytes.as_deref())?
    } else if let Some(ref p) = plan {
        parse_optional_bytes(p.quota_bytes.as_deref())?
    } else {
        None
    };

    let duration_kind = input
        .duration_kind
        .or_else(|| plan.as_ref().map(|p| p.duration_kind))
        .unwrap_or(DurationKind::Unlimited);
    let duration_value_raw = input
        .duration_value
        .or_else(|| plan.as_ref().and_then(|p| p.duration_value));
    let reset_mode = input
        .reset_mode
        .or_else(|| plan.as_ref().map(|p| p.reset_mode))
        .unwrap_or(ResetMode::None);
    let duration_value = validate_duration(duration_kind, duration_value_raw, reset_mode)?;

    let max_devices = validate_devices(
        input
            .max_devices
            .or_else(|| plan.as_ref().and_then(|p| p.max_devices)),
    )?;
    let priority = input
        .priority
        .or_else(|| plan.as_ref().map(|p| p.priority))
        .unwrap_or(0);
    let starts_at = input.starts_at.unwrap_or_else(Utc::now);
    let year = starts_at.format("%Y").to_string().parse::<i32>().unwrap_or(0);
    if !(1970..=3000).contains(&year) {
        return Err(Error::BadRequest(problem::QUOTA_DATE_RANGE));
    }

    let cycle_ends_at =
        duration_value.and_then(|v| add_calendar_duration(starts_at, duration_kind, v, 1));
    let expires_at = if let Some(exp) = input.expires_at {
        Some(exp)
    } else if reset_mode == ResetMode::None {
        cycle_ends_at
    } else {
        None
    };

    if input.replace_existing {
        tx.execute(sql(
            "UPDATE account_quotas SET revoked = true WHERE account_id = $1 AND revoked = false",
            [target.id.into()],
        ))
        .await?;
    }

    let grant_id = Uuid::new_v4();
    tx.execute(sql(
        "INSERT INTO account_quotas (
             id, account_id, plan_id, name, quota_bytes, used_bytes,
             duration_kind, duration_value, reset_mode, anchor_at, cycle_index,
             starts_at, cycle_starts_at, cycle_ends_at, expires_at,
             max_devices, priority, revoked
         ) VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,0,$9,$9,$10,$11,$12,$13,false)",
        [
            grant_id.into(),
            target.id.into(),
            plan.as_ref().map(|p| p.id).into(),
            name.into(),
            quota_bytes.into(),
            duration_kind.as_str().into(),
            duration_value.into(),
            reset_mode.as_str().into(),
            starts_at.into(),
            cycle_ends_at.into(),
            expires_at.into(),
            max_devices.into(),
            priority.into(),
        ],
    ))
    .await?;

    access::audit(&tx, actor_id, "account.quota_updated", target.id).await?;
    let status = read(&tx, target.id).await?;
    tx.commit().await?;
    Ok(status)
}

pub async fn revoke_grant(
    db: &DatabaseConnection,
    actor_id: Uuid,
    account_id: Uuid,
    grant_id: Uuid,
) -> Result<Status> {
    let tx = db.begin().await?;
    access::begin_change(&tx).await?;
    let actor = access::actor(&tx, actor_id, &[Permission::QuotasManage]).await?;
    let (target, _) = access::subject(&tx, &actor, account_id).await?;
    let res = tx
        .execute(sql(
            "DELETE FROM account_quotas WHERE id = $1 AND account_id = $2",
            [grant_id.into(), target.id.into()],
        ))
        .await?;
    if res.rows_affected() == 0 {
        return Err(Error::NotFound);
    }
    access::audit(&tx, actor_id, "account.quota_updated", target.id).await?;
    let status = read(&tx, target.id).await?;
    tx.commit().await?;
    Ok(status)
}

pub async fn reset_grant_usage(
    db: &DatabaseConnection,
    actor_id: Uuid,
    account_id: Uuid,
    grant_id: Uuid,
) -> Result<Status> {
    let tx = db.begin().await?;
    access::begin_change(&tx).await?;
    let actor = access::actor(&tx, actor_id, &[Permission::QuotasManage]).await?;
    let (target, _) = access::subject(&tx, &actor, account_id).await?;
    let res = tx
        .execute(sql(
            "UPDATE account_quotas SET used_bytes = 0 WHERE id = $1 AND account_id = $2",
            [grant_id.into(), target.id.into()],
        ))
        .await?;
    if res.rows_affected() == 0 {
        return Err(Error::NotFound);
    }
    access::audit(&tx, actor_id, "account.quota_updated", target.id).await?;
    let status = read(&tx, target.id).await?;
    tx.commit().await?;
    Ok(status)
}

pub async fn read(db: &impl ConnectionTrait, id: Uuid) -> Result<Status> {
    let mut map = summaries(db, &[id]).await?;
    map.remove(&id).ok_or(Error::NotFound)
}

pub async fn summaries(db: &impl ConnectionTrait, ids: &[Uuid]) -> Result<HashMap<Uuid, Status>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let now = Utc::now();
    let json_ids = serde_json::json!(ids);

    let acc_rows = db
        .query_all(sql(
            "SELECT a.id, a.active, a.admin, a.used_bytes,
                    p.max_devices AS override_max_devices,
                    p.max_links_xray, p.max_links_sing_box, p.max_links_mihomo, p.max_links_universal
             FROM accounts a
             LEFT JOIN account_quota_policy p ON p.account_id = a.id
             WHERE a.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))",
            [json_ids.clone().into()],
        ))
        .await?;

    let grant_rows = db
        .query_all(sql(
            "SELECT * FROM account_quotas
             WHERE account_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))
               AND revoked = false
             ORDER BY priority DESC, COALESCE(cycle_ends_at, expires_at) ASC NULLS LAST, created_at ASC, id ASC",
            [json_ids.into()],
        ))
        .await?;

    let mut grants_by_account: HashMap<Uuid, Vec<RawGrant>> = HashMap::new();
    for row in grant_rows {
        let g = RawGrant::from_row(&row)?;
        grants_by_account.entry(g.account_id).or_default().push(g);
    }

    let mut result = HashMap::with_capacity(acc_rows.len());
    for row in acc_rows {
        let id: Uuid = row.try_get("", "id")?;
        let active: bool = row.try_get("", "active")?;
        let admin: bool = row.try_get("", "admin")?;
        let lifetime_used: i64 = row.try_get("", "used_bytes")?;
        let override_max_devices: Option<i32> = row.try_get("", "override_max_devices")?;
        let link_limits = LinkLimits::from_row(&row)?;

        let raw_grants = grants_by_account.remove(&id).unwrap_or_default();
        let mut views = Vec::with_capacity(raw_grants.len());

        let mut has_active_unlimited = false;
        let mut has_active_usable = false;
        let mut has_scheduled = false;
        let mut has_exhausted = false;
        let mut has_expired = false;

        let mut finite_total: i128 = 0;
        let mut finite_used: i128 = 0;
        let mut finite_remaining: i128 = 0;
        let mut finite_count: usize = 0;

        let mut window_starts: Option<DateTime<Utc>> = None;
        let mut window_ends: Option<DateTime<Utc>> = None;

        let mut any_grant_unlimited_devices = false;
        let mut max_grant_devices: Option<i32> = None;

        for raw in &raw_grants {
            let (view, st) = raw.to_view(now);
            match st {
                "active" => {
                    has_active_usable = true;
                    if view.quota_bytes.is_none() {
                        has_active_unlimited = true;
                    } else if let Some(limit) = view.quota_bytes.as_deref().and_then(|s| s.parse::<i128>().ok()) {
                        let used = view.used_bytes.parse::<i128>().unwrap_or(0);
                        finite_total += limit;
                        finite_used += used;
                        finite_remaining += (limit - used).max(0);
                        finite_count += 1;
                    }
                    if let Some(end) = view.cycle_ends_at.or(view.expires_at) {
                        window_ends = Some(match window_ends {
                            Some(cur) if cur < end => cur,
                            _ => end,
                        });
                    }
                    window_starts = Some(match window_starts {
                        Some(cur) if cur < view.cycle_starts_at => cur,
                        _ => view.cycle_starts_at,
                    });
                    if let Some(d) = view.max_devices {
                        max_grant_devices = Some(max_grant_devices.map_or(d, |cur| cur.max(d)));
                    } else {
                        any_grant_unlimited_devices = true;
                    }
                }
                "exhausted" => {
                    has_exhausted = true;
                    if let Some(limit) = view.quota_bytes.as_deref().and_then(|s| s.parse::<i128>().ok()) {
                        let used = view.used_bytes.parse::<i128>().unwrap_or(0);
                        finite_total += limit;
                        finite_used += used;
                        finite_count += 1;
                    }
                    if let Some(end) = view.cycle_ends_at.or(view.expires_at) {
                        window_ends = Some(match window_ends {
                            Some(cur) if cur < end => cur,
                            _ => end,
                        });
                    }
                }
                "scheduled" => has_scheduled = true,
                "expired" => has_expired = true,
                _ => {}
            }
            views.push(view);
        }

        let eligible = active && has_active_usable;
        let state = if !active {
            "inactive"
        } else if has_active_usable {
            "available"
        } else if has_exhausted {
            "exhausted"
        } else if has_scheduled {
            "scheduled"
        } else if has_expired {
            "expired"
        } else {
            "exhausted"
        };

        let (quota_bytes, used_bytes, remaining_bytes) = if has_active_unlimited {
            (None, lifetime_used.to_string(), None)
        } else if finite_count > 0 {
            (
                Some(finite_total.to_string()),
                finite_used.to_string(),
                Some(finite_remaining.to_string()),
            )
        } else {
            (Some("0".to_string()), "0".to_string(), Some("0".to_string()))
        };

        let max_devices = if let Some(ov) = override_max_devices {
            Some(ov)
        } else if any_grant_unlimited_devices || (admin && raw_grants.is_empty()) {
            None
        } else {
            max_grant_devices
        };

        result.insert(
            id,
            Status {
                quota_bytes,
                used_bytes,
                remaining_bytes,
                lifetime_used_bytes: lifetime_used.to_string(),
                eligible,
                state: state.to_string(),
                window_starts_at: window_starts,
                window_ends_at: window_ends,
                max_devices,
                override_max_devices,
                link_limits,
                grants: views,
            },
        );
    }

    Ok(result)
}

pub async fn update(
    db: &DatabaseConnection,
    actor_id: Uuid,
    target_id: Uuid,
    input: PolicyInput,
) -> Result<Status> {
    let max_devices = validate_devices(input.max_devices)?;
    let link_limits = input.link_limits.validate()?;

    let tx = db.begin().await?;
    access::begin_change(&tx).await?;
    let actor = access::actor(&tx, actor_id, &[Permission::QuotasManage]).await?;
    let (target, _) = access::subject(&tx, &actor, target_id).await?;

    tx.execute(sql(
        "INSERT INTO account_quota_policy (
             account_id, max_devices, max_links_xray, max_links_sing_box, max_links_mihomo, max_links_universal
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (account_id) DO UPDATE SET
             max_devices = EXCLUDED.max_devices,
             max_links_xray = EXCLUDED.max_links_xray,
             max_links_sing_box = EXCLUDED.max_links_sing_box,
             max_links_mihomo = EXCLUDED.max_links_mihomo,
             max_links_universal = EXCLUDED.max_links_universal",
        [
            target.id.into(),
            max_devices.into(),
            link_limits.xray.into(),
            link_limits.sing_box.into(),
            link_limits.mihomo.into(),
            link_limits.universal.into(),
        ],
    ))
    .await?;

    if let Some(limit) = max_devices {
        crate::services::subscriptions::devices::trim(&tx, target.id, limit).await?;
    }

    access::audit(&tx, actor_id, "account.quota_updated", target.id).await?;
    let current = read(&tx, target.id).await?;
    tx.commit().await?;
    Ok(current)
}

/// Waterfall deduction of billed traffic across an account's active quota grants:
/// 1. Advance any due calendar reset cycles first.
/// 2. Drain finite grants ordered by `priority DESC`, then earliest `cycle_ends_at / expires_at` first
///    (so resetting/expiring packs are consumed before permanent add-on packs!).
/// 3. Spillover automatically cascades to subsequent active grants.
pub async fn record_usage(
    db: &impl ConnectionTrait,
    account_id: Uuid,
    received_at: DateTime<Utc>,
    billed_bytes: i64,
) -> Result<()> {
    if billed_bytes <= 0 {
        return Ok(());
    }
    let rows = db
        .query_all(sql(
            "SELECT * FROM account_quotas
             WHERE account_id = $1 AND revoked = false
             ORDER BY priority DESC,
                      (quota_bytes IS NULL) ASC,
                      COALESCE(cycle_ends_at, expires_at) ASC NULLS LAST,
                      created_at ASC, id ASC
             FOR UPDATE",
            [account_id.into()],
        ))
        .await?;

    let mut grants: Vec<RawGrant> = rows
        .iter()
        .map(RawGrant::from_row)
        .collect::<Result<Vec<_>>>()?;

    // Step 1: persist any calendar cycle advancements before deducting.
    let mut active_indices = Vec::new();
    let mut has_unlimited = false;
    for (idx, g) in grants.iter_mut().enumerate() {
        let (projected, state) = g.projected(received_at);
        if projected.cycle_index != g.cycle_index {
            db.execute(sql(
                "UPDATE account_quotas
                 SET cycle_index = $2, cycle_starts_at = $3, cycle_ends_at = $4, used_bytes = 0
                 WHERE id = $1",
                [
                    g.id.into(),
                    projected.cycle_index.into(),
                    projected.cycle_starts_at.into(),
                    projected.cycle_ends_at.into(),
                ],
            ))
            .await?;
            *g = projected;
        }
        if state == "active" {
            if g.quota_bytes.is_none() {
                has_unlimited = true;
            } else {
                active_indices.push(idx);
            }
        }
    }

    // Re-sort active finite indices after cycle projection (in case a cycle rolled forward).
    active_indices.sort_by(|&a, &b| {
        let ga = &grants[a];
        let gb = &grants[b];
        gb.priority
            .cmp(&ga.priority)
            .then_with(|| {
                let ea = ga.cycle_ends_at.or(ga.expires_at);
                let eb = gb.cycle_ends_at.or(gb.expires_at);
                match (ea, eb) {
                    (Some(ta), Some(tb)) => ta.cmp(&tb),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                }
            })
            .then_with(|| ga.created_at.cmp(&gb.created_at))
            .then_with(|| ga.id.cmp(&gb.id))
    });

    // Step 2: waterfall deduct across finite grants.
    let mut remaining = billed_bytes;
    let total_finite = active_indices.len();
    for (pos, idx) in active_indices.into_iter().enumerate() {
        if remaining <= 0 {
            break;
        }
        let g = &grants[idx];
        let limit = g.quota_bytes.unwrap_or(i64::MAX);
        let avail = (limit - g.used_bytes).max(0);
        let is_last = pos + 1 == total_finite && !has_unlimited;
        let take = if is_last { remaining } else { remaining.min(avail) };
        if take > 0 {
            let next_used = g.used_bytes.saturating_add(take);
            db.execute(sql(
                "UPDATE account_quotas SET used_bytes = $2 WHERE id = $1",
                [g.id.into(), next_used.into()],
            ))
            .await?;
            remaining -= take;
        }
    }

    Ok(())
}

pub(crate) async fn lock_account(
    db: &impl ConnectionTrait,
    id: Uuid,
) -> Result<account::Model> {
    account::Entity::find_by_id(id)
        .lock_exclusive()
        .one(db)
        .await?
        .ok_or(Error::NotFound)
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn calendar_months_preserve_anchor_day_without_drift() {
        let jan31 = Utc.with_ymd_and_hms(2026, 1, 31, 12, 0, 0).unwrap();
        let m1 = add_calendar_duration(jan31, DurationKind::Months, 1, 1).unwrap();
        let m2 = add_calendar_duration(jan31, DurationKind::Months, 1, 2).unwrap();
        let m3 = add_calendar_duration(jan31, DurationKind::Months, 1, 3).unwrap();
        assert_eq!(m1, Utc.with_ymd_and_hms(2026, 2, 28, 12, 0, 0).unwrap());
        assert_eq!(m2, Utc.with_ymd_and_hms(2026, 3, 31, 12, 0, 0).unwrap());
        assert_eq!(m3, Utc.with_ymd_and_hms(2026, 4, 30, 12, 0, 0).unwrap());

        let d10 = add_calendar_duration(jan31, DurationKind::Days, 10, 1).unwrap();
        assert_eq!(d10, Utc.with_ymd_and_hms(2026, 2, 10, 12, 0, 0).unwrap());

        let y1 = add_calendar_duration(jan31, DurationKind::Years, 1, 1).unwrap();
        assert_eq!(y1, Utc.with_ymd_and_hms(2027, 1, 31, 12, 0, 0).unwrap());
    }
}
