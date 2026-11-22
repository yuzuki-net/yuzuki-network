use std::collections::{HashMap, HashSet};

use axum::http::{HeaderName, HeaderValue, header::CONTENT_DISPOSITION};
use chrono::{Duration, Utc};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DatabaseConnection, EntityTrait,
    FromQueryResult, QueryFilter, QueryOrder, Statement, TransactionTrait,
};
use serde::Serialize;
use uuid::Uuid;
use yuzuki_core_config::{
    Format,
    cores::{InfoNodePlacement, RenderOptions, universal},
    protocols::Endpoint,
};

use crate::{
    infra::{
        error::{Error, Result, problem},
        postgres::entities::{proxy_node, server},
    },
    services::{
        auth::valid_token,
        nodes::catalog,
        quotas::policy::Status as QuotaStatus,
        settings::{self, InfoNodePlacementSetting, Panel},
        subscriptions::{
            copy::{self, SubscriptionCopy},
            devices::{self, Device},
            links, policy,
            ports::{Document, SubscriptionRenderer},
        },
    },
};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SubscriberNode {
    pub id: Uuid,
    pub name: String,
    pub location: Option<String>,
    pub online: bool,
    pub protocols: Vec<String>,
    pub formats: [bool; 4],
    pub rate: f64,
    pub tags: Vec<String>,
}

pub async fn render(
    db: &DatabaseConnection,
    renderer: &dyn SubscriptionRenderer,
    token: &str,
    format: Format,
    device: Option<Device>,
) -> Result<Document> {
    if !valid_token(token) {
        return Err(Error::NotFound);
    }
    let tx = db.begin().await?;
    let access = links::resolve(&tx, token, format).await?;
    let user = access.account;
    let policy = policy::published(&tx).await?;
    let panel = settings::read(&tx, false).await?.panel;
    let active_devices = devices::count(&tx, user.id).await.unwrap_or(0);
    let access_id = user.access_id.to_string();
    let visible = visible_nodes_for(&tx, user.id, user.access_id, user.admin).await?;
    let mut used_tags = HashSet::new();
    for reserved in ["direct", "block", "local", "group", "DIRECT", "REJECT"] {
        used_tags.insert(reserved.to_owned());
    }

    let options = build_render_options(
        &panel,
        format,
        &user.email,
        &access.quota,
        active_devices,
        user.locale.as_deref(),
    );

    let mut document = if let Some(core) = format.core() {
        let mut outbounds = Vec::new();
        for resolved in visible {
            let tag = unique_node_tag(&resolved.node.name, resolved.node.id, &mut used_tags);
            if let Some(config) = resolved
                .endpoint
                .resolve(core, &tag, &access_id)
                .map_err(Error::Internal)?
            {
                outbounds.push(config);
            }
        }
        if outbounds.is_empty() && policy.requires_proxy() {
            return Err(Error::Conflict(problem::LINK_NO_ENDPOINTS));
        }
        renderer.render(core, &outbounds, &policy, &options)?
    } else {
        let mut uris = Vec::new();
        for resolved in visible {
            let tag = unique_node_tag(&resolved.node.name, resolved.node.id, &mut used_tags);
            if let Some(uri) = resolved
                .endpoint
                .resolve_uri(&tag, &access_id)
                .map_err(Error::Internal)?
            {
                uris.push(uri);
            }
        }
        if uris.is_empty() && policy.requires_proxy() {
            return Err(Error::Conflict(problem::LINK_NO_ENDPOINTS));
        }
        let body = universal::render_subscription(&uris, &options).into_bytes();
        Document {
            content_type: HeaderValue::from_static("text/plain; charset=utf-8"),
            headers: Vec::new(),
            body,
        }
    };

    document.headers =
        build_subscription_headers(&panel, &access.link_name, format, &access.quota);

    if let Some(device) = device {
        devices::bind(&tx, user.id, &device, access.quota.max_devices).await?;
        links::mark_download(&tx, access.link_id).await?;
    }
    tx.commit().await?;
    Ok(document)
}

fn unique_node_tag(name: &str, id: Uuid, used: &mut HashSet<String>) -> String {
    let cleaned: String = name
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .to_owned();
    let base = if cleaned.is_empty() {
        format!("node-{}", id.simple())
    } else {
        cleaned
    };

    let mut candidate = base.clone();
    let mut suffix = 2usize;
    while used.contains(&candidate) {
        candidate = format!("{base} #{suffix}");
        suffix += 1;
    }
    used.insert(candidate.clone());
    candidate
}

fn format_bytes(bytes: i128) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes.max(0) as f64;
    let mut idx = 0usize;
    while value >= 1024.0 && idx + 1 < UNITS.len() {
        value /= 1024.0;
        idx += 1;
    }
    if idx == 0 {
        format!("{:.0} {}", value, UNITS[idx])
    } else {
        format!("{value:.2} {}", UNITS[idx])
    }
}

fn build_render_options(
    panel: &Panel,
    format: Format,
    email: &str,
    quota: &QuotaStatus,
    active_devices: i64,
    account_locale: Option<&str>,
) -> RenderOptions {
    let cfg = &panel.subscription.info_nodes;
    let format_enabled = match format {
        Format::Xray => cfg.formats.xray,
        Format::SingBox => cfg.formats.sing_box,
        Format::Mihomo => cfg.formats.mihomo,
        Format::Universal => cfg.formats.universal,
    };
    if !cfg.enabled || !format_enabled {
        return RenderOptions::default();
    }
    let placement = match cfg.placement {
        InfoNodePlacementSetting::PrependToGroup => InfoNodePlacement::PrependToGroup,
        InfoNodePlacementSetting::AppendToGroup => InfoNodePlacement::AppendToGroup,
        InfoNodePlacementSetting::DedicatedGroup => InfoNodePlacement::DedicatedGroup,
    };
    let copy = copy::for_locale(account_locale, panel.workspace.default_locale.as_deref());
    let group_name = match cfg.group_name.trim() {
        "" | "group" => copy.group_name.as_str(),
        name => name,
    };
    RenderOptions {
        info_nodes: build_info_nodes(panel, email, quota, active_devices, copy),
        info_group_name: group_name.to_owned(),
        placement,
    }
}

fn build_info_nodes(
    panel: &Panel,
    email: &str,
    quota: &QuotaStatus,
    active_devices: i64,
    copy: &SubscriptionCopy,
) -> Vec<String> {
    let cfg = &panel.subscription.info_nodes;
    let used: i128 = quota.used_bytes.parse().unwrap_or(0).max(0);
    let total: Option<i128> = quota
        .quota_bytes
        .as_deref()
        .and_then(|s| s.parse::<i128>().ok())
        .map(|n| n.max(0));
    let remaining = total.map(|limit| (limit - used).max(0));
    let percent = match total {
        Some(limit) if limit > 0 => {
            format!("{:.1}%", ((used as f64 / limit as f64) * 100.0).min(100.0))
        }
        Some(_) => "100%".to_owned(),
        None => "0%".to_owned(),
    };

    let used_str = format_bytes(used);
    let total_str = total.map(format_bytes).unwrap_or_else(|| "∞".to_owned());
    let remaining_str = remaining
        .map(format_bytes)
        .unwrap_or_else(|| "∞".to_owned());
    let date_str = quota
        .window_ends_at
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| copy.no_expiry.clone());
    let recurring = quota
        .grants
        .iter()
        .any(|g| g.state == "active" && g.reset_mode == crate::services::quotas::policy::ResetMode::Cycle);
    let max_devices_str = quota
        .max_devices
        .map(|n| n.to_string())
        .unwrap_or_else(|| "∞".to_owned());
    let panel_url = panel.url.as_deref().unwrap_or("");

    let mut lines = Vec::new();
    if cfg.show_traffic {
        if total.is_some() {
            lines.push(
                copy.remaining_traffic
                    .replace("{remaining}", &remaining_str)
                    .replace("{total}", &total_str),
            );
        } else {
            lines.push(copy.used_traffic_unlimited.replace("{used}", &used_str));
        }
    }
    if cfg.show_expiry {
        let template = if quota.window_ends_at.is_none() {
            &copy.unlimited_validity
        } else if recurring {
            &copy.next_reset
        } else {
            &copy.expires
        };
        lines.push(template.replace("{date}", &date_str));
    }
    if cfg.show_website && !panel_url.is_empty() {
        lines.push(copy.website.replace("{url}", panel_url));
    }
    for template in &cfg.custom_templates {
        let rendered = template
            .replace("{used}", &used_str)
            .replace("{remaining}", &remaining_str)
            .replace("{total}", &total_str)
            .replace("{percent}", &percent)
            .replace("{expire_date}", &date_str)
            .replace("{reset_date}", &date_str)
            .replace("{devices}", &active_devices.max(0).to_string())
            .replace("{max_devices}", &max_devices_str)
            .replace("{panel_name}", &panel.name)
            .replace("{panel_url}", panel_url)
            .replace("{email}", email);
        let cleaned = rendered.trim();
        if !cleaned.is_empty() {
            lines.push(cleaned.to_owned());
        }
    }
    lines
}

fn percent_encode_utf8(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn build_subscription_headers(
    panel: &Panel,
    link_name: &str,
    format: Format,
    quota: &QuotaStatus,
) -> Vec<(HeaderName, HeaderValue)> {
    let mut headers = Vec::new();
    let sub = &panel.subscription;

    if sub.include_userinfo_header {
        let used: i64 = quota.used_bytes.parse().unwrap_or(0).max(0);
        let mut parts = vec![format!("upload=0; download={used}")];
        if let Some(total) = quota
            .quota_bytes
            .as_deref()
            .and_then(|s| s.parse::<i64>().ok())
        {
            parts.push(format!("total={}", total.max(0)));
        }
        if let Some(ends_at) = quota.window_ends_at {
            parts.push(format!("expire={}", ends_at.timestamp().max(0)));
        }
        if let Ok(value) = HeaderValue::from_str(&parts.join("; ")) {
            headers.push((HeaderName::from_static("subscription-userinfo"), value));
        }
    }

    if let Ok(value) = HeaderValue::from_str(&sub.profile_update_interval_hours.to_string()) {
        headers.push((HeaderName::from_static("profile-update-interval"), value));
    }

    if let Some(url) = panel.url.as_deref()
        && let Ok(value) = HeaderValue::from_str(url)
    {
        headers.push((HeaderName::from_static("profile-web-page-url"), value));
    }

    if sub.include_filename_header {
        let ext = match format {
            Format::Mihomo => "yaml",
            Format::Xray | Format::SingBox => "json",
            Format::Universal => "txt",
        };
        let display_title = if !panel.name.trim().is_empty() {
            panel.name.trim()
        } else if !link_name.trim().is_empty() {
            link_name.trim()
        } else {
            "subscription"
        };
        let encoded = percent_encode_utf8(&format!("{display_title}.{ext}"));
        let disposition =
            format!("attachment; filename=\"subscription.{ext}\"; filename*=UTF-8''{encoded}");
        if let Ok(value) = HeaderValue::from_str(&disposition) {
            headers.push((CONTENT_DISPOSITION, value));
        }
    }

    headers
}

pub async fn availability(
    db: &impl ConnectionTrait,
    account_id: Uuid,
    access_id: Uuid,
    is_admin: bool,
) -> Result<([usize; 4], bool)> {
    let mut counts = [0; 4];
    for resolved in visible_nodes_for(db, account_id, access_id, is_admin).await? {
        for (count, supported) in counts.iter_mut().zip(resolved.endpoint.compatible_formats()) {
            *count += usize::from(supported);
        }
    }
    let requires_proxy = policy::published(db).await?.requires_proxy();
    Ok((counts, requires_proxy))
}

pub async fn published_nodes(
    db: &impl ConnectionTrait,
    account_id: Uuid,
    access_id: Uuid,
    is_admin: bool,
) -> Result<Vec<SubscriberNode>> {
    let resolved = visible_nodes_for(db, account_id, access_id, is_admin).await?;
    let now = Utc::now();
    let mut out = Vec::with_capacity(resolved.len());
    for item in resolved {
        let formats = item.endpoint.compatible_formats();
        let protocol = item
            .endpoint
            .portable
            .as_ref()
            .and_then(|p| serde_json::to_value(p.protocol).ok())
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "native".to_owned());
        let online = match item.server {
            None => true, // External static node
            Some(ref srv) => {
                srv.deleted_at.is_none()
                    && srv.session_id.is_some()
                    && srv
                        .last_seen_at
                        .is_some_and(|seen| now.signed_duration_since(seen) <= Duration::seconds(60))
            }
        };
        out.push(SubscriberNode {
            id: item.node.id,
            name: item.node.name,
            location: item.location,
            online,
            protocols: vec![protocol],
            formats,
            rate: item.effective_rate,
            tags: item.node.tags,
        });
    }
    Ok(out)
}

struct ResolvedVisibleNode {
    node: proxy_node::Model,
    endpoint: Endpoint,
    server: Option<server::Model>,
    location: Option<String>,
    effective_rate: f64,
}

#[derive(FromQueryResult)]
struct IdRow {
    id: Uuid,
}

async fn visible_nodes_for(
    db: &impl ConnectionTrait,
    account_id: Uuid,
    access_id: Uuid,
    is_admin: bool,
) -> Result<Vec<ResolvedVisibleNode>> {
    // Select IDs of visible proxy nodes authorized for this account, ordered by sort_order.
    let id_rows = IdRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT n.id
         FROM proxy_nodes n
         LEFT JOIN proxy_nodes p ON p.id = n.parent_id AND p.deleted_at IS NULL
         LEFT JOIN servers s ON s.id = COALESCE(n.server_id, p.server_id) AND s.deleted_at IS NULL
         WHERE n.deleted_at IS NULL
           AND n.show = true
           AND n.enabled = true
           AND (
                n.mode = 'external'
                OR (n.mode IN ('managed', 'custom') AND s.id IS NOT NULL)
                OR (n.mode = 'relay' AND p.id IS NOT NULL AND p.enabled = true AND s.id IS NOT NULL)
           )
           AND (
                n.meter_config->>'kind' IS DISTINCT FROM 'dedicated_traffic'
                OR n.meter_config->>'access_id' = $2
           )
           AND (
                $3::boolean = true
                OR n.visibility = 'all'
                OR EXISTS (
                    SELECT 1 FROM proxy_node_roles pnr
                    JOIN account_roles ar ON ar.role_id = pnr.role_id
                    WHERE pnr.node_id = n.id AND ar.account_id = $1
                )
           )
         ORDER BY n.sort_order ASC, n.created_at ASC, n.id ASC",
        [
            account_id.into(),
            access_id.to_string().into(),
            is_admin.into(),
        ],
    ))
    .all(db)
    .await?;

    if id_rows.is_empty() {
        return Ok(Vec::new());
    }
    let ordered_ids: Vec<Uuid> = id_rows.into_iter().map(|r| r.id).collect();
    let nodes: HashMap<Uuid, proxy_node::Model> = proxy_node::Entity::find()
        .filter(proxy_node::Column::Id.is_in(ordered_ids.clone()))
        .all(db)
        .await?
        .into_iter()
        .map(|n| (n.id, n))
        .collect();

    let parent_ids: Vec<Uuid> = nodes.values().filter_map(|n| n.parent_id).collect();
    let parents: HashMap<Uuid, proxy_node::Model> = if parent_ids.is_empty() {
        HashMap::new()
    } else {
        proxy_node::Entity::find()
            .filter(proxy_node::Column::Id.is_in(parent_ids))
            .all(db)
            .await?
            .into_iter()
            .map(|p| (p.id, p))
            .collect()
    };

    let server_ids: Vec<Uuid> = nodes
        .values()
        .filter_map(|n| {
            n.server_id
                .or_else(|| n.parent_id.and_then(|pid| parents.get(&pid)?.server_id))
        })
        .collect();
    let servers: HashMap<Uuid, server::Model> = if server_ids.is_empty() {
        HashMap::new()
    } else {
        server::Entity::find()
            .filter(server::Column::Id.is_in(server_ids.clone()))
            .order_by_asc(server::Column::Id)
            .all(db)
            .await?
            .into_iter()
            .map(|s| (s.id, s))
            .collect()
    };

    let mut locations: HashMap<Uuid, String> = HashMap::new();
    if !server_ids.is_empty() {
        let loc_rows = db
            .query_all(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT server_id, label FROM server_locations
                 WHERE server_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))",
                [serde_json::json!(server_ids).into()],
            ))
            .await?;
        for r in loc_rows {
            locations.insert(r.try_get("", "server_id")?, r.try_get("", "label")?);
        }
    }

    let mut resolved = Vec::new();
    for id in ordered_ids {
        let Some(node) = nodes.get(&id).cloned() else {
            continue;
        };
        let parent = node.parent_id.and_then(|pid| parents.get(&pid));
        let Some(endpoint) = catalog::resolve_client_endpoint(&node, parent)? else {
            continue;
        };
        let sid = node
            .server_id
            .or_else(|| parent.and_then(|p| p.server_id));
        let srv = sid.and_then(|s| servers.get(&s).cloned());
        let location = sid.and_then(|s| locations.get(&s).cloned());
        let effective_rate = if node.mode == "relay" {
            parent.map(|p| p.rate).unwrap_or(node.rate)
        } else {
            node.rate
        };
        resolved.push(ResolvedVisibleNode {
            node,
            endpoint,
            server: srv,
            location,
            effective_rate,
        });
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, TimeZone};

    use crate::services::quotas::policy::{DurationKind, LinkLimits, QuotaGrant, ResetMode};

    use super::*;

    fn sample_quota(
        quota_bytes: Option<&str>,
        used_bytes: &str,
        recurring: bool,
        ends: Option<DateTime<Utc>>,
    ) -> QuotaStatus {
        let grant = ends.map(|dt| QuotaGrant {
            id: Uuid::new_v4(),
            account_id: Uuid::new_v4(),
            plan_id: None,
            name: "Monthly".into(),
            quota_bytes: quota_bytes.map(str::to_owned),
            used_bytes: used_bytes.to_owned(),
            remaining_bytes: None,
            duration_kind: DurationKind::Days,
            duration_value: Some(30),
            reset_mode: if recurring {
                ResetMode::Cycle
            } else {
                ResetMode::None
            },
            anchor_at: dt - Duration::days(30),
            cycle_index: 0,
            starts_at: dt - Duration::days(30),
            cycle_starts_at: dt - Duration::days(30),
            cycle_ends_at: Some(dt),
            expires_at: (!recurring).then_some(dt),
            max_devices: Some(5),
            priority: 0,
            revoked: false,
            state: "active".into(),
            created_at: dt - Duration::days(30),
        });
        QuotaStatus {
            quota_bytes: quota_bytes.map(str::to_owned),
            used_bytes: used_bytes.to_owned(),
            remaining_bytes: None,
            lifetime_used_bytes: used_bytes.to_owned(),
            eligible: true,
            state: "available".to_owned(),
            window_starts_at: ends.map(|dt| dt - Duration::days(30)),
            window_ends_at: ends,
            max_devices: Some(5),
            override_max_devices: None,
            link_limits: LinkLimits::default(),
            grants: grant.into_iter().collect(),
        }
    }

    #[test]
    fn unique_node_tag_deduplicates_cleanly() {
        let mut used = HashSet::new();
        let id = Uuid::new_v4();
        assert_eq!(unique_node_tag("Tokyo 01 · VLESS", id, &mut used), "Tokyo 01 · VLESS");
        assert_eq!(unique_node_tag("Tokyo 01 · VLESS", id, &mut used), "Tokyo 01 · VLESS #2");
    }

    #[test]
    fn builds_userinfo_headers_and_dynamic_info_nodes() {
        let mut panel = Panel::defaults(false);
        panel.name = "柚月网络".into();
        panel.url = Some("https://yuzuki.example.com".into());
        panel.subscription.info_nodes.custom_templates = vec![
            "👤 {email} · 设备 {devices}/{max_devices}".into(),
            "📈 已用 {percent}".into(),
        ];
        let ends = Utc.with_ymd_and_hms(2026, 12, 31, 0, 0, 0).unwrap();
        let quota = sample_quota(
            Some(&(100i64 * 1024 * 1024 * 1024).to_string()),
            &(25i64 * 1024 * 1024 * 1024).to_string(),
            true,
            Some(ends),
        );

        let nodes = build_info_nodes(
            &panel,
            "alice@example.com",
            &quota,
            2,
            copy::for_locale(Some("zh-CN"), None),
        );
        assert_eq!(nodes[0], "📊 剩余流量：75.00 GB / 100.00 GB");
        assert_eq!(nodes[1], "📅 下次重置：2026-12-31");
        assert_eq!(nodes[2], "🌐 官网：https://yuzuki.example.com");
        assert_eq!(nodes[3], "👤 alice@example.com · 设备 2/5");
        assert_eq!(nodes[4], "📈 已用 25.0%");

        let headers = build_subscription_headers(&panel, "Clash", Format::Mihomo, &quota);
        let map: HashMap<String, String> = headers
            .into_iter()
            .map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap().to_owned()))
            .collect();
        assert_eq!(
            map.get("subscription-userinfo").map(String::as_str),
            Some("upload=0; download=26843545600; total=107374182400; expire=1798675200")
        );
        assert_eq!(map.get("profile-update-interval").map(String::as_str), Some("24"));
        assert!(map["content-disposition"].contains("filename*=UTF-8''"));

        for format in Format::ALL {
            let options = build_render_options(&panel, format, "a@b.c", &quota, 0, None);
            assert_eq!(
                options.info_nodes[0],
                "📊 Remaining traffic: 75.00 GB / 100.00 GB"
            );
            assert_eq!(options.info_group_name, "📊 Subscription info");
        }
    }

    #[test]
    fn localizes_default_titles_and_template_values_but_keeps_custom_copy() {
        let mut panel = Panel::defaults(false);
        panel.workspace.default_locale = Some("ru".into());
        panel.subscription.info_nodes.custom_templates = vec!["Plan: {expire_date}".into()];
        let quota = sample_quota(None, "0", false, None);

        let site = build_render_options(&panel, Format::Mihomo, "a@b.c", &quota, 0, None);
        assert_eq!(site.info_group_name, "📊 Информация о подписке");
        assert_eq!(
            site.info_nodes,
            [
                "📊 Использовано трафика: 0 B · Без лимита",
                "📅 Срок действия: Бессрочно",
                "Plan: Бессрочно",
            ]
        );

        let user = build_render_options(&panel, Format::Mihomo, "a@b.c", &quota, 0, Some("ja"));
        assert_eq!(user.info_group_name, "📊 サブスクリプション情報");
        assert_eq!(user.info_nodes[2], "Plan: 期限なし");

        panel.subscription.info_nodes.group_name = "My subscriptions".into();
        let custom = build_render_options(&panel, Format::Mihomo, "a@b.c", &quota, 0, Some("ja"));
        assert_eq!(custom.info_group_name, "My subscriptions");
    }
}
