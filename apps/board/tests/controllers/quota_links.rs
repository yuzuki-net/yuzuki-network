use axum::{
    Router,
    body::{Body, to_bytes},
    http::{
        HeaderMap, Request, StatusCode,
        header::{COOKIE, SET_COOKIE},
    },
};
use board::{
    app::{self, State},
    infra::{config::Settings, migration, postgres},
    services::{
        access::entitled_ids_for_node,
        accounts,
        subscriptions::links::{self, NewLink},
    },
};
use chrono::{TimeDelta, Utc};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;
use yuzuki_protocol::v1::{UsageBatch, UsageEvent};

const PASSWORD: &str = "test-link-password";
const LINKS: &str = "/api/v1/me/subscriptions";
const DEVICES: &str = "/api/v1/me/subscription-devices";
const QUOTA: &str = "/api/v1/me/quota";
const MEMBER_ROLE: &str = "00000000-0000-4000-8000-000000000001";

#[tokio::test]
async fn format_links_auto_provision_apply_role_limits_and_manage_devices() {
    let Some(site) = Site::init().await else {
        return;
    };
    let subscriber = site.account(false).await;
    let cookie = site.sign_in(&subscriber).await;
    let other = site.account(false).await;
    let other_cookie = site.sign_in(&other).await;
    let owner = site.account(true).await;
    let owner_cookie = site.sign_in(&owner).await;
    site.prepare_endpoint(&subscriber).await;

    assert_eq!(
        site.request("GET", LINKS, None, None, None).await.0,
        StatusCode::NOT_FOUND
    );

    // Account creation auto-provisions 4 default links (xray, sing-box, mihomo, universal)!
    let initial = site.json("GET", LINKS, &cookie, None).await;
    assert_eq!(initial["effective_link_limits"], json!([1, 1, 1, 1]));
    let auto_links = initial["links"].as_array().unwrap();
    assert_eq!(auto_links.len(), 4);
    let a = auto_links.iter().find(|l| l["format"] == 0).unwrap().clone();
    let b = auto_links.iter().find(|l| l["format"] == 1).unwrap().clone();

    let rename = format!("{LINKS}/{}", a["id"].as_str().unwrap());
    for (cookie, name, status) in [
        (&other_cookie, "Other account", StatusCode::NOT_FOUND),
        (&cookie, " ", StatusCode::BAD_REQUEST),
        (&cookie, "Work laptop", StatusCode::NO_CONTENT),
    ] {
        assert_eq!(
            site.request(
                "PATCH",
                &rename,
                Some(cookie),
                Some(json!({"name":name})),
                None
            )
            .await
            .0,
            status
        );
    }

    // Attempting to create an extra format 0 link hits LINK_LIMIT (1/1 used by auto-provisioned link).
    let (status, _, body) = site
        .request(
            "POST",
            LINKS,
            Some(&cookie),
            Some(json!({"name":"Extra","format":0})),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let error: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(error["code"], "LINK_LIMIT");

    let second_cookie = site.sign_in(&subscriber).await;
    let list = site.json("GET", LINKS, &second_cookie, None).await;
    assert_eq!(list["links"][0]["name"], "Work laptop");

    let role = site
        .json(
            "POST",
            "/api/v1/admin/roles",
            &owner_cookie,
            Some(json!({
                "name": format!("Extra links {}", Uuid::new_v4()),
                "description": "",
                "permissions": [],
                "link_limits": {"xray": 2, "mihomo": 0},
            })),
        )
        .await;
    let assign = format!("/api/v1/admin/users/{}/access", subscriber.id);
    site.json(
        "PUT",
        &assign,
        &owner_cookie,
        Some(json!({"roles": [MEMBER_ROLE, role["id"]], "overrides": {}})),
    )
    .await;
    let list = site.json("GET", LINKS, &cookie, None).await;
    assert_eq!(list["effective_link_limits"], json!([2, 1, 0, 1]));

    let create = |name| {
        site.request(
            "POST",
            LINKS,
            Some(&cookie),
            Some(json!({"name": name, "format": 0})),
            None,
        )
    };
    let (one, two) = tokio::join!(create("Laptop"), create("Tablet"));
    assert!(
        (one.0 == StatusCode::CREATED && two.0 == StatusCode::CONFLICT)
            || (one.0 == StatusCode::CONFLICT && two.0 == StatusCode::CREATED)
    );
    let added: Value = serde_json::from_slice(if one.0 == StatusCode::CREATED {
        &one.2
    } else {
        &two.2
    })
    .unwrap();

    site.quota_policy(
        &subscriber,
        &owner_cookie,
        json!({
            "max_devices": 1,
            "link_limits": {"xray": 1, "sing_box": 1, "mihomo": 0, "universal": 1},
        }),
    )
    .await;
    let list = site.json("GET", LINKS, &cookie, None).await;
    assert_eq!(list["links"][0]["within_limit"], true);
    assert_eq!(list["links"][1]["within_limit"], false);
    assert_eq!(
        site.download(&added, "blocked").await,
        StatusCode::NOT_FOUND
    );

    let a_path = a["path"].as_str().unwrap();
    assert_eq!(
        site.request("HEAD", a_path, None, None, Some("head-probe"))
            .await
            .0,
        StatusCode::OK
    );
    let (use_a, use_b) = tokio::join!(
        site.download(&a, "device-one"),
        site.download(&b, "device-two")
    );
    let (winner, waiting) = if use_a == StatusCode::OK {
        assert_eq!(use_b, StatusCode::CONFLICT);
        ("device-one", "device-two")
    } else {
        assert_eq!(use_a, StatusCode::CONFLICT);
        assert_eq!(use_b, StatusCode::OK);
        ("device-two", "device-one")
    };
    assert_eq!(site.download(&a, winner).await, StatusCode::OK);
    let devices = site.json("GET", DEVICES, &cookie, None).await;
    assert_eq!(devices["items"].as_array().unwrap().len(), 1);
    let device = format!("{DEVICES}/{}", devices["items"][0]["id"].as_str().unwrap());
    assert_eq!(
        site.request("DELETE", &device, Some(&cookie), None, None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(site.download(&b, waiting).await, StatusCode::OK);

    site.quota_policy(
        &subscriber,
        &owner_cookie,
        json!({
            "max_devices": 0,
            "link_limits": {"xray": 1, "sing_box": 1, "mihomo": 0, "universal": 1},
        }),
    )
    .await;
    assert_eq!(site.download(&a, waiting).await, StatusCode::CONFLICT);
    assert_eq!(
        site.json("GET", QUOTA, &cookie, None).await["active_devices"],
        0
    );
}

#[tokio::test]
async fn standalone_quota_plans_stacking_and_waterfall_deduction() {
    let Some(site) = Site::init().await else {
        return;
    };
    let owner = site.account(true).await;
    let owner_cookie = site.sign_in(&owner).await;

    // Create two standalone Quota Plans:
    // 1) Monthly recurring 100B plan (1 calendar month, cycle reset)
    let monthly_plan = site
        .json(
            "POST",
            "/api/v1/admin/quota-plans",
            &owner_cookie,
            Some(json!({
                "name": format!("Monthly-100B-{}", Uuid::new_v4()),
                "description": "Calendar monthly recurring plan",
                "quota_bytes": "100",
                "duration_kind": "months",
                "duration_value": 1,
                "reset_mode": "cycle",
                "max_devices": 3
            })),
        )
        .await;
    // 2) Permanent 50B add-on pack (unlimited duration, no reset)
    let addon_plan = site
        .json(
            "POST",
            "/api/v1/admin/quota-plans",
            &owner_cookie,
            Some(json!({
                "name": format!("Addon-50B-{}", Uuid::new_v4()),
                "description": "Permanent traffic booster",
                "quota_bytes": "50",
                "duration_kind": "unlimited",
                "reset_mode": "none"
            })),
        )
        .await;

    let subscriber = site.account(false).await;
    let cookie = site.sign_in(&subscriber).await;
    let (server_id, node_id, session) = site.prepare_endpoint(&subscriber).await;

    // Replace default Unlimited grant with the Monthly 100B plan, then stack the Permanent 50B add-on!
    site.json(
        "POST",
        &format!("/api/v1/admin/quotas/{}/grants", subscriber.id),
        &owner_cookie,
        Some(json!({
            "plan_id": monthly_plan["id"],
            "replace_existing": true
        })),
    )
    .await;
    let stacked = site
        .json(
            "POST",
            &format!("/api/v1/admin/quotas/{}/grants", subscriber.id),
            &owner_cookie,
            Some(json!({
                "plan_id": addon_plan["id"],
                "replace_existing": false
            })),
        )
        .await;

    assert_eq!(stacked["quota_bytes"], "150");
    assert_eq!(stacked["remaining_bytes"], "150");
    assert_eq!(stacked["grants"].as_array().unwrap().len(), 2);

    // Record 120 bytes of usage -> waterfall drains 100B from Monthly (earliest reset/expiry) FIRST,
    // then spills 20B into the Permanent Add-on pack (leaving 30B remaining)!
    site.state
        .ledger
        .record(
            server_id,
            session,
            UsageBatch {
                events: vec![UsageEvent {
                    event_id: Uuid::new_v4(),
                    instance_id: node_id,
                    access_id: subscriber.access_id,
                    uploaded: 120,
                    downloaded: 0,
                }],
            },
        )
        .await
        .unwrap();

    let after = site.json("GET", QUOTA, &cookie, None).await;
    assert_eq!(after["used_bytes"], "120");
    assert_eq!(after["remaining_bytes"], "30");
    assert_eq!(after["state"], "available");
    let grants = after["grants"].as_array().unwrap();
    let monthly_grant = grants.iter().find(|g| g["plan_id"] == monthly_plan["id"]).unwrap();
    let addon_grant = grants.iter().find(|g| g["plan_id"] == addon_plan["id"]).unwrap();
    assert_eq!(monthly_grant["used_bytes"], "100");
    assert_eq!(monthly_grant["state"], "exhausted");
    assert_eq!(addon_grant["used_bytes"], "20");
    assert_eq!(addon_grant["remaining_bytes"], "30");
    assert_eq!(addon_grant["state"], "active");

    // Simulate calendar rollover of the Monthly grant (set cycle_ends_at in the past)
    // -> Monthly resets to 0/100B, while Permanent add-on retains 20/50B (total remaining = 130B)!
    let monthly_grant_id = Uuid::parse_str(monthly_grant["id"].as_str().unwrap()).unwrap();
    site.sql(
        "UPDATE account_quotas SET anchor_at = now() - interval '2 months', cycle_starts_at = now() - interval '2 months', cycle_ends_at = now() - interval '1 minute' WHERE id = $1",
        [monthly_grant_id.into()],
    )
    .await;

    let rolled = site.json("GET", QUOTA, &cookie, None).await;
    assert_eq!(rolled["remaining_bytes"], "130");
    assert_eq!(rolled["used_bytes"], "20");
    assert_eq!(rolled["lifetime_used_bytes"], "120");
    assert_eq!(rolled["state"], "available");
}

#[tokio::test]
async fn quota_expiration_exhaustion_and_entitlement_enforcement() {
    let Some(site) = Site::init().await else {
        return;
    };
    let subscriber = site.account(false).await;
    let cookie = site.sign_in(&subscriber).await;
    let owner = site.account(true).await;
    let owner_cookie = site.sign_in(&owner).await;
    let (server_id, node_id, session) = site.prepare_endpoint(&subscriber).await;

    let links = site.json("GET", LINKS, &cookie, None).await;
    let link = links["links"][0].clone();

    // Replace with an already-expired 10-day one-time grant -> state = expired, not entitled!
    let past = Utc::now() - TimeDelta::days(15);
    site.json(
        "POST",
        &format!("/api/v1/admin/quotas/{}/grants", subscriber.id),
        &owner_cookie,
        Some(json!({
            "name": "Expired 10d pack",
            "quota_bytes": "10",
            "duration_kind": "days",
            "duration_value": 10,
            "reset_mode": "none",
            "starts_at": past,
            "replace_existing": true
        })),
    )
    .await;

    let expired = site.json("GET", QUOTA, &cookie, None).await;
    assert_eq!(expired["state"], "expired");
    assert_eq!(site.download(&link, "desktop").await, StatusCode::NOT_FOUND);
    assert!(
        !entitled_ids_for_node(&site.state.db, node_id)
            .await
            .unwrap()
            .contains(&subscriber.access_id.to_string())
    );

    // Replace with active 20-day 10B grant -> entitled until 10B recorded (idempotency verified).
    site.json(
        "POST",
        &format!("/api/v1/admin/quotas/{}/grants", subscriber.id),
        &owner_cookie,
        Some(json!({
            "name": "Active 20d pack",
            "quota_bytes": "10",
            "duration_kind": "days",
            "duration_value": 20,
            "reset_mode": "none",
            "replace_existing": true
        })),
    )
    .await;
    assert_eq!(site.download(&link, "desktop").await, StatusCode::OK);
    assert!(
        entitled_ids_for_node(&site.state.db, node_id)
            .await
            .unwrap()
            .contains(&subscriber.access_id.to_string())
    );

    let event = UsageEvent {
        event_id: Uuid::new_v4(),
        instance_id: node_id,
        access_id: subscriber.access_id,
        uploaded: 10,
        downloaded: 0,
    };
    for _ in 0..2 {
        site.state
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
    }
    let blocked = site.json("GET", QUOTA, &cookie, None).await;
    assert_eq!(blocked["used_bytes"], "10");
    assert_eq!(blocked["lifetime_used_bytes"], "10");
    assert_eq!(blocked["state"], "exhausted");
    assert_eq!(site.download(&link, "desktop").await, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn credential_reset_revokes_subscription_links() {
    let Some(site) = Site::init().await else {
        return;
    };
    let subscriber = site.account(false).await;
    let cookie = site.sign_in(&subscriber).await;
    let owner = site.account(true).await;
    let owner_cookie = site.sign_in(&owner).await;
    site.prepare_endpoint(&subscriber).await;
    let list = site.json("GET", LINKS, &cookie, None).await;
    let link = list["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["format"] == 2)
        .unwrap()
        .clone();
    assert_eq!(site.download(&link, "client").await, StatusCode::OK);
    let mut headers = HeaderMap::new();
    headers.insert(COOKIE, cookie.parse().unwrap());
    let already_authenticated = site
        .state
        .auth
        .session(&site.state.db, &headers)
        .await
        .unwrap();
    let reset = format!("/api/v1/admin/users/{}/credentials", subscriber.id);
    assert_eq!(
        site.request(
            "PUT",
            &reset,
            Some(&owner_cookie),
            Some(json!({"password":"reset-strong-password"})),
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(site.download(&link, "client").await, StatusCode::NOT_FOUND);
    assert!(matches!(
        links::create(
            &site.state.db,
            &already_authenticated,
            "documents",
            NewLink {
                name: "Queued creation".into(),
                format: 2
            }
        )
        .await,
        Err(board::infra::error::Error::NotFound)
    ));
}

#[tokio::test]
async fn personal_usage_heatmap_aggregates_daily_transfer_per_account() {
    let Some(site) = Site::init().await else {
        return;
    };
    let alice = site.account(false).await;
    let alice_cookie = site.sign_in(&alice).await;
    let bob = site.account(false).await;
    let bob_cookie = site.sign_in(&bob).await;

    let server_id = Uuid::new_v4();
    let node_id = Uuid::new_v4();
    let today = Utc::now();
    let two_days_ago = today - TimeDelta::days(2);
    let old = today - TimeDelta::days(200);

    // Two events for Alice today, one two days ago, one outside 90d window, and one for Bob today.
    site.sql(
        "INSERT INTO usage_events (server_id, event_id, node_id, account_id, uploaded, downloaded, rate, billed_bytes, received_at)
         VALUES ($1, $2, $3, $4, 100, 400, 1.0, 500, $5)",
        [
            server_id.into(),
            Uuid::new_v4().into(),
            node_id.into(),
            alice.id.into(),
            today.into(),
        ],
    )
    .await;
    site.sql(
        "INSERT INTO usage_events (server_id, event_id, node_id, account_id, uploaded, downloaded, rate, billed_bytes, received_at)
         VALUES ($1, $2, $3, $4, 50, 150, 2.0, 400, $5)",
        [
            server_id.into(),
            Uuid::new_v4().into(),
            node_id.into(),
            alice.id.into(),
            today.into(),
        ],
    )
    .await;
    site.sql(
        "INSERT INTO usage_events (server_id, event_id, node_id, account_id, uploaded, downloaded, rate, billed_bytes, received_at)
         VALUES ($1, $2, $3, $4, 300, 1000, 1.0, 1300, $5)",
        [
            server_id.into(),
            Uuid::new_v4().into(),
            node_id.into(),
            alice.id.into(),
            two_days_ago.into(),
        ],
    )
    .await;
    site.sql(
        "INSERT INTO usage_events (server_id, event_id, node_id, account_id, uploaded, downloaded, rate, billed_bytes, received_at)
         VALUES ($1, $2, $3, $4, 9999, 9999, 1.0, 19998, $5)",
        [
            server_id.into(),
            Uuid::new_v4().into(),
            node_id.into(),
            alice.id.into(),
            old.into(),
        ],
    )
    .await;
    site.sql(
        "INSERT INTO usage_events (server_id, event_id, node_id, account_id, uploaded, downloaded, rate, billed_bytes, received_at)
         VALUES ($1, $2, $3, $4, 700, 800, 1.0, 1500, $5)",
        [
            server_id.into(),
            Uuid::new_v4().into(),
            node_id.into(),
            bob.id.into(),
            today.into(),
        ],
    )
    .await;

    let alice_map = site
        .json("GET", "/api/v1/me/usage/heatmap?days=90", &alice_cookie, None)
        .await;
    assert_eq!(alice_map["window_days"], 90);
    assert_eq!(alice_map["active_days"], 2);
    assert_eq!(alice_map["total_uploaded"], "450");
    assert_eq!(alice_map["total_downloaded"], "1550");
    assert_eq!(alice_map["total_billed"], "2200");
    assert_eq!(alice_map["days"].as_array().unwrap().len(), 2);
    assert_eq!(
        alice_map["peak_day"]["date"],
        two_days_ago.format("%Y-%m-%d").to_string()
    );
    assert_eq!(alice_map["peak_day"]["billed_bytes"], "1300");

    let alice_year = site
        .json("GET", "/api/v1/me/usage/heatmap?days=365", &alice_cookie, None)
        .await;
    assert_eq!(alice_year["active_days"], 3);
    assert_eq!(alice_year["total_billed"], "22198");

    let bob_map = site
        .json("GET", "/api/v1/me/usage/heatmap?days=90", &bob_cookie, None)
        .await;
    assert_eq!(bob_map["active_days"], 1);
    assert_eq!(bob_map["total_billed"], "1500");
}

struct Site {
    router: Router,
    state: State,
}

struct TestAccount {
    id: Uuid,
    email: String,
    access_id: Uuid,
}

impl Site {
    async fn init() -> Option<Self> {
        let url = std::env::var("YUZUKI_TEST_DATABASE_URL").ok()?;
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
        Some(Self {
            router: app::router(state.clone()),
            state,
        })
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        cookie: Option<&str>,
        input: Option<Value>,
        device: Option<&str>,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("x-workspace-request", "1");
        if let Some(cookie) = cookie {
            builder = builder.header("cookie", cookie);
        }
        if let Some(device) = device {
            builder = builder.header("x-device-id", device);
        }
        let body = if let Some(value) = input {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        } else {
            Body::empty()
        };
        let response = self
            .router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        (
            parts.status,
            parts.headers,
            to_bytes(body, 100_000).await.unwrap().to_vec(),
        )
    }

    async fn account(&self, admin: bool) -> TestAccount {
        let row = accounts::create(
            &self.state.db,
            &self.state.auth,
            format!("{}@example.net", Uuid::new_v4()),
            PASSWORD.to_string(),
            admin,
            true,
        )
        .await
        .unwrap();
        TestAccount {
            id: row.id,
            email: row.email,
            access_id: row.access_id,
        }
    }

    async fn sign_in(&self, account: &TestAccount) -> String {
        let (status, headers, _) = self
            .request(
                "POST",
                "/auth/login",
                None,
                Some(json!({"email":account.email,"password":PASSWORD})),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        headers
            .get(SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string()
    }

    async fn json(&self, method: &str, path: &str, cookie: &str, input: Option<Value>) -> Value {
        let (status, _, body) = self.request(method, path, Some(cookie), input, None).await;
        assert!(
            status.is_success(),
            "{method} {path}: {status} {}",
            String::from_utf8_lossy(&body)
        );
        serde_json::from_slice(&body).unwrap()
    }

    async fn quota_policy(&self, user: &TestAccount, actor: &str, policy: Value) -> Value {
        self.json(
            "PUT",
            &format!("/api/v1/admin/quotas/{}/policy", user.id),
            actor,
            Some(policy),
        )
        .await
    }

    async fn download(&self, link: &Value, device: &str) -> StatusCode {
        self.request(
            "GET",
            link["path"].as_str().unwrap(),
            None,
            None,
            Some(device),
        )
        .await
        .0
    }

    async fn prepare_endpoint(&self, user: &TestAccount) -> (Uuid, Uuid, Uuid) {
        let server_id = Uuid::new_v4();
        let session = Uuid::new_v4();
        let node_id = Uuid::new_v4();
        self.sql(
            "INSERT INTO servers (id, name, session_id, last_seen_at) VALUES ($1, 'fixture', $2, now())",
            [server_id.into(), session.into()],
        )
        .await;
        let meter = json!({"kind":"dedicated_traffic","access_id":user.access_id,"addr":"127.0.0.1:9090","secret":"fixture"});
        let proto_cfg = json!({"protocol":"vless","server_name":"fixture.example.net"});
        self.sql(
            "INSERT INTO proxy_nodes (id, name, mode, server_id, core, enabled, show, protocol, host, port, protocol_config, meter_config, native_server_config)
             VALUES ($1, 'fixture', 'custom', $2, 'mihomo', true, true, 'vless', 'fixture.example.net', 443, $3, $4, '{}')",
            [node_id.into(), server_id.into(), proto_cfg.into(), meter.into()],
        )
        .await;
        (server_id, node_id, session)
    }

    async fn sql<const N: usize>(&self, sql: &str, values: [sea_orm::Value; N]) {
        self.state
            .db
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                values,
            ))
            .await
            .unwrap();
    }
}
