use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use board::{
    app::{self, State},
    infra::{config::Settings, migration, postgres},
    services::{accounts, dashboard::presence},
};
use chrono::{Duration, Utc};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;
use yuzuki_protocol::v1::{InstanceDevices, OnlineSource, UsageBatch, UsageEvent};

const DASHBOARD: &str = "/api/v1/admin/dashboard";
const PASSWORD: &str = "test-dashboard-password";

#[tokio::test]
async fn dashboard_rollup_and_source_coverage_with_account_and_node_scopes() {
    let Ok(url) = std::env::var("YUZUKI_TEST_DATABASE_URL") else {
        return;
    };
    let db = postgres::connect(&url).await.unwrap();
    migration::run(&db).await.unwrap();
    let state = State::new(
        db,
        Settings {
            secure_cookies: false,
            ..Settings::default()
        },
    )
    .await
    .unwrap();
    let router = app::router(state.clone());
    let email = |role: &str| format!("dashboard-{role}-{}@example.net", Uuid::new_v4());
    let owner = email("owner");
    let member = email("member");
    let directory = email("directory");
    let nodes = email("nodes");
    for (email, owner) in [
        (&owner, true),
        (&member, false),
        (&directory, false),
        (&nodes, false),
    ] {
        accounts::create(
            &state.db,
            &state.auth,
            email.clone(),
            PASSWORD.into(),
            owner,
            true,
        )
        .await
        .unwrap();
    }
    let owner_cookie = login(&router, &owner).await;
    let member_cookie = login(&router, &member).await;
    assert_eq!(
        call(&router, "GET", DASHBOARD, None, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&router, "GET", DASHBOARD, Some(&member_cookie), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    let baseline = data(&router, "GET", DASHBOARD, &owner_cookie, None).await;
    assert!(
        baseline["accounts"]["active_console_sessions"]
            .as_i64()
            .unwrap()
            >= 2
    );
    let member_id = account_id(&router, &member_cookie).await;
    let access_id: Uuid = state
        .db
        .query_one(sql(
            "SELECT access_id FROM accounts WHERE id = $1",
            [member_id.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "access_id")
        .unwrap();
    let node_id = Uuid::new_v4();
    let session = Uuid::new_v4();
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let missing = Uuid::new_v4();
    state.db.execute(sql(
        "INSERT INTO servers (id, name, session_id, last_seen_at)
         VALUES ($1, 'Dashboard report test', $2, now())",
        [node_id.into(), session.into()],
    )).await.unwrap();
    for (instance, core) in [(first, "xray"), (second, "mihomo")] {
        state
            .db
            .execute(sql(
                "INSERT INTO proxy_nodes (id, server_id, name, mode, core, native_server_config, enabled, show)
                 VALUES ($1, $2, $3, 'custom', $3, '{}', TRUE, TRUE)",
                [instance.into(), node_id.into(), core.into()],
            ))
            .await
            .unwrap();
    }
    let key = presence::key(&state.db).await.unwrap();
    assert_eq!(key, presence::key(&state.db).await.unwrap());
    let batch = || UsageBatch {
        events: vec![UsageEvent {
            event_id: first,
            instance_id: first,
            access_id,
            uploaded: 600,
            downloaded: 1800,
        }],
    };
    for _ in 0..2 {
        assert_eq!(
            state
                .ledger
                .record(node_id, session, batch())
                .await
                .unwrap(),
            vec![first]
        );
    }
    let reports = || {
        [first, second, missing]
            .map(|instance_id| InstanceDevices {
                instance_id,
                sources: vec![
                    OnlineSource {
                        access_id,
                        source: [123; 32],
                    },
                    OnlineSource {
                        access_id,
                        source: [123; 32],
                    },
                ],
            })
            .into()
    };
    assert!(
        presence::record(&state.db, node_id, Uuid::new_v4(), reports())
            .await
            .is_err()
    );
    presence::record(&state.db, node_id, session, reports())
        .await
        .unwrap();
    let location = format!("/api/v1/admin/servers/{node_id}/location");
    let point = json!({"label":"Osaka","latitude":34.6937,"longitude":135.5023});
    assert_eq!(
        call(
            &router,
            "PUT",
            &location,
            Some(&owner_cookie),
            Some(point.clone())
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        data(&router, "GET", &location, &owner_cookie, None).await,
        point
    );
    let range = format!("{DASHBOARD}?range=1h");
    let overview = data(&router, "GET", &range, &owner_cookie, None).await;
    let infra = &overview["infrastructure"];
    let uploaded = |object: &Value| object["uploaded"].as_str().unwrap().parse::<i64>().unwrap();
    assert!(uploaded(&infra["totals"]) >= uploaded(&baseline["infrastructure"]["totals"]) + 600);
    assert!(uploaded(&infra["last_minute"]) >= 600);
    assert_eq!(infra["timeseries"].as_array().unwrap().len(), 61);
    assert!(
        infra["timeseries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|point| uploaded(point) >= 600)
    );
    let pin = infra["locations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pin| pin["id"] == json!(node_id))
        .unwrap();
    assert_eq!(pin["online"], true);
    assert_eq!(pin["uploaded"], "600");
    assert_eq!(pin["downloaded"], "1800");
    for days in ["12 hours", "10 days"] {
        state.db.execute(sql(
            "INSERT INTO usage_events (server_id,event_id,node_id,account_id,uploaded,downloaded,rate,billed_bytes,received_at)
             VALUES ($1,$2,$3,$4,30,90,1.0,120,now()-$5::interval)",
            [node_id.into(), Uuid::new_v4().into(), first.into(), member_id.into(), days.into()],
        )).await.unwrap();
    }
    board::services::dashboard::prune_history(&state.db)
        .await
        .unwrap();
    let week = data(
        &router,
        "GET",
        &format!("{DASHBOARD}?range=7d"),
        &owner_cookie,
        None,
    )
    .await;
    let location_usage = week["infrastructure"]["locations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pin| pin["id"] == json!(node_id))
        .unwrap();
    assert_eq!(location_usage["uploaded"], "630");
    assert_eq!(location_usage["downloaded"], "1890");
    assert!(
        uploaded(&week["infrastructure"]["totals"])
            >= uploaded(&baseline["infrastructure"]["totals"]) + 660
    );

    // Use a controlled source timestamp to isolate this fixture from unrelated test traffic.
    let instant = Utc::now() + Duration::hours(4);
    state
        .db
        .execute(sql(
            "UPDATE servers SET last_seen_at = $2 WHERE id = $1",
            [node_id.into(), instant.into()],
        ))
        .await
        .unwrap();
    state
        .db
        .execute(sql(
            "UPDATE observed_instances SET observed_at = $2 WHERE server_id = $1",
            [node_id.into(), instant.into()],
        ))
        .await
        .unwrap();
    let measured = presence::read(&state.db, instant).await.unwrap();
    assert_eq!(
        (
            measured.sources,
            measured.measured_instances,
            measured.active_instances
        ),
        (1, 2, 2)
    );
    let expired = presence::read(&state.db, instant + Duration::seconds(21))
        .await
        .unwrap();
    assert_eq!(
        (
            expired.sources,
            expired.measured_instances,
            expired.active_instances
        ),
        (0, 0, 2)
    );
    state
        .db
        .execute(sql(
            "UPDATE servers SET session_id = $2, last_seen_at = now() WHERE id = $1",
            [node_id.into(), Uuid::new_v4().into()],
        ))
        .await
        .unwrap();
    assert!(
        presence::record(&state.db, node_id, session, reports())
            .await
            .is_err()
    );

    for (email, permission) in [(directory, "users.read"), (nodes, "nodes.read")] {
        let cookie = login(&router, &email).await;
        let role = data(
            &router,
            "POST",
            "/api/v1/admin/roles",
            &owner_cookie,
            Some(json!({
                "name": email, "description": "", "permissions": [permission],
            })),
        )
        .await;
        let id = account_id(&router, &cookie).await;
        let response = call(
            &router,
            "PUT",
            &format!("/api/v1/admin/users/{id}/access"),
            Some(&owner_cookie),
            Some(json!({"roles":[role["id"]], "overrides":{}})),
        )
        .await;
        assert_eq!(response.0, StatusCode::OK);
        let metrics = data(&router, "GET", DASHBOARD, &cookie, None).await;
        assert_eq!(metrics["accounts"].is_object(), permission == "users.read");
        assert_eq!(
            metrics["infrastructure"].is_object(),
            permission == "nodes.read"
        );
        assert_eq!(
            call(
                &router,
                "PUT",
                &location,
                Some(&cookie),
                Some(point.clone())
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        call(&router, "DELETE", &location, Some(&owner_cookie), None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert!(
        data(&router, "GET", &location, &owner_cookie, None)
            .await
            .is_null()
    );
}

async fn account_id(router: &Router, cookie: &str) -> Uuid {
    let actor = data(router, "GET", "/api/v1/me", cookie, None).await;
    serde_json::from_value(actor["id"].clone()).unwrap()
}

fn sql(query: &str, values: impl IntoIterator<Item = sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, query, values)
}

async fn login(router: &Router, email: &str) -> String {
    let (status, headers, _) = call(
        router,
        "POST",
        "/auth/login",
        None,
        Some(json!({"email":email,"password":PASSWORD})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

async fn data(
    router: &Router,
    method: &str,
    path: &str,
    cookie: &str,
    body: Option<Value>,
) -> Value {
    let (status, _, bytes) = call(router, method, path, Some(cookie), body).await;
    assert!(
        status.is_success(),
        "{method} {path}: {status} {}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}

async fn call(
    router: &Router,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("x-workspace-request", "1")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    let response = router
        .clone()
        .oneshot(
            builder
                .body(
                    body.map(|value| Body::from(value.to_string()))
                        .unwrap_or_default(),
                )
                .unwrap(),
        )
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    (
        parts.status,
        parts.headers,
        to_bytes(body, 1 << 20).await.unwrap().to_vec(),
    )
}
