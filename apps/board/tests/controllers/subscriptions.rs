use axum::{
    Router,
    body::{Body, to_bytes},
    http::{
        Request, StatusCode,
        header::{CACHE_CONTROL, SET_COOKIE},
    },
};
use base64::{Engine, engine::general_purpose::STANDARD};
use board::{
    app::{self, State},
    infra::{config::Settings, migration, postgres},
    services::accounts,
};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{UsageBatch, UsageEvent},
};

#[tokio::test]
async fn subscriptions_render_managed_and_role_scoped_nodes_and_apply_rate_multiplier() {
    let Ok(url) = std::env::var("YUZUKI_TEST_DATABASE_URL") else {
        eprintln!("set YUZUKI_TEST_DATABASE_URL to run the PostgreSQL integration");
        return;
    };
    let db = postgres::connect(&url).await.unwrap();
    migration::run(&db).await.unwrap();
    let settings = Settings {
        subscription_route: "materials".into(),
        secure_cookies: false,
        ..Settings::default()
    };
    let state = State::new(db, settings).await.unwrap();
    let email = format!("{}@example.net", Uuid::new_v4());
    let pass = "integration-password";
    let user = accounts::create(
        &state.db,
        &state.auth,
        email.clone(),
        pass.into(),
        true,
        true,
    )
    .await
    .unwrap();
    let member = accounts::create(
        &state.db,
        &state.auth,
        format!("member-{}@example.net", Uuid::new_v4()),
        pass.into(),
        false,
        true,
    )
    .await
    .unwrap();
    let browser = app::router(state.clone());
    let admin = login(&browser, &email, pass).await;
    let member_cookie = login(&browser, &member.email, pass).await;

    let status_url = "/api/v1/me/subscriptions";
    let original = value(&browser, "GET", status_url, &admin, None).await;

    // Create a VIP role for role-scoped node visibility test.
    let vip_role = value(
        &browser,
        "POST",
        "/api/v1/admin/roles",
        &admin,
        Some(json!({
            "name": format!("VIP {}", Uuid::new_v4()),
            "description": "VIP nodes",
            "permissions": ["subscriptions.read", "subscriptions.manage"]
        })),
    )
    .await;

    let mut last = None;
    for (index, core) in Core::ALL.into_iter().enumerate() {
        let srv = value(
            &browser,
            "POST",
            "/api/v1/admin/servers",
            &admin,
            Some(json!({"name": format!("host-{core}")})),
        )
        .await;
        let server_id = srv["id"].as_str().unwrap();
        let node = value(
            &browser,
            "POST",
            "/api/v1/admin/nodes",
            &admin,
            Some(json!({
                "name": format!("line-{core}"),
                "mode": "managed",
                "server_id": server_id,
                "core": core,
                "enabled": true,
                "show": true,
                "sort_order": index,
                "rate": 2.0,
                "tags": ["Fast"],
                "visibility": "all",
                "host": format!("{core}.source.example.net"),
                "port": 443,
                "listen_port": 443,
                "protocol_config": {
                    "protocol": "vless",
                    "server_name": "source.example.net",
                    "certificate": "/etc/yuzuki/server.crt",
                    "key": "/etc/yuzuki/server.key"
                }
            })),
        )
        .await;
        last = Some((
            Uuid::parse_str(server_id).unwrap(),
            Uuid::parse_str(node["id"].as_str().unwrap()).unwrap(),
        ));
    }

    // Create a VIP-only external node: visible to admins, hidden from regular member!
    let vip_node = value(
        &browser,
        "POST",
        "/api/v1/admin/nodes",
        &admin,
        Some(json!({
            "name": "VIP Exclusive",
            "mode": "external",
            "enabled": true,
            "show": true,
            "visibility": "roles",
            "role_ids": [vip_role["id"]],
            "host": "vip.source.example.net",
            "port": 443,
            "protocol_config": {
                "protocol": "vless",
                "server_name": "vip.source.example.net"
            }
        })),
    )
    .await;
    let vip_node_id = vip_node["id"].as_str().unwrap();

    let admin_nodes = value(&browser, "GET", "/api/v1/me/nodes", &admin, None).await;
    assert!(
        admin_nodes
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == vip_node_id)
    );
    let member_nodes = value(&browser, "GET", "/api/v1/me/nodes", &member_cookie, None).await;
    assert!(
        member_nodes
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["id"] != vip_node_id)
    );

    // Accounts auto-provision all 4 formats (xray, sing-box, mihomo, universal)!
    let status = value(&browser, "GET", status_url, &admin, None).await;
    let paths: Vec<String> = status["links"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["path"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(paths.len(), 4);
    for format in 0..4 {
        assert_eq!(
            status["endpoints"][format].as_u64().unwrap(),
            original["endpoints"][format].as_u64().unwrap() + 4
        );
    }
    for (locale, label) in [("en", "Traffic used:"), ("ja", "使用済み通信量：")] {
        let account = value(
            &browser,
            "PUT",
            "/api/v1/me/locale",
            &admin,
            Some(json!({ "locale": locale })),
        )
        .await;
        assert_eq!(account["locale"], locale);

        for path in &paths {
            let (status, headers, body) = request(&browser, "GET", path, None, None).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(headers[CACHE_CONTROL], "no-store");
            let decoded = if path.ends_with("?f=3") {
                let decoded = String::from_utf8(STANDARD.decode(body.trim()).unwrap()).unwrap();
                let first = decoded.lines().next().unwrap();
                let (_, fragment) = first.split_once('#').unwrap();
                let fields: Vec<(String, String)> =
                    serde_urlencoded::from_str(&format!("label={fragment}")).unwrap();
                assert!(fields[0].1.contains(label), "{first}");
                decoded
            } else {
                assert!(body.contains(label), "{body}");
                body
            };
            for core in Core::ALL {
                assert!(
                    decoded.contains(&format!("{core}.source.example.net")),
                    "{decoded}"
                );
            }
            assert!(decoded.contains("vip.source.example.net"), "{decoded}");
        }
    }

    // Verify 2.0x rate multiplier: 10 up + 2 down = 12 raw -> 24 billed bytes exhausts 24-byte grant!
    let (server_id, node_id) = last.unwrap();
    let session = Uuid::new_v4();
    state
        .db
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE servers SET session_id = $1 WHERE id = $2",
            [session.into(), server_id.into()],
        ))
        .await
        .unwrap();
    value(
        &browser,
        "POST",
        &format!("/api/v1/admin/quotas/{}/grants", user.id),
        &admin,
        Some(json!({
            "name": "24B test pack",
            "quota_bytes": "24",
            "duration_kind": "unlimited",
            "reset_mode": "none",
            "replace_existing": true
        })),
    )
    .await;
    let event = UsageEvent {
        event_id: Uuid::new_v4(),
        instance_id: node_id,
        access_id: user.access_id,
        uploaded: 10,
        downloaded: 2,
    };
    for _ in 0..2 {
        let ids = state
            .ledger
            .record(
                server_id,
                session,
                UsageBatch {
                    events: vec![event.clone()],
                },
            )
            .await
            .unwrap();
        assert_eq!(ids, [event.event_id]);
    }
    for path in &paths {
        let (status, _, body) = request(&browser, "GET", path, None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.is_empty());
    }
    let me_quota = value(&browser, "GET", "/api/v1/me/quota", &admin, None).await;
    assert_eq!(me_quota["used_bytes"], "24");
    assert_eq!(me_quota["state"], "exhausted");
}

async fn login(router: &Router, email: &str, password: &str) -> String {
    let (status, headers, _) = request(
        router,
        "POST",
        "/auth/login",
        None,
        Some(json!({"email": email, "password": password})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    format!(
        "browser:{}",
        headers
            .get(SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
    )
}

async fn value(
    router: &Router,
    method: &str,
    uri: &str,
    browser: &str,
    payload: Option<Value>,
) -> Value {
    let (status, _, body) = request(router, method, uri, Some(browser), payload).await;
    assert!(status.is_success(), "{method} {uri}: {status} {body}");
    serde_json::from_str(&body).unwrap()
}

async fn request(
    router: &Router,
    method: &str,
    uri: &str,
    browser: Option<&str>,
    payload: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-workspace-request", "1");
    if let Some(browser) = browser {
        request = request.header("cookie", browser.strip_prefix("browser:").unwrap());
    }
    let request = if let Some(payload) = payload {
        request
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap()
    } else {
        request.body(Body::empty()).unwrap()
    };
    let response = router.clone().oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 2_000_000).await.unwrap();
    (
        parts.status,
        parts.headers,
        String::from_utf8(bytes.to_vec()).unwrap(),
    )
}
