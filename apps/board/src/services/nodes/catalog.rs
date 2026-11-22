use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;
use yuzuki_core_config::{
    Core,
    protocols::{Endpoint, NativeEndpoint, Transport, valid_host},
    server::{
        ManagedProtocolConfig, default_server_core, protocol_uses_tcp, protocol_uses_udp,
        supports_server_core,
    },
    templates,
};
use yuzuki_protocol::v1::{InstanceState, Meter, RuntimeStatus};

use crate::{
    infra::{
        error::{Error, Result, problem},
        postgres::entities::{proxy_node, server},
    },
    services::{
        access::{self, RoleSummary, sql},
        nodes::{broker::NodeBroker, inventory},
    },
};

const METER_PORT_START: i32 = 20_001;
const METER_PORT_END: i32 = 29_999;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeMode {
    Managed,
    Relay,
    External,
    Custom,
}

impl NodeMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::Relay => "relay",
            Self::External => "external",
            Self::Custom => "custom",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "relay" => Self::Relay,
            "external" => Self::External,
            "custom" => Self::Custom,
            _ => Self::Managed,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeVisibility {
    #[default]
    All,
    Roles,
}

impl NodeVisibility {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Roles => "roles",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxyNodeInput {
    pub name: String,
    pub mode: NodeMode,
    #[serde(default)]
    pub server_id: Option<Uuid>,
    #[serde(default)]
    pub parent_id: Option<Uuid>,
    #[serde(default)]
    pub core: Option<Core>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub show: bool,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default = "default_rate")]
    pub rate: f64,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub visibility: NodeVisibility,
    #[serde(default)]
    pub role_ids: Vec<Uuid>,
    #[serde(default)]
    pub protocol: Option<Transport>,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub listen_port: Option<u16>,
    #[serde(default)]
    pub protocol_config: Option<Value>,
    #[serde(default = "default_true")]
    pub meter_enabled: bool,
    #[serde(default)]
    pub meter_config: Option<Meter>,
    #[serde(default)]
    pub native_server_config: Option<Value>,
    #[serde(default)]
    pub native_client_overrides: BTreeMap<Core, NativeEndpoint>,
}

fn default_true() -> bool {
    true
}

fn default_rate() -> f64 {
    1.0
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxyNodePatch {
    pub show: Option<bool>,
    pub enabled: Option<bool>,
    pub sort_order: Option<i32>,
    pub rate: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReorderItem {
    pub id: Uuid,
    pub sort_order: i32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReorderInput {
    pub items: Vec<ReorderItem>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum BatchAction {
    Show,
    Hide,
    Enable,
    Disable,
    SetRate { rate: f64 },
    SetVisibility { visibility: NodeVisibility, role_ids: Vec<Uuid> },
    Delete { #[serde(default)] cascade: bool },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchInput {
    pub ids: Vec<Uuid>,
    #[serde(flatten)]
    pub action: BatchAction,
}

#[derive(Serialize)]
pub struct ProxyNodeView {
    pub id: Uuid,
    pub name: String,
    pub mode: String,
    pub server_id: Option<Uuid>,
    pub server_name: Option<String>,
    pub server_online: bool,
    pub parent_id: Option<Uuid>,
    pub parent_name: Option<String>,
    pub relay_count: i64,
    pub core: Option<String>,
    pub enabled: bool,
    pub show: bool,
    pub sort_order: i32,
    pub rate: f64,
    pub effective_rate: f64,
    pub tags: Vec<String>,
    pub visibility: String,
    pub roles: Vec<RoleSummary>,
    pub protocol: Option<String>,
    pub host: String,
    pub port: Option<i32>,
    pub listen_port: Option<i32>,
    pub formats: [bool; 4],
    pub meter_enabled: bool,
    pub meter_port: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meter_config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_server_config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_client_overrides: Option<Value>,
    pub runtime_state: String,
    pub runtime_error: Option<String>,
    pub online_sources: i64,
    pub uploaded: String,
    pub downloaded: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

pub fn resolve_client_endpoint(
    node: &proxy_node::Model,
    parent: Option<&proxy_node::Model>,
) -> Result<Option<Endpoint>> {
    let mut native: BTreeMap<Core, NativeEndpoint> =
        if node.native_client_overrides.is_object()
            && !node
                .native_client_overrides
                .as_object()
                .is_some_and(serde_json::Map::is_empty)
        {
            serde_json::from_value(node.native_client_overrides.clone())
                .map_err(|e| Error::Internal(e.into()))?
        } else {
            BTreeMap::new()
        };

    match NodeMode::parse(&node.mode) {
        NodeMode::Managed => {
            let port = u16::try_from(node.port.unwrap_or(0)).unwrap_or(0);
            if port == 0 || node.host.trim().is_empty() {
                return Ok(None);
            }
            let cfg: ManagedProtocolConfig =
                serde_json::from_value(node.protocol_config.clone())
                    .map_err(|e| Error::Internal(e.into()))?;
            let portable = cfg
                .to_portable_endpoint(&node.host, port)
                .map_err(Error::Internal)?;
            Ok(Some(Endpoint {
                portable: Some(portable),
                native,
            }))
        }
        NodeMode::Relay => {
            let Some(parent) = parent else {
                return Ok(None);
            };
            let port = u16::try_from(node.port.unwrap_or(0)).unwrap_or(0);
            if port == 0 || node.host.trim().is_empty() {
                return Ok(None);
            }
            // Inherit parent native overrides where child didn't explicitly override.
            if parent.native_client_overrides.is_object()
                && !parent
                    .native_client_overrides
                    .as_object()
                    .is_some_and(serde_json::Map::is_empty)
                && let Ok(parent_native) =
                    serde_json::from_value::<BTreeMap<Core, NativeEndpoint>>(
                        parent.native_client_overrides.clone(),
                    )
            {
                for (core, ep) in parent_native {
                    native.entry(core).or_insert(ep);
                }
            }
            let portable = if parent.mode == "managed"
                || (parent.protocol.is_some()
                    && parent.protocol_config.is_object()
                    && !parent
                        .protocol_config
                        .as_object()
                        .is_some_and(serde_json::Map::is_empty))
            {
                let cfg: ManagedProtocolConfig =
                    serde_json::from_value(parent.protocol_config.clone())
                        .map_err(|e| Error::Internal(e.into()))?;
                Some(
                    cfg.to_portable_endpoint(&node.host, port)
                        .map_err(Error::Internal)?,
                )
            } else {
                None
            };
            if portable.is_none() && native.is_empty() {
                return Ok(None);
            }
            Ok(Some(Endpoint { portable, native }))
        }
        NodeMode::External | NodeMode::Custom => {
            let portable = if node.protocol.is_some()
                && !node.host.trim().is_empty()
                && node.port.is_some_and(|p| p > 0)
                && node.protocol_config.is_object()
                && !node
                    .protocol_config
                    .as_object()
                    .is_some_and(serde_json::Map::is_empty)
            {
                let cfg: ManagedProtocolConfig =
                    serde_json::from_value(node.protocol_config.clone())
                        .map_err(|e| Error::Internal(e.into()))?;
                Some(
                    cfg.to_portable_endpoint(&node.host, node.port.unwrap_or(0) as u16)
                        .map_err(Error::Internal)?,
                )
            } else {
                None
            };
            if portable.is_none() && native.is_empty() {
                return Ok(None);
            }
            Ok(Some(Endpoint { portable, native }))
        }
    }
}

pub async fn list(
    db: &DatabaseConnection,
    include_deleted: bool,
    secrets: bool,
) -> Result<Vec<ProxyNodeView>> {
    let mut query = proxy_node::Entity::find()
        .order_by_asc(proxy_node::Column::DeletedAt)
        .order_by_asc(proxy_node::Column::SortOrder)
        .order_by_asc(proxy_node::Column::CreatedAt)
        .order_by_asc(proxy_node::Column::Id);
    if !include_deleted {
        query = query.filter(proxy_node::Column::DeletedAt.is_null());
    }
    let rows = query.all(db).await?;
    decorate(db, rows, secrets).await
}

pub async fn get_view(
    db: &DatabaseConnection,
    id: Uuid,
    secrets: bool,
) -> Result<ProxyNodeView> {
    let row = proxy_node::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    decorate(db, vec![row], secrets)
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)
}

async fn decorate(
    db: &impl ConnectionTrait,
    rows: Vec<proxy_node::Model>,
    secrets: bool,
) -> Result<Vec<ProxyNodeView>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let now = Utc::now();
    let node_ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    let parent_ids: Vec<Uuid> = rows.iter().filter_map(|r| r.parent_id).collect();
    let mut all_parent_map: HashMap<Uuid, proxy_node::Model> = HashMap::new();
    if !parent_ids.is_empty() {
        for p in proxy_node::Entity::find()
            .filter(proxy_node::Column::Id.is_in(parent_ids))
            .all(db)
            .await?
        {
            all_parent_map.insert(p.id, p);
        }
    }

    let mut server_ids: HashSet<Uuid> = rows.iter().filter_map(|r| r.server_id).collect();
    for p in all_parent_map.values() {
        if let Some(sid) = p.server_id {
            server_ids.insert(sid);
        }
    }
    let mut server_map: HashMap<Uuid, server::Model> = HashMap::new();
    if !server_ids.is_empty() {
        for s in server::Entity::find()
            .filter(server::Column::Id.is_in(server_ids.into_iter().collect::<Vec<_>>()))
            .all(db)
            .await?
        {
            server_map.insert(s.id, s);
        }
    }

    // Relay child counts (active relays pointing to each node)
    let relay_rows = db
        .query_all(sql(
            "SELECT parent_id, count(*) AS cnt
             FROM proxy_nodes
             WHERE deleted_at IS NULL AND parent_id IN (
                 SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb)
             )
             GROUP BY parent_id",
            [json!(node_ids).into()],
        ))
        .await?;
    let mut relay_counts: HashMap<Uuid, i64> = HashMap::new();
    for r in relay_rows {
        relay_counts.insert(r.try_get("", "parent_id")?, r.try_get("", "cnt")?);
    }

    // Roles per node
    let role_rows = db
        .query_all(sql(
            "SELECT pnr.node_id, r.id AS role_id, r.name, r.built_in, r.locked
             FROM proxy_node_roles pnr
             JOIN roles r ON r.id = pnr.role_id
             WHERE pnr.node_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))
             ORDER BY r.locked DESC, r.built_in DESC, r.name",
            [json!(node_ids).into()],
        ))
        .await?;
    let mut roles_map: HashMap<Uuid, Vec<RoleSummary>> = HashMap::new();
    for r in role_rows {
        let nid: Uuid = r.try_get("", "node_id")?;
        roles_map.entry(nid).or_default().push(RoleSummary {
            id: r.try_get("", "role_id")?,
            name: r.try_get("", "name")?,
            built_in: r.try_get("", "built_in")?,
            locked: r.try_get("", "locked")?,
        });
    }

    // Cumulative traffic per node
    let usage_rows = db
        .query_all(sql(
            "SELECT node_id, COALESCE(sum(uploaded), 0)::text AS up, COALESCE(sum(downloaded), 0)::text AS down
             FROM usage_events
             WHERE node_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))
             GROUP BY node_id",
            [json!(node_ids).into()],
        ))
        .await?;
    let mut usage_map: HashMap<Uuid, (String, String)> = HashMap::new();
    for r in usage_rows {
        usage_map.insert(
            r.try_get("", "node_id")?,
            (r.try_get("", "up")?, r.try_get("", "down")?),
        );
    }

    // Online sources per node (fresh within 20s)
    let online_rows = db
        .query_all(sql(
            "SELECT oi.node_id, count(DISTINCT (os.account_id, os.fingerprint)) AS cnt
             FROM observed_instances oi
             JOIN servers s ON s.id = oi.server_id AND s.session_id = oi.session_id
             LEFT JOIN observed_sources os ON os.node_id = oi.node_id
             WHERE oi.observed_at > $1::timestamptz - INTERVAL '20 seconds'
               AND oi.node_id IN (SELECT value::uuid FROM jsonb_array_elements_text($2::jsonb))
             GROUP BY oi.node_id",
            [now.into(), json!(node_ids).into()],
        ))
        .await?;
    let mut online_map: HashMap<Uuid, i64> = HashMap::new();
    for r in online_rows {
        online_map.insert(r.try_get("", "node_id")?, r.try_get("", "cnt")?);
    }

    let mut views = Vec::with_capacity(rows.len());
    for row in rows {
        let parent = row.parent_id.and_then(|pid| all_parent_map.get(&pid));
        let effective_server_id = row.server_id.or_else(|| parent.and_then(|p| p.server_id));
        let srv = effective_server_id.and_then(|sid| server_map.get(&sid));
        let server_online = srv.is_some_and(|s| is_server_online(s, now));
        let server_name = srv.map(|s| s.name.clone());

        let formats = resolve_client_endpoint(&row, parent)
            .ok()
            .flatten()
            .map(|ep| ep.compatible_formats())
            .unwrap_or([false; 4]);

        let (runtime_state, runtime_error) = compute_runtime_state(&row, parent, srv, server_online);
        let (uploaded, downloaded) = usage_map
            .remove(&row.id)
            .unwrap_or_else(|| ("0".into(), "0".into()));
        let effective_rate = if row.mode == "relay" {
            parent.map(|p| p.rate).unwrap_or(row.rate)
        } else {
            row.rate
        };
        let protocol = row
            .protocol
            .clone()
            .or_else(|| parent.and_then(|p| p.protocol.clone()));
        let core = row
            .core
            .clone()
            .or_else(|| parent.and_then(|p| p.core.clone()));
        let relay_count = relay_counts.get(&row.id).copied().unwrap_or(0);
        let online_sources = online_map.get(&row.id).copied().unwrap_or(0);

        views.push(ProxyNodeView {
            id: row.id,
            name: row.name,
            mode: row.mode,
            server_id: row.server_id,
            server_name,
            server_online,
            parent_id: row.parent_id,
            parent_name: parent.map(|p| p.name.clone()),
            relay_count,
            core,
            enabled: row.enabled,
            show: row.show,
            sort_order: row.sort_order,
            rate: row.rate,
            effective_rate,
            tags: row.tags,
            visibility: row.visibility,
            roles: roles_map.remove(&row.id).unwrap_or_default(),
            protocol,
            host: row.host,
            port: row.port,
            listen_port: row.listen_port,
            formats,
            meter_enabled: row.meter_enabled,
            meter_port: row.meter_port,
            protocol_config: secrets.then_some(row.protocol_config),
            meter_config: secrets.then_some(row.meter_config).flatten(),
            native_server_config: secrets.then_some(row.native_server_config).flatten(),
            native_client_overrides: secrets.then_some(row.native_client_overrides),
            runtime_state,
            runtime_error,
            online_sources,
            uploaded,
            downloaded,
            created_at: row.created_at,
            updated_at: row.updated_at,
            deleted_at: row.deleted_at,
        });
    }
    Ok(views)
}

fn is_server_online(s: &server::Model, now: DateTime<Utc>) -> bool {
    s.deleted_at.is_none()
        && s.session_id.is_some()
        && s.last_seen_at
            .is_some_and(|seen| now.signed_duration_since(seen) <= Duration::seconds(60))
}

fn compute_runtime_state(
    node: &proxy_node::Model,
    parent: Option<&proxy_node::Model>,
    srv: Option<&server::Model>,
    server_online: bool,
) -> (String, Option<String>) {
    if node.deleted_at.is_some() {
        return ("trashed".into(), None);
    }
    match NodeMode::parse(&node.mode) {
        NodeMode::External => {
            if node.enabled {
                ("external".into(), None)
            } else {
                ("disabled".into(), None)
            }
        }
        NodeMode::Relay => {
            if !node.enabled {
                return ("disabled".into(), None);
            }
            let Some(parent) = parent else {
                return ("failed".into(), Some("Parent node is missing".into()));
            };
            if parent.deleted_at.is_some() || !parent.enabled {
                return ("disabled".into(), Some("Parent node is inactive".into()));
            }
            compute_runtime_state(parent, None, srv, server_online)
        }
        NodeMode::Managed | NodeMode::Custom => {
            if !node.enabled {
                return ("disabled".into(), None);
            }
            let Some(srv) = srv else {
                return ("offline".into(), Some("Host server missing".into()));
            };
            if !server_online {
                return ("offline".into(), None);
            }
            if let Some(rt_json) = &srv.runtime_status
                && let Ok(statuses) = serde_json::from_value::<Vec<RuntimeStatus>>(rt_json.clone())
                && let Some(st) = statuses.into_iter().find(|s| s.instance_id == node.id)
            {
                let label = match st.state {
                    InstanceState::Running if st.running => "running",
                    InstanceState::MissingCore => "missing_core",
                    InstanceState::Failed => "failed",
                    InstanceState::Stopped | InstanceState::Running => {
                        if st.running { "running" } else { "stopped" }
                    }
                };
                return (label.into(), st.error);
            }
            if let Some(core_str) = node.core.as_deref()
                && let Ok(caps) = serde_json::from_value::<Vec<yuzuki_protocol::v1::Capability>>(
                    srv.capabilities.clone(),
                )
                && !caps.iter().any(|c| c.core.id() == core_str)
            {
                return (
                    "missing_core".into(),
                    Some(format!("{core_str} is not installed on {}", srv.name)),
                );
            }
            ("pending".into(), None)
        }
    }
}

fn validate_rate(rate: f64) -> Result<f64> {
    if !rate.is_finite() || !(0.0..=100.0).contains(&rate) {
        return Err(Error::BadRequest(problem::NODE_RATE_RANGE));
    }
    Ok((rate * 100.0).round() / 100.0)
}

fn clean_tags(tags: Vec<String>) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in tags {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > 32 || trimmed.chars().any(char::is_control) {
            return Err(Error::BadRequest(problem::NODE_TAGS_LIMIT));
        }
        if seen.insert(trimmed.to_lowercase()) {
            out.push(trimmed.to_string());
        }
    }
    if out.len() > 12 {
        return Err(Error::BadRequest(problem::NODE_TAGS_LIMIT));
    }
    Ok(out)
}

async fn allocate_meter_port(
    tx: &impl ConnectionTrait,
    server_id: Uuid,
    existing_port: Option<i32>,
) -> Result<i32> {
    if let Some(port) = existing_port
        && (METER_PORT_START..=METER_PORT_END).contains(&port)
    {
        return Ok(port);
    }
    let rows = tx
        .query_all(sql(
            "SELECT meter_port FROM proxy_nodes
             WHERE server_id = $1 AND deleted_at IS NULL AND meter_port IS NOT NULL",
            [server_id.into()],
        ))
        .await?;
    let used: HashSet<i32> = rows
        .into_iter()
        .filter_map(|r| r.try_get::<Option<i32>>("", "meter_port").ok().flatten())
        .collect();
    for port in METER_PORT_START..=METER_PORT_END {
        if !used.contains(&port) {
            return Ok(port);
        }
    }
    Err(Error::Internal(anyhow::anyhow!(
        "exhausted local metering port pool on server"
    )))
}

async fn check_listen_port_conflict(
    tx: &impl ConnectionTrait,
    server_id: Uuid,
    exclude_id: Option<Uuid>,
    listen_port: u16,
    protocol: Transport,
) -> Result<()> {
    let want_tcp = protocol_uses_tcp(protocol);
    let want_udp = protocol_uses_udp(protocol);
    let peers = proxy_node::Entity::find()
        .filter(proxy_node::Column::ServerId.eq(server_id))
        .filter(proxy_node::Column::DeletedAt.is_null())
        .filter(proxy_node::Column::Enabled.eq(true))
        .filter(proxy_node::Column::Mode.eq("managed"))
        .filter(proxy_node::Column::ListenPort.eq(i32::from(listen_port)))
        .all(tx)
        .await?;
    for peer in peers {
        if exclude_id == Some(peer.id) {
            continue;
        }
        let peer_proto: Option<Transport> = peer
            .protocol
            .as_deref()
            .and_then(|s| serde_json::from_value(json!(s)).ok());
        let (peer_tcp, peer_udp) = match peer_proto {
            Some(p) => (protocol_uses_tcp(p), protocol_uses_udp(p)),
            None => (true, true),
        };
        if (want_tcp && peer_tcp) || (want_udp && peer_udp) {
            return Err(Error::Conflict(problem::NODE_PORT_CONFLICT));
        }
    }
    Ok(())
}

async fn sync_roles(
    tx: &impl ConnectionTrait,
    node_id: Uuid,
    visibility: NodeVisibility,
    role_ids: &[Uuid],
) -> Result<()> {
    tx.execute(sql(
        "DELETE FROM proxy_node_roles WHERE node_id = $1",
        [node_id.into()],
    ))
    .await?;
    if visibility == NodeVisibility::Roles {
        let unique: BTreeSet<Uuid> = role_ids.iter().copied().collect();
        for rid in unique {
            let exists = tx
                .query_one(sql("SELECT 1 FROM roles WHERE id = $1", [rid.into()]))
                .await?
                .is_some();
            if !exists {
                return Err(Error::Invalid(format!("Role {rid} does not exist.")));
            }
            tx.execute(sql(
                "INSERT INTO proxy_node_roles (node_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                [node_id.into(), rid.into()],
            ))
            .await?;
        }
    }
    Ok(())
}

pub async fn save_node(
    db: &DatabaseConnection,
    actor: Uuid,
    id: Option<Uuid>,
    mut input: ProxyNodeInput,
) -> Result<ProxyNodeView> {
    let name = inventory::label(input.name)?;
    let rate = validate_rate(input.rate)?;
    let tags = clean_tags(input.tags)?;

    let tx = db.begin().await?;
    let existing = if let Some(id) = id {
        Some(
            proxy_node::Entity::find_by_id(id)
                .filter(proxy_node::Column::DeletedAt.is_null())
                .one(&tx)
                .await?
                .ok_or(Error::NotFound)?,
        )
    } else {
        None
    };

    // Validate native client overrides if provided
    for (core, ep) in &input.native_client_overrides {
        let candidate = Endpoint {
            portable: None,
            native: BTreeMap::from([(*core, ep.clone())]),
        };
        candidate
            .validate()
            .map_err(|e| Error::Invalid(e.to_string()))?;
    }
    let native_overrides_json = serde_json::to_value(&input.native_client_overrides)
        .map_err(|e| Error::Internal(e.into()))?;

    let mut server_id: Option<Uuid> = None;
    let mut parent_id: Option<Uuid> = None;
    let mut core_str: Option<String> = None;
    let mut protocol_str: Option<String> = None;
    let mut host = input.host.trim().to_string();
    let mut port: Option<i32> = input.port.map(i32::from);
    let mut listen_port: Option<i32> = input.listen_port.map(i32::from);
    let mut protocol_config = json!({});
    let mut meter_enabled = input.meter_enabled;
    let mut meter_port: Option<i32> = None;
    let mut meter_config: Option<Value> = None;
    let mut native_server_config: Option<Value> = None;

    match input.mode {
        NodeMode::Managed => {
            let sid = input
                .server_id
                .ok_or(Error::BadRequest(problem::NODE_MODE_INVALID))?;
            let srv = inventory::locked_active(&tx, sid).await?;
            let cfg_val = input
                .protocol_config
                .ok_or(Error::Invalid("Managed node requires protocol_config.".into()))?;
            let cfg: ManagedProtocolConfig =
                serde_json::from_value(cfg_val).map_err(|e| Error::Invalid(e.to_string()))?;
            let chosen_core = input.core.unwrap_or_else(|| {
                pick_best_core(&srv, cfg.protocol).unwrap_or_else(|| default_server_core(cfg.protocol))
            });
            if !supports_server_core(cfg.protocol, chosen_core) {
                return Err(Error::Invalid(format!(
                    "{chosen_core} does not support {:?} listeners.",
                    cfg.protocol
                )));
            }
            let p_port = input
                .port
                .filter(|&p| p > 0)
                .ok_or(Error::Invalid("Client port must be between 1 and 65535.".into()))?;
            let l_port = input.listen_port.filter(|&p| p > 0).unwrap_or(p_port);
            if host.is_empty() {
                if let Some(def) = srv.default_host.as_deref() {
                    host = def.to_string();
                } else {
                    return Err(Error::Invalid(
                        "Public host (domain or IP) is required.".into(),
                    ));
                }
            }
            cfg.validate_for_server(chosen_core, &host, p_port, l_port)
                .map_err(|e| Error::Invalid(e.to_string()))?;

            if input.enabled {
                check_listen_port_conflict(&tx, sid, id, l_port, cfg.protocol).await?;
            }

            // Auto-allocate loopback metering port for Xray / sing-box when enabled.
            if meter_enabled && chosen_core != Core::Mihomo {
                let keep_port = existing
                    .as_ref()
                    .filter(|e| e.server_id == Some(sid))
                    .and_then(|e| e.meter_port);
                meter_port = Some(allocate_meter_port(&tx, sid, keep_port).await?);
            }

            server_id = Some(sid);
            core_str = Some(chosen_core.id().to_string());
            protocol_str = serde_json::to_value(cfg.protocol)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string));
            port = Some(i32::from(p_port));
            listen_port = Some(i32::from(l_port));
            protocol_config = serde_json::to_value(&cfg).map_err(|e| Error::Internal(e.into()))?;
        }
        NodeMode::Relay => {
            let pid = input
                .parent_id
                .ok_or(Error::BadRequest(problem::NODE_MODE_INVALID))?;
            if id == Some(pid) {
                return Err(Error::BadRequest(problem::NODE_MODE_INVALID));
            }
            let parent = proxy_node::Entity::find_by_id(pid)
                .filter(proxy_node::Column::DeletedAt.is_null())
                .one(&tx)
                .await?
                .ok_or(Error::NotFound)?;
            if !matches!(parent.mode.as_str(), "managed" | "custom") {
                return Err(Error::Invalid(
                    "Relay parent must be a managed or custom node.".into(),
                ));
            }
            let p_port = input
                .port
                .filter(|&p| p > 0)
                .ok_or(Error::Invalid("Relay entry port must be between 1 and 65535.".into()))?;
            if !valid_host(&host) {
                return Err(Error::Invalid("Enter a valid relay hostname or IP address.".into()));
            }
            parent_id = Some(pid);
            port = Some(i32::from(p_port));
            listen_port = None;
            meter_enabled = false;
        }
        NodeMode::External => {
            meter_enabled = false;
            listen_port = None;
            if let Some(cfg_val) = input.protocol_config
                && cfg_val.is_object()
                && !cfg_val.as_object().is_some_and(serde_json::Map::is_empty)
            {
                let cfg: ManagedProtocolConfig =
                    serde_json::from_value(cfg_val).map_err(|e| Error::Invalid(e.to_string()))?;
                let p_port = input
                    .port
                    .filter(|&p| p > 0)
                    .ok_or(Error::Invalid("Port must be between 1 and 65535.".into()))?;
                cfg.to_portable_endpoint(&host, p_port)
                    .map_err(|e| Error::Invalid(e.to_string()))?;
                protocol_str = serde_json::to_value(cfg.protocol)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string));
                port = Some(i32::from(p_port));
                protocol_config =
                    serde_json::to_value(&cfg).map_err(|e| Error::Internal(e.into()))?;
            } else if input.native_client_overrides.is_empty() {
                return Err(Error::Invalid(
                    "External node requires either protocol settings or at least one native client override.".into(),
                ));
            }
        }
        NodeMode::Custom => {
            let sid = input
                .server_id
                .ok_or(Error::BadRequest(problem::NODE_MODE_INVALID))?;
            let _srv = inventory::locked_active(&tx, sid).await?;
            let chosen_core = input
                .core
                .ok_or(Error::BadRequest(problem::NODE_CORE_INVALID))?;
            let mut raw_cfg = input
                .native_server_config
                .take()
                .ok_or(Error::BadRequest(problem::NODE_CONFIG_OBJECT))?;
            if chosen_core == Core::Mihomo
                && let Some(yaml) = raw_cfg.as_str()
            {
                raw_cfg = serde_yaml_ng::from_str(yaml)
                    .map_err(|error| Error::Invalid(format!("Invalid mihomo YAML: {error}")))?;
            }
            if !raw_cfg.is_object() {
                return Err(Error::BadRequest(problem::NODE_CONFIG_OBJECT));
            }
            templates::server(&raw_cfg, &["00000000-0000-4000-8000-000000000000".into()])
                .map_err(|error| Error::Invalid(error.to_string()))?;
            if let Some(meter) = &input.meter_config {
                let valid = match meter {
                    Meter::UserStats { addr } => {
                        chosen_core != Core::Mihomo && addr.ip().is_loopback() && addr.port() != 0
                    }
                    Meter::DedicatedTraffic { addr, secret, .. } => {
                        chosen_core == Core::Mihomo
                            && addr.ip().is_loopback()
                            && addr.port() != 0
                            && !secret.is_empty()
                    }
                };
                if !valid {
                    return Err(Error::BadRequest(problem::NODE_STATS_ADDRESS));
                }
                meter_config =
                    Some(serde_json::to_value(meter).map_err(|e| Error::Internal(e.into()))?);
                meter_enabled = true;
            } else {
                meter_enabled = false;
            }
            if let Some(cfg_val) = input.protocol_config
                && cfg_val.is_object()
                && !cfg_val.as_object().is_some_and(serde_json::Map::is_empty)
            {
                let cfg: ManagedProtocolConfig =
                    serde_json::from_value(cfg_val).map_err(|e| Error::Invalid(e.to_string()))?;
                let p_port = input
                    .port
                    .filter(|&p| p > 0)
                    .ok_or(Error::Invalid("Client port must be between 1 and 65535.".into()))?;
                cfg.to_portable_endpoint(&host, p_port)
                    .map_err(|e| Error::Invalid(e.to_string()))?;
                protocol_str = serde_json::to_value(cfg.protocol)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string));
                port = Some(i32::from(p_port));
                protocol_config =
                    serde_json::to_value(&cfg).map_err(|e| Error::Internal(e.into()))?;
            }
            server_id = Some(sid);
            core_str = Some(chosen_core.id().to_string());
            native_server_config = Some(raw_cfg);
        }
    }

    let now = Utc::now();
    let node_id = id.unwrap_or_else(Uuid::new_v4);
    let mut row = if let Some(prev) = existing {
        prev.into()
    } else {
        proxy_node::ActiveModel {
            id: Set(node_id),
            created_at: Set(now),
            ..Default::default()
        }
    };
    row.name = Set(name.clone());
    row.mode = Set(input.mode.as_str().to_string());
    row.server_id = Set(server_id);
    row.parent_id = Set(parent_id);
    row.core = Set(core_str);
    row.enabled = Set(input.enabled);
    row.show = Set(input.show);
    row.sort_order = Set(input.sort_order);
    row.rate = Set(rate);
    row.tags = Set(tags);
    row.visibility = Set(input.visibility.as_str().to_string());
    row.protocol = Set(protocol_str);
    row.host = Set(host);
    row.port = Set(port);
    row.listen_port = Set(listen_port);
    row.protocol_config = Set(protocol_config);
    row.meter_enabled = Set(meter_enabled);
    row.meter_port = Set(meter_port);
    row.meter_config = Set(meter_config);
    row.native_server_config = Set(native_server_config);
    row.native_client_overrides = Set(native_overrides_json);
    row.updated_at = Set(now);

    let saved = if id.is_some() {
        row.update(&tx).await?
    } else {
        row.insert(&tx).await?
    };

    sync_roles(&tx, saved.id, input.visibility, &input.role_ids).await?;
    access::audit_subject(
        &tx,
        actor,
        if id.is_some() {
            "node.updated"
        } else {
            "node.created"
        },
        saved.id,
        Some(&name),
    )
    .await?;

    let view = decorate(&tx, vec![saved], true)
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(view)
}

fn pick_best_core(srv: &server::Model, protocol: Transport) -> Option<Core> {
    let caps: Vec<yuzuki_protocol::v1::Capability> =
        serde_json::from_value(srv.capabilities.clone()).ok()?;
    for &preferred in yuzuki_core_config::server::supported_server_cores(protocol) {
        if caps.iter().any(|c| c.core == preferred) {
            return Some(preferred);
        }
    }
    None
}

pub async fn patch_node(
    db: &DatabaseConnection,
    actor: Uuid,
    id: Uuid,
    patch: ProxyNodePatch,
) -> Result<ProxyNodeView> {
    let tx = db.begin().await?;
    let existing = proxy_node::Entity::find_by_id(id)
        .filter(proxy_node::Column::DeletedAt.is_null())
        .one(&tx)
        .await?
        .ok_or(Error::NotFound)?;

    let next_enabled = patch.enabled.unwrap_or(existing.enabled);
    if next_enabled
        && !existing.enabled
        && existing.mode == "managed"
        && let (Some(sid), Some(l_port)) = (existing.server_id, existing.listen_port)
        && let Some(proto_str) = existing.protocol.as_deref()
        && let Ok(proto) = serde_json::from_value::<Transport>(json!(proto_str))
    {
        check_listen_port_conflict(&tx, sid, Some(id), l_port as u16, proto).await?;
    }

    let name = existing.name.clone();
    let mut row: proxy_node::ActiveModel = existing.into();
    if let Some(show) = patch.show {
        row.show = Set(show);
    }
    if let Some(enabled) = patch.enabled {
        row.enabled = Set(enabled);
    }
    if let Some(sort_order) = patch.sort_order {
        row.sort_order = Set(sort_order);
    }
    if let Some(rate) = patch.rate {
        row.rate = Set(validate_rate(rate)?);
    }
    row.updated_at = Set(Utc::now());
    let updated = row.update(&tx).await?;
    access::audit_subject(&tx, actor, "node.updated", id, Some(&name)).await?;
    let view = decorate(&tx, vec![updated], true)
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(view)
}

pub async fn clone_node(
    db: &DatabaseConnection,
    actor: Uuid,
    id: Uuid,
) -> Result<ProxyNodeView> {
    let tx = db.begin().await?;
    let source = proxy_node::Entity::find_by_id(id)
        .filter(proxy_node::Column::DeletedAt.is_null())
        .one(&tx)
        .await?
        .ok_or(Error::NotFound)?;
    let role_rows = tx
        .query_all(sql(
            "SELECT role_id FROM proxy_node_roles WHERE node_id = $1",
            [id.into()],
        ))
        .await?;
    let role_ids: Vec<Uuid> = role_rows
        .into_iter()
        .map(|r| r.try_get("", "role_id"))
        .collect::<std::result::Result<_, _>>()?;

    let mut new_port = source.port;
    let mut new_listen_port = source.listen_port;
    let mut new_meter_port = None;

    if source.mode == "managed"
        && let Some(sid) = source.server_id
    {
        let _srv = inventory::locked_active(&tx, sid).await?;
        if source.meter_enabled && source.core.as_deref() != Some("mihomo") {
            new_meter_port = Some(allocate_meter_port(&tx, sid, None).await?);
        }
        // Bump listen_port (and port if equal) so the clone can start cleanly without port clash.
        if let Some(base_lp) = source.listen_port {
            let mut candidate = base_lp;
            let proto: Option<Transport> = source
                .protocol
                .as_deref()
                .and_then(|s| serde_json::from_value(json!(s)).ok());
            if let Some(proto) = proto {
                for offset in 1..=200 {
                    let try_port = ((base_lp - 1 + offset) % 65535) + 1;
                    if check_listen_port_conflict(&tx, sid, None, try_port as u16, proto)
                        .await
                        .is_ok()
                    {
                        candidate = try_port;
                        break;
                    }
                }
            }
            if source.port == source.listen_port {
                new_port = Some(candidate);
            }
            new_listen_port = Some(candidate);
        }
    }

    let mut cloned_name = format!("{} (Copy)", source.name);
    if cloned_name.chars().count() > 80 {
        cloned_name = cloned_name.chars().take(80).collect();
    }
    let now = Utc::now();
    let new_id = Uuid::new_v4();
    let inserted = proxy_node::ActiveModel {
        id: Set(new_id),
        name: Set(cloned_name.clone()),
        mode: Set(source.mode),
        server_id: Set(source.server_id),
        parent_id: Set(source.parent_id),
        core: Set(source.core),
        enabled: Set(false), // Start paused so operator can review port/name first
        show: Set(false),
        sort_order: Set(source.sort_order + 1),
        rate: Set(source.rate),
        tags: Set(source.tags),
        visibility: Set(source.visibility.clone()),
        protocol: Set(source.protocol),
        host: Set(source.host),
        port: Set(new_port),
        listen_port: Set(new_listen_port),
        protocol_config: Set(source.protocol_config),
        meter_enabled: Set(source.meter_enabled),
        meter_port: Set(new_meter_port),
        meter_config: Set(source.meter_config),
        native_server_config: Set(source.native_server_config),
        native_client_overrides: Set(source.native_client_overrides),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
    }
    .insert(&tx)
    .await?;

    let vis = if source.visibility == "roles" {
        NodeVisibility::Roles
    } else {
        NodeVisibility::All
    };
    sync_roles(&tx, new_id, vis, &role_ids).await?;
    access::audit_subject(&tx, actor, "node.created", new_id, Some(&cloned_name)).await?;

    let view = decorate(&tx, vec![inserted], true)
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(view)
}

pub async fn reorder_nodes(
    db: &DatabaseConnection,
    _actor: Uuid,
    items: Vec<ReorderItem>,
) -> Result<()> {
    if items.is_empty() || items.len() > 500 {
        return Err(Error::BadRequest(problem::NODE_BATCH_SELECTION));
    }
    let tx = db.begin().await?;
    let now = Utc::now();
    for item in items {
        proxy_node::Entity::update_many()
            .set(proxy_node::ActiveModel {
                sort_order: Set(item.sort_order),
                updated_at: Set(now),
                ..Default::default()
            })
            .filter(proxy_node::Column::Id.eq(item.id))
            .filter(proxy_node::Column::DeletedAt.is_null())
            .exec(&tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn batch_nodes(
    db: &DatabaseConnection,
    actor: Uuid,
    input: BatchInput,
) -> Result<usize> {
    let ids: Vec<Uuid> = input
        .ids
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() || ids.len() > 100 {
        return Err(Error::BadRequest(problem::NODE_BATCH_SELECTION));
    }
    match input.action {
        BatchAction::Delete { cascade } => {
            for id in &ids {
                soft_delete_node(db, actor, *id, cascade).await?;
            }
            Ok(ids.len())
        }
        other => {
            let tx = db.begin().await?;
            let now = Utc::now();
            match other {
                BatchAction::Show => {
                    proxy_node::Entity::update_many()
                        .set(proxy_node::ActiveModel {
                            show: Set(true),
                            updated_at: Set(now),
                            ..Default::default()
                        })
                        .filter(proxy_node::Column::Id.is_in(ids.clone()))
                        .filter(proxy_node::Column::DeletedAt.is_null())
                        .exec(&tx)
                        .await?;
                }
                BatchAction::Hide => {
                    proxy_node::Entity::update_many()
                        .set(proxy_node::ActiveModel {
                            show: Set(false),
                            updated_at: Set(now),
                            ..Default::default()
                        })
                        .filter(proxy_node::Column::Id.is_in(ids.clone()))
                        .filter(proxy_node::Column::DeletedAt.is_null())
                        .exec(&tx)
                        .await?;
                }
                BatchAction::Enable => {
                    for &id in &ids {
                        if let Some(node) = proxy_node::Entity::find_by_id(id)
                            .filter(proxy_node::Column::DeletedAt.is_null())
                            .one(&tx)
                            .await?
                        {
                            if !node.enabled
                                && node.mode == "managed"
                                && let (Some(sid), Some(l_port)) = (node.server_id, node.listen_port)
                                && let Some(proto_str) = node.protocol.as_deref()
                                && let Ok(proto) = serde_json::from_value::<Transport>(json!(proto_str))
                            {
                                check_listen_port_conflict(&tx, sid, Some(id), l_port as u16, proto)
                                    .await?;
                            }
                            let mut row: proxy_node::ActiveModel = node.into();
                            row.enabled = Set(true);
                            row.updated_at = Set(now);
                            row.update(&tx).await?;
                        }
                    }
                }
                BatchAction::Disable => {
                    proxy_node::Entity::update_many()
                        .set(proxy_node::ActiveModel {
                            enabled: Set(false),
                            updated_at: Set(now),
                            ..Default::default()
                        })
                        .filter(proxy_node::Column::Id.is_in(ids.clone()))
                        .filter(proxy_node::Column::DeletedAt.is_null())
                        .exec(&tx)
                        .await?;
                }
                BatchAction::SetRate { rate } => {
                    let rate = validate_rate(rate)?;
                    proxy_node::Entity::update_many()
                        .set(proxy_node::ActiveModel {
                            rate: Set(rate),
                            updated_at: Set(now),
                            ..Default::default()
                        })
                        .filter(proxy_node::Column::Id.is_in(ids.clone()))
                        .filter(proxy_node::Column::DeletedAt.is_null())
                        .exec(&tx)
                        .await?;
                }
                BatchAction::SetVisibility {
                    visibility,
                    role_ids,
                } => {
                    proxy_node::Entity::update_many()
                        .set(proxy_node::ActiveModel {
                            visibility: Set(visibility.as_str().to_string()),
                            updated_at: Set(now),
                            ..Default::default()
                        })
                        .filter(proxy_node::Column::Id.is_in(ids.clone()))
                        .filter(proxy_node::Column::DeletedAt.is_null())
                        .exec(&tx)
                        .await?;
                    for &id in &ids {
                        sync_roles(&tx, id, visibility, &role_ids).await?;
                    }
                }
                BatchAction::Delete { .. } => unreachable!(),
            }
            tx.commit().await?;
            Ok(ids.len())
        }
    }
}

/// Default delete = Soft delete (moves node to Trash, stops running process on
/// next snapshot sync, hides from subscriptions, releases auto meter port).
pub async fn soft_delete_node(
    db: &DatabaseConnection,
    actor: Uuid,
    id: Uuid,
    cascade: bool,
) -> Result<()> {
    let tx = db.begin().await?;
    let existing = proxy_node::Entity::find_by_id(id)
        .filter(proxy_node::Column::DeletedAt.is_null())
        .one(&tx)
        .await?
        .ok_or(Error::NotFound)?;

    let active_relays: Vec<Uuid> = proxy_node::Entity::find()
        .filter(proxy_node::Column::ParentId.eq(id))
        .filter(proxy_node::Column::DeletedAt.is_null())
        .all(&tx)
        .await?
        .into_iter()
        .map(|n| n.id)
        .collect();
    if !active_relays.is_empty() && !cascade {
        return Err(Error::Conflict(problem::NODE_HAS_RELAYS));
    }

    let now = Utc::now();
    if !active_relays.is_empty() {
        proxy_node::Entity::update_many()
            .set(proxy_node::ActiveModel {
                deleted_at: Set(Some(now)),
                enabled: Set(false),
                show: Set(false),
                meter_port: Set(None),
                updated_at: Set(now),
                ..Default::default()
            })
            .filter(proxy_node::Column::Id.is_in(active_relays))
            .exec(&tx)
            .await?;
    }

    let name = existing.name.clone();
    let mut row: proxy_node::ActiveModel = existing.into();
    row.deleted_at = Set(Some(now));
    row.enabled = Set(false);
    row.show = Set(false);
    row.meter_port = Set(None);
    row.updated_at = Set(now);
    row.update(&tx).await?;

    tx.execute(sql(
        "DELETE FROM observed_instances WHERE node_id = $1",
        [id.into()],
    ))
    .await?;
    access::audit_subject(&tx, actor, "node.deleted", id, Some(&name)).await?;
    tx.commit().await?;
    Ok(())
}

/// Restore a soft-deleted node safely with `enabled = false, show = false`
/// so operators can review before publishing/starting it again.
pub async fn restore_node(
    db: &DatabaseConnection,
    actor: Uuid,
    id: Uuid,
) -> Result<ProxyNodeView> {
    let tx = db.begin().await?;
    let existing = proxy_node::Entity::find_by_id(id)
        .one(&tx)
        .await?
        .ok_or(Error::NotFound)?;
    if existing.deleted_at.is_none() {
        let view = decorate(&tx, vec![existing], true)
            .await?
            .into_iter()
            .next()
            .ok_or(Error::NotFound)?;
        tx.commit().await?;
        return Ok(view);
    }

    if let Some(sid) = existing.server_id {
        let active_server = server::Entity::find_by_id(sid)
            .filter(server::Column::DeletedAt.is_null())
            .one(&tx)
            .await?;
        if active_server.is_none() {
            return Err(Error::Conflict(problem::NODE_SERVER_DELETED));
        }
    }
    if let Some(pid) = existing.parent_id {
        let active_parent = proxy_node::Entity::find_by_id(pid)
            .filter(proxy_node::Column::DeletedAt.is_null())
            .one(&tx)
            .await?;
        if active_parent.is_none() {
            return Err(Error::Conflict(problem::NODE_PARENT_DELETED));
        }
    }

    let meter_port = if existing.mode == "managed"
        && existing.meter_enabled
        && existing.core.as_deref() != Some("mihomo")
        && let Some(sid) = existing.server_id
    {
        Some(allocate_meter_port(&tx, sid, None).await?)
    } else {
        None
    };

    let name = existing.name.clone();
    let mut row: proxy_node::ActiveModel = existing.into();
    row.deleted_at = Set(None);
    row.enabled = Set(false);
    row.show = Set(false);
    row.meter_port = Set(meter_port);
    row.updated_at = Set(Utc::now());
    let restored = row.update(&tx).await?;
    access::audit_subject(&tx, actor, "node.restored", id, Some(&name)).await?;

    let view = decorate(&tx, vec![restored], true)
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(view)
}

/// Manual permanent hard delete (only allowed for soft-deleted nodes in Trash).
pub async fn purge_node(db: &DatabaseConnection, actor: Uuid, id: Uuid) -> Result<()> {
    let tx = db.begin().await?;
    let existing = proxy_node::Entity::find_by_id(id)
        .one(&tx)
        .await?
        .ok_or(Error::NotFound)?;
    if existing.deleted_at.is_none() {
        return Err(Error::Conflict(problem::NODE_NOT_DELETED));
    }
    let name = existing.name.clone();
    proxy_node::Entity::delete_by_id(id).exec(&tx).await?;
    access::audit_subject(&tx, actor, "node.purged", id, Some(&name)).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn purge_trash(db: &DatabaseConnection, actor: Uuid) -> Result<u64> {
    let tx = db.begin().await?;
    let trashed = proxy_node::Entity::find()
        .filter(proxy_node::Column::DeletedAt.is_not_null())
        .all(&tx)
        .await?;
    let count = trashed.len() as u64;
    for row in trashed {
        proxy_node::Entity::delete_by_id(row.id).exec(&tx).await?;
        access::audit_subject(&tx, actor, "node.purged", row.id, Some(&row.name)).await?;
    }
    tx.commit().await?;
    Ok(count)
}

pub async fn restart_node(
    db: &DatabaseConnection,
    broker: &NodeBroker,
    id: Uuid,
) -> Result<()> {
    let row = proxy_node::Entity::find_by_id(id)
        .filter(proxy_node::Column::DeletedAt.is_null())
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    let Some(server_id) = row.server_id else {
        return Err(Error::BadRequest(problem::NODE_MODE_INVALID));
    };
    let srv = server::Entity::find_by_id(server_id)
        .filter(server::Column::DeletedAt.is_null())
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    if srv.session_id.is_none()
        || !broker.send(
            server_id,
            yuzuki_protocol::v1::BoardMessage::RestartInstance {
                instance_id: row.id,
            },
        )
    {
        return Err(Error::Conflict(problem::NODE_OFFLINE));
    }
    Ok(())
}
