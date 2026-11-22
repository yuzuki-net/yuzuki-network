use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header::SET_COOKIE},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use board::{
    app::{self, State},
    infra::{config::Settings, migration, postgres},
    services::{
        accounts,
        nodes::{cores, deployment, inventory, sessions},
    },
};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{
        BoardMessage, Capability, CoreAction, CoreActionStage, CoreSource, HostInfo, UsageBatch,
        UsageEvent,
    },
};

const PASSWORD: &str = "test-login-password";

#[test]
fn core_catalog_and_broker_session_fencing_work_without_database() {
    let catalog = cores::catalog();
    assert_eq!(catalog.cores.len(), 3);
    assert!(catalog.cores.iter().all(|c| !c.recommended_version.is_empty()));
    assert_eq!(cores::parse_core("xray").unwrap(), Core::Xray);
    assert_eq!(cores::parse_core("sing-box").unwrap(), Core::SingBox);
    assert_eq!(cores::parse_core("mihomo").unwrap(), Core::Mihomo);
    assert!(cores::parse_core("unknown").is_err());

    let broker = board::services::nodes::broker::NodeBroker::default();
    let server_id = Uuid::new_v4();
    let s1 = Uuid::new_v4();
    let s2 = Uuid::new_v4();
    assert!(!broker.is_connected(server_id));

    let mut rx1 = broker.register(server_id, s1);
    assert!(broker.is_connected(server_id));

    // New session fences the previous one and asks it to disconnect cleanly.
    let mut rx2 = broker.register(server_id, s2);
    assert!(matches!(
        rx1.try_recv().unwrap(),
        BoardMessage::Disconnect { .. }
    ));
    broker.unregister(server_id, s1);
    assert!(broker.is_connected(server_id));

    let instance_id = Uuid::new_v4();
    assert!(broker.send(server_id, BoardMessage::RestartInstance { instance_id }));
    assert!(matches!(
        rx2.try_recv().unwrap(),
        BoardMessage::RestartInstance { instance_id: got } if got == instance_id
    ));

    broker.disconnect(server_id, "server deleted");
    assert!(!broker.is_connected(server_id));
    assert!(matches!(
        rx2.try_recv().unwrap(),
        BoardMessage::Disconnect { .. }
    ));
}

#[tokio::test]
async fn servers_proxy_nodes_soft_hard_delete_and_remote_cores_lifecycle() {
    let Ok(url) = std::env::var("YUZUKI_TEST_DATABASE_URL") else {
        return;
    };
    let db = postgres::connect(&url).await.unwrap();
    migration::run(&db).await.unwrap();
    let app = State::new(
        db,
        Settings {
            secure_cookies: false,
            ..Settings::default()
        },
    )
    .await
    .unwrap();
    let router = app::router(app.clone());
    let admin = accounts::create(
        &app.db,
        &app.auth,
        format!("core-admin.{}@example.net", Uuid::new_v4()),
        PASSWORD.into(),
        true,
        true,
    )
    .await
    .unwrap();
    let cookie = login(&router, &admin.email, PASSWORD).await;

    // 1. Core catalog lists all 3 cores with baseline versions.
    let catalog = data(
        &router,
        "GET",
        "/api/v1/admin/servers/cores/catalog",
        &cookie,
        None,
    )
    .await;
    assert_eq!(catalog["cores"].as_array().unwrap().len(), 3);

    // 2. Create server and verify offline server rejects remote install with NODE_OFFLINE.
    let srv = data(
        &router,
        "POST",
        "/api/v1/admin/servers",
        &cookie,
        Some(json!({
            "name": "Tokyo Edge 01",
            "remark": "Primary JP host",
            "default_host": "jp01.example.net"
        })),
    )
    .await;
    let server_id = Uuid::parse_str(srv["id"].as_str().unwrap()).unwrap();
    let (status, _, body) = call(
        &router,
        "POST",
        &format!("/api/v1/admin/servers/{server_id}/cores/xray/install"),
        Some(&cookie),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["code"],
        "NODE_OFFLINE"
    );

    // 3. Enroll & connect server with config warnings and zero initial cores.
    let token = inventory::enroll_token(&app.db, server_id).await.unwrap();
    let fingerprint = format!("fp-{}", Uuid::new_v4());
    let digest = board::services::auth::token_hash(&token).unwrap();
    sessions::enroll(
        &app.db,
        digest,
        sessions::Identity {
            fingerprint: fingerprint.clone(),
            expires_at: Utc::now() + Duration::hours(24),
        },
    )
    .await
    .unwrap();
    let host = HostInfo {
        os: "linux".into(),
        arch: "amd64".into(),
        core_management: true,
    };
    let session_id = sessions::claim(
        &app.db,
        server_id,
        &fingerprint,
        vec![],
        Some(host.clone()),
        vec!["Ignored unknown key `legacy` in node.toml".into()],
    )
    .await
    .unwrap();
    let mut rx = app.broker.register(server_id, session_id);

    // 4. Remote install xray-core and simulate progress + result.
    let (status, _, body) = call(
        &router,
        "POST",
        &format!("/api/v1/admin/servers/{server_id}/cores/xray/install"),
        Some(&cookie),
        Some(json!({"version": "26.11.9"})),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let task: Value = serde_json::from_slice(&body).unwrap();
    let task_id = Uuid::parse_str(task["id"].as_str().unwrap()).unwrap();
    assert!(matches!(
        rx.try_recv().unwrap(),
        BoardMessage::CoreAction(req) if req.request_id == task_id && matches!(req.action, CoreAction::Install { .. })
    ));

    cores::record_progress(
        &app.db,
        server_id,
        task_id,
        CoreActionStage::Downloading,
        "Downloading xray".into(),
    )
    .await
    .unwrap();
    cores::record_result(
        &app.db,
        server_id,
        session_id,
        task_id,
        true,
        Some("Xray 26.11.9".into()),
        None,
        vec![Capability {
            core: Core::Xray,
            version: "Xray 26.11.9".into(),
            source: CoreSource::Managed,
            path: Some("/var/lib/yuzuki-node/cores/xray/xray".into()),
        }],
        host,
    )
    .await
    .unwrap();

    let servers = data(&router, "GET", "/api/v1/admin/servers", &cookie, None).await;
    let found = servers
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == srv["id"])
        .unwrap();
    assert_eq!(
        found["config_warnings"][0],
        "Ignored unknown key `legacy` in node.toml"
    );
    assert_eq!(found["capabilities"][0]["core"], "xray");

    // 5. Create a managed VLESS+REALITY node — backend auto-assigns meter_port & compiles server config!
    let priv_key = URL_SAFE_NO_PAD.encode([11u8; 32]);
    let pub_key = URL_SAFE_NO_PAD.encode([22u8; 32]);
    let node = data(
        &router,
        "POST",
        "/api/v1/admin/nodes",
        &cookie,
        Some(json!({
            "name": "Tokyo 01 · Reality",
            "mode": "managed",
            "server_id": server_id,
            "core": "xray",
            "enabled": true,
            "show": true,
            "sort_order": 1,
            "rate": 1.5,
            "tags": ["JP", "Reality"],
            "visibility": "all",
            "host": "jp01.example.net",
            "port": 443,
            "listen_port": 443,
            "meter_enabled": true,
            "protocol_config": {
                "protocol": "vless",
                "server_name": "www.microsoft.com",
                "flow": "xtls-rprx-vision",
                "reality": {
                    "private_key": priv_key,
                    "public_key": pub_key,
                    "short_id": "a1b2c3d4",
                    "fingerprint": "chrome"
                }
            }
        })),
    )
    .await;
    let node_id = Uuid::parse_str(node["id"].as_str().unwrap()).unwrap();
    assert!(node["meter_port"].as_i64().unwrap() >= 20001);
    assert_eq!(node["formats"], json!([true, true, true, true]));

    // Verify desired snapshot compiles valid xray inbound + auto UserStats metering!
    let snap = deployment::desired(&app.db, server_id, &fingerprint, session_id)
        .await
        .unwrap();
    assert_eq!(snap.instances.len(), 1);
    assert_eq!(snap.instances[0].id, node_id);
    assert!(snap.instances[0].meter.is_some());

    // Port conflict detection on same server + listen_port 443
    let (status, _, body) = call(
        &router,
        "POST",
        "/api/v1/admin/nodes",
        Some(&cookie),
        Some(json!({
            "name": "Duplicate Port",
            "mode": "managed",
            "server_id": server_id,
            "core": "xray",
            "enabled": true,
            "host": "jp01.example.net",
            "port": 443,
            "listen_port": 443,
            "protocol_config": {
                "protocol": "vless",
                "server_name": "www.microsoft.com",
                "flow": "xtls-rprx-vision",
                "reality": {
                    "private_key": priv_key,
                    "public_key": pub_key,
                    "short_id": "a1b2c3d4",
                    "fingerprint": "chrome"
                }
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["code"],
        "NODE_PORT_CONFLICT"
    );

    // 6. Create Relay node pointing to managed node, plus Clone node.
    let relay = data(
        &router,
        "POST",
        "/api/v1/admin/nodes",
        &cookie,
        Some(json!({
            "name": "SH IEPL -> Tokyo",
            "mode": "relay",
            "parent_id": node_id,
            "enabled": true,
            "show": true,
            "sort_order": 0,
            "host": "iepl-sh.example.net",
            "port": 10443,
            "tags": ["IEPL"]
        })),
    )
    .await;
    let relay_id = Uuid::parse_str(relay["id"].as_str().unwrap()).unwrap();
    assert_eq!(relay["formats"], json!([true, true, true, true]));
    assert_eq!(relay["effective_rate"], 1.5);

    let cloned = data(
        &router,
        "POST",
        &format!("/api/v1/admin/nodes/{node_id}/clone"),
        &cookie,
        None,
    )
    .await;
    assert_eq!(cloned["enabled"], false);
    assert_ne!(cloned["listen_port"], 443);

    // Record usage against the node BEFORE deleting — soft & hard delete must still succeed!
    app.ledger
        .record(
            server_id,
            session_id,
            UsageBatch {
                events: vec![UsageEvent {
                    event_id: Uuid::new_v4(),
                    instance_id: node_id,
                    access_id: admin.access_id,
                    uploaded: 100,
                    downloaded: 100,
                }],
            },
        )
        .await
        .unwrap();

    // 7. Soft-delete node without cascade rejects because relay depends on it; cascade succeeds!
    let (status, _, body) = call(
        &router,
        "DELETE",
        &format!("/api/v1/admin/nodes/{node_id}"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["code"],
        "NODE_HAS_RELAYS"
    );

    let (status, _, _) = call(
        &router,
        "DELETE",
        &format!("/api/v1/admin/nodes/{node_id}?cascade=true"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Cannot purge active node, CAN restore and then re-soft-delete and hard-delete (purge)!
    let restored = data(
        &router,
        "POST",
        &format!("/api/v1/admin/nodes/{node_id}/restore"),
        &cookie,
        None,
    )
    .await;
    assert_eq!(restored["enabled"], false);
    assert_eq!(restored["show"], false);
    assert!(restored["deleted_at"].is_null());

    // Cannot purge while active
    let (status, _, _) = call(
        &router,
        "DELETE",
        &format!("/api/v1/admin/nodes/{node_id}/purge"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Purge trashed relay, then soft-delete & purge parent node even though it had usage!
    let (status, _, _) = call(
        &router,
        "DELETE",
        &format!("/api/v1/admin/nodes/{relay_id}/purge"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // 8. Soft-delete server with cascade disconnects online agent and allows manual hard-delete!
    let (status, _, body) = call(
        &router,
        "DELETE",
        &format!("/api/v1/admin/servers/{server_id}"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["code"],
        "SERVER_HAS_NODES"
    );

    let (status, _, _) = call(
        &router,
        "DELETE",
        &format!("/api/v1/admin/servers/{server_id}?cascade=true"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(matches!(
        rx.try_recv().unwrap(),
        BoardMessage::Disconnect { .. }
    ));

    // Manual hard-delete (purge) of trashed server succeeds even with historical usage_events!
    let (status, _, _) = call(
        &router,
        "DELETE",
        &format!("/api/v1/admin/servers/{server_id}/purge"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

async fn login(router: &Router, email: &str, password: &str) -> String {
    let (status, headers, _) = call(
        router,
        "POST",
        "/auth/login",
        None,
        Some(json!({"email": email, "password": password})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    headers[SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into()
}

async fn data(
    router: &Router,
    method: &str,
    path: &str,
    cookie: &str,
    payload: Option<Value>,
) -> Value {
    let (status, _, body) = call(router, method, path, Some(cookie), payload).await;
    assert!(
        status.is_success(),
        "{method} {path}: {status} {}",
        String::from_utf8_lossy(&body)
    );
    serde_json::from_slice(&body).unwrap()
}

async fn call(
    router: &Router,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    payload: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-workspace-request", "1");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let body = match payload {
        Some(data) => {
            request = request.header("content-type", "application/json");
            Body::from(data.to_string())
        }
        None => Body::empty(),
    };
    let response = router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    (
        parts.status,
        parts.headers,
        to_bytes(body, 2_000_000).await.unwrap().to_vec(),
    )
}
