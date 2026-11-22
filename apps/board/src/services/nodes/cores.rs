use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{BoardMessage, Capability, CoreAction, CoreActionRequest, CoreActionStage, HostInfo},
};

use crate::{
    infra::{
        error::{Error, Result, problem},
        postgres::entities::{server, server_core_task},
    },
    services::nodes::{broker::NodeBroker, sessions},
};

const CORES_TOML: &str = include_str!("../../../../../config/cores.toml");

#[derive(Deserialize)]
struct CoresToml {
    versions: BTreeMap<String, String>,
    listener_templates: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CoreCatalogItem {
    pub core: Core,
    pub recommended_version: String,
    pub listener_protocols: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CoreCatalog {
    pub cores: Vec<CoreCatalogItem>,
}

pub fn catalog() -> CoreCatalog {
    let parsed: CoresToml = toml::from_str(CORES_TOML).expect("embedded config/cores.toml is valid");
    let cores = Core::ALL
        .into_iter()
        .map(|core| {
            let key = core.id();
            CoreCatalogItem {
                core,
                recommended_version: parsed.versions.get(key).cloned().unwrap_or_default(),
                listener_protocols: parsed
                    .listener_templates
                    .get(key)
                    .cloned()
                    .unwrap_or_default(),
            }
        })
        .collect();
    CoreCatalog { cores }
}

pub fn recommended_version(core: Core) -> String {
    catalog()
        .cores
        .into_iter()
        .find(|item| item.core == core)
        .map(|item| item.recommended_version)
        .unwrap_or_default()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstallCoreInput {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub download_url: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Serialize)]
pub struct CoreTaskView {
    pub id: Uuid,
    pub server_id: Uuid,
    pub core: Option<String>,
    pub action: String,
    pub target_version: Option<String>,
    pub download_url: Option<String>,
    pub stage: String,
    pub status: String,
    pub message: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<server_core_task::Model> for CoreTaskView {
    fn from(row: server_core_task::Model) -> Self {
        Self {
            id: row.id,
            server_id: row.server_id,
            core: row.core,
            action: row.action,
            target_version: row.target_version,
            download_url: row.download_url,
            stage: row.stage,
            status: row.status,
            message: row.message,
            error: row.error,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

pub fn parse_core(raw: &str) -> Result<Core> {
    raw.parse::<Core>()
        .map_err(|_| Error::BadRequest(problem::NODE_CORE_INVALID))
}

pub async fn list_tasks(db: &DatabaseConnection, server_id: Uuid) -> Result<Vec<CoreTaskView>> {
    server::Entity::find_by_id(server_id)
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    let rows = server_core_task::Entity::find()
        .filter(server_core_task::Column::ServerId.eq(server_id))
        .order_by_desc(server_core_task::Column::CreatedAt)
        .limit(25)
        .all(db)
        .await?;
    Ok(rows.into_iter().map(CoreTaskView::from).collect())
}

async fn ensure_server_ready(
    db: &DatabaseConnection,
    broker: &NodeBroker,
    server_id: Uuid,
    require_management: bool,
) -> Result<server::Model> {
    let row = server::Entity::find_by_id(server_id)
        .filter(server::Column::DeletedAt.is_null())
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    if row.session_id.is_none() || !broker.is_connected(server_id) {
        return Err(Error::Conflict(problem::NODE_OFFLINE));
    }
    if require_management
        && let Some(host_json) = &row.host_info
        && let Ok(host) = serde_json::from_value::<HostInfo>(host_json.clone())
        && !host.core_management
    {
        return Err(Error::Conflict(problem::NODE_CORE_MANAGEMENT_DISABLED));
    }
    Ok(row)
}

async fn ensure_no_active_task(
    db: &DatabaseConnection,
    server_id: Uuid,
    core: Option<Core>,
) -> Result<()> {
    let cutoff = Utc::now() - Duration::minutes(10);
    let mut query = server_core_task::Entity::find()
        .filter(server_core_task::Column::ServerId.eq(server_id))
        .filter(server_core_task::Column::Status.is_in(["pending", "running"]))
        .filter(server_core_task::Column::UpdatedAt.gt(cutoff));
    if let Some(core) = core {
        query = query.filter(server_core_task::Column::Core.eq(core.id()));
    } else {
        query = query.filter(server_core_task::Column::Action.eq("probe"));
    }
    if query.one(db).await?.is_some() {
        return Err(Error::Conflict(problem::NODE_CORE_TASK_ACTIVE));
    }
    Ok(())
}

pub async fn install_core(
    db: &DatabaseConnection,
    broker: &NodeBroker,
    server_id: Uuid,
    core: Core,
    input: InstallCoreInput,
) -> Result<CoreTaskView> {
    ensure_server_ready(db, broker, server_id, true).await?;
    ensure_no_active_task(db, server_id, Some(core)).await?;

    let download_url = input
        .download_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(url) = &download_url {
        let valid = url.len() <= 512
            && (url.starts_with("https://") || url.starts_with("http://"))
            && !url.chars().any(|c| c.is_whitespace() || c.is_control());
        if !valid {
            return Err(Error::BadRequest(problem::NODE_CORE_URL));
        }
    }

    let version = match input.version.map(|s| s.trim().trim_start_matches('v').to_string()) {
        Some(v) if !v.is_empty() => v,
        _ => recommended_version(core),
    };
    if download_url.is_none()
        && (version.is_empty()
            || version.len() > 64
            || !version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')))
    {
        return Err(Error::BadRequest(problem::NODE_CORE_VERSION));
    }

    let sha256 = input
        .sha256
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    if let Some(hash) = &sha256
        && (hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(Error::BadRequest(problem::NODE_CORE_SHA256));
    }

    let now = Utc::now();
    let task_id = Uuid::new_v4();
    let row = server_core_task::ActiveModel {
        id: Set(task_id),
        server_id: Set(server_id),
        core: Set(Some(core.id().to_string())),
        action: Set("install".to_string()),
        target_version: Set((!version.is_empty()).then_some(version.clone())),
        download_url: Set(download_url.clone()),
        stage: Set("queued".to_string()),
        status: Set("pending".to_string()),
        message: Set(Some(format!("Queued installation of {}", core.id()))),
        error: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(db)
    .await?;

    let dispatched = broker.send(
        server_id,
        BoardMessage::CoreAction(CoreActionRequest {
            request_id: task_id,
            core: Some(core),
            action: CoreAction::Install {
                version,
                download_url,
                sha256,
            },
        }),
    );
    if !dispatched {
        mark_dispatch_failed(db, task_id).await?;
        return Err(Error::Conflict(problem::NODE_OFFLINE));
    }

    Ok(CoreTaskView::from(row))
}

pub async fn remove_core(
    db: &DatabaseConnection,
    broker: &NodeBroker,
    server_id: Uuid,
    core: Core,
) -> Result<CoreTaskView> {
    ensure_server_ready(db, broker, server_id, true).await?;
    ensure_no_active_task(db, server_id, Some(core)).await?;

    let now = Utc::now();
    let task_id = Uuid::new_v4();
    let row = server_core_task::ActiveModel {
        id: Set(task_id),
        server_id: Set(server_id),
        core: Set(Some(core.id().to_string())),
        action: Set("remove".to_string()),
        target_version: Set(None),
        download_url: Set(None),
        stage: Set("queued".to_string()),
        status: Set("pending".to_string()),
        message: Set(Some(format!("Queued removal of {}", core.id()))),
        error: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(db)
    .await?;

    let dispatched = broker.send(
        server_id,
        BoardMessage::CoreAction(CoreActionRequest {
            request_id: task_id,
            core: Some(core),
            action: CoreAction::Remove,
        }),
    );
    if !dispatched {
        mark_dispatch_failed(db, task_id).await?;
        return Err(Error::Conflict(problem::NODE_OFFLINE));
    }

    Ok(CoreTaskView::from(row))
}

pub async fn probe_cores(
    db: &DatabaseConnection,
    broker: &NodeBroker,
    server_id: Uuid,
) -> Result<CoreTaskView> {
    ensure_server_ready(db, broker, server_id, false).await?;
    ensure_no_active_task(db, server_id, None).await?;

    let now = Utc::now();
    let task_id = Uuid::new_v4();
    let row = server_core_task::ActiveModel {
        id: Set(task_id),
        server_id: Set(server_id),
        core: Set(None),
        action: Set("probe".to_string()),
        target_version: Set(None),
        download_url: Set(None),
        stage: Set("queued".to_string()),
        status: Set("pending".to_string()),
        message: Set(Some("Queued core probe".to_string())),
        error: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(db)
    .await?;

    let dispatched = broker.send(
        server_id,
        BoardMessage::CoreAction(CoreActionRequest {
            request_id: task_id,
            core: None,
            action: CoreAction::Probe,
        }),
    );
    if !dispatched {
        mark_dispatch_failed(db, task_id).await?;
        return Err(Error::Conflict(problem::NODE_OFFLINE));
    }

    Ok(CoreTaskView::from(row))
}

async fn mark_dispatch_failed(db: &DatabaseConnection, task_id: Uuid) -> Result<()> {
    server_core_task::Entity::update_many()
        .set(server_core_task::ActiveModel {
            stage: Set("failed".to_string()),
            status: Set("failed".to_string()),
            error: Set(Some(
                "Server agent disconnected before receiving the command".into(),
            )),
            updated_at: Set(Utc::now()),
            ..Default::default()
        })
        .filter(server_core_task::Column::Id.eq(task_id))
        .exec(db)
        .await?;
    Ok(())
}

fn stage_label(stage: CoreActionStage) -> &'static str {
    match stage {
        CoreActionStage::Queued => "queued",
        CoreActionStage::Downloading => "downloading",
        CoreActionStage::Verifying => "verifying",
        CoreActionStage::Extracting => "extracting",
        CoreActionStage::Testing => "testing",
        CoreActionStage::Installing => "installing",
        CoreActionStage::Removing => "removing",
        CoreActionStage::Probing => "probing",
        CoreActionStage::Completed => "completed",
        CoreActionStage::Failed => "failed",
    }
}

fn clean_text(raw: &str, max_len: usize) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(max_len)
        .collect()
}

pub async fn record_progress(
    db: &DatabaseConnection,
    server_id: Uuid,
    request_id: Uuid,
    stage: CoreActionStage,
    message: String,
) -> Result<()> {
    server_core_task::Entity::update_many()
        .set(server_core_task::ActiveModel {
            stage: Set(stage_label(stage).to_string()),
            status: Set("running".to_string()),
            message: Set(Some(clean_text(&message, 240))),
            updated_at: Set(Utc::now()),
            ..Default::default()
        })
        .filter(server_core_task::Column::Id.eq(request_id))
        .filter(server_core_task::Column::ServerId.eq(server_id))
        .exec(db)
        .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn record_result(
    db: &DatabaseConnection,
    server_id: Uuid,
    session_id: Uuid,
    request_id: Uuid,
    ok: bool,
    version: Option<String>,
    error: Option<String>,
    capabilities: Vec<Capability>,
    host: HostInfo,
) -> Result<()> {
    let status = if ok { "succeeded" } else { "failed" };
    let stage = if ok { "completed" } else { "failed" };
    let message = if ok {
        version
            .as_deref()
            .map(|v| format!("Ready: {}", clean_text(v, 160)))
            .or_else(|| Some("Completed".into()))
    } else {
        None
    };
    let error = error.map(|e| clean_text(&e, 400));

    server_core_task::Entity::update_many()
        .set(server_core_task::ActiveModel {
            stage: Set(stage.to_string()),
            status: Set(status.to_string()),
            message: Set(message),
            error: Set(error),
            updated_at: Set(Utc::now()),
            ..Default::default()
        })
        .filter(server_core_task::Column::Id.eq(request_id))
        .filter(server_core_task::Column::ServerId.eq(server_id))
        .exec(db)
        .await?;

    sessions::update_capabilities(db, server_id, session_id, capabilities, Some(host), ok).await?;
    Ok(())
}
