use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use board::{
    app::{self, State},
    infra::{config::Settings, migration, postgres},
    services::{accounts, messages},
};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "test-portal-password";
const SETTINGS: &str = "/api/v1/admin/settings";
const ANNOUNCEMENTS: &str = "/api/v1/admin/announcements";
const INBOX: &str = "/api/v1/me/announcements";
const SESSIONS: &str = "/api/v1/me/sessions";

#[tokio::test]
async fn dynamic_portal_settings_auth_and_durable_announcements() {
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
    let email = |name: &str| format!("{name}.{}@example.net", Uuid::new_v4());
    let admin = email("portal-admin");
    let member = email("portal-member");
    for (address, owner) in [(&admin, true), (&member, false)] {
        accounts::create(
            &app.db,
            &app.auth,
            address.clone(),
            PASSWORD.into(),
            owner,
            true,
        )
        .await
        .unwrap();
    }
    let admin_cookie = login(&router, &admin, "/admin").await;
    let member_cookie = login(&router, &member, "/workspace").await;
    let member_other_cookie = login(&router, &member, "/workspace").await;

    assert_eq!(
        data(&router, "GET", "/auth/session", None, None).await,
        json!({
            "signed_in": false, "workspace": null,
        })
    );
    assert_eq!(
        data(&router, "GET", "/auth/session", Some(&member_cookie), None).await,
        json!({
            "signed_in": true, "workspace": "/workspace",
        })
    );
    let redirect = request(&router, "GET", "/login", Some(&member_cookie), None).await;
    assert!(redirect.status.is_redirection());
    assert_eq!(redirect.headers[header::LOCATION], "/workspace");
    for path in [
        SETTINGS,
        ANNOUNCEMENTS,
        SESSIONS,
        "/workspace/announcements",
    ] {
        assert_eq!(
            request(&router, "GET", path, None, None).await.status,
            StatusCode::NOT_FOUND
        );
    }
    for path in [
        SETTINGS,
        ANNOUNCEMENTS,
        "/admin/settings",
        "/admin/announcements",
    ] {
        assert_eq!(
            request(&router, "GET", path, Some(&member_cookie), None)
                .await
                .status,
            StatusCode::NOT_FOUND
        );
    }

    let original = data(&router, "GET", SETTINGS, Some(&admin_cookie), None).await;
    let mut panel = original.clone();
    panel["panel"]["name"] = json!("Integration portal");
    panel["panel"]["features"]["registration"] = json!(true);
    panel["panel"]["features"]["announcements"] = json!(true);
    panel["panel"]["landing"]["headline"] = json!("Welcome to integration tests");
    let mut invalid = panel.clone();
    invalid["panel"]["url"] = json!("javascript:alert(1)");
    assert_eq!(
        request(&router, "PUT", SETTINGS, Some(&admin_cookie), Some(invalid))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    let saved = data(
        &router,
        "PUT",
        SETTINGS,
        Some(&admin_cookie),
        Some(panel.clone()),
    )
    .await;
    assert_eq!(saved["panel"], panel["panel"]);
    assert_eq!(
        request(&router, "PUT", SETTINGS, Some(&admin_cookie), Some(panel))
            .await
            .status,
        StatusCode::CONFLICT
    );
    let options = data(&router, "GET", "/auth/options", None, None).await;
    assert_eq!(options["panel"], saved["panel"]);
    assert_eq!(options["registration"], true);
    assert_eq!(
        request(&router, "GET", "/register", None, None)
            .await
            .status,
        StatusCode::OK
    );
    let registration = request(
        &router,
        "POST",
        "/auth/register",
        None,
        Some(json!({
            "email": email("portal-registration"), "password": PASSWORD,
        })),
    )
    .await;
    assert_eq!(registration.status, StatusCode::CREATED);
    assert_eq!(registration.json(), json!({"pending": true}));

    let profile = data(
        &router,
        "PUT",
        "/api/v1/me/profile",
        Some(&member_cookie),
        Some(json!({"email": member, "display_name": "Updated name"})),
    )
    .await;
    assert_eq!(profile["display_name"], "Updated name");
    let replacement = email("portal-new-address");
    let mut profile_input = json!({"email": replacement, "display_name": "Updated name"});
    assert_eq!(
        request(
            &router,
            "PUT",
            "/api/v1/me/profile",
            Some(&member_cookie),
            Some(profile_input.clone())
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    profile_input["current_password"] = json!(PASSWORD);
    let profile = data(
        &router,
        "PUT",
        "/api/v1/me/profile",
        Some(&member_cookie),
        Some(profile_input),
    )
    .await;
    assert_eq!(profile["email"], replacement);

    // Account language preference persisted in database
    assert_eq!(
        request(
            &router,
            "PUT",
            "/api/v1/me/locale",
            Some(&member_cookie),
            Some(json!({"locale": "xx-INVALID"})),
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    let updated_locale = data(
        &router,
        "PUT",
        "/api/v1/me/locale",
        Some(&member_cookie),
        Some(json!({"locale": "zh-CN"})),
    )
    .await;
    assert_eq!(updated_locale["locale"], "zh-CN");
    let me_view = data(&router, "GET", "/api/v1/me", Some(&member_cookie), None).await;
    assert_eq!(me_view["locale"], "zh-CN");

    let sessions = data(&router, "GET", SESSIONS, Some(&member_cookie), None).await;
    assert_eq!(sessions.as_array().unwrap().len(), 2);
    assert_eq!(sessions[0]["current"], true);
    assert_eq!(sessions[0]["user_agent"], "Portal integration");
    let admin_sessions = data(&router, "GET", SESSIONS, Some(&admin_cookie), None).await;
    let foreign_session = format!("{SESSIONS}/{}", admin_sessions[0]["id"].as_str().unwrap());
    assert_eq!(
        request(
            &router,
            "DELETE",
            &foreign_session,
            Some(&member_cookie),
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&router, "DELETE", SESSIONS, Some(&member_cookie), None)
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        data(
            &router,
            "GET",
            "/auth/session",
            Some(&member_other_cookie),
            None
        )
        .await["signed_in"],
        false
    );
    assert_eq!(
        data(&router, "GET", "/auth/session", Some(&member_cookie), None).await["signed_in"],
        true
    );

    let title = format!("A portal announcement {}", Uuid::new_v4());
    let draft = data(
        &router,
        "POST",
        ANNOUNCEMENTS,
        Some(&admin_cookie),
        Some(json!({"title": title, "body": "First paragraph.\n\nSecond paragraph."})),
    )
    .await;
    let id = draft["id"].as_str().unwrap();
    let item = format!("{ANNOUNCEMENTS}/{id}");
    let audit_search = format!(
        "/api/v1/admin/audit?kind=portal&q={}",
        title.split_whitespace().last().unwrap()
    );
    let audit = data(&router, "GET", &audit_search, Some(&admin_cookie), None).await;
    assert_eq!(audit[0]["target"], id);
    assert_eq!(audit[0]["target_label"], title);
    let audit_only = email("portal-audit-only");
    let auditor = accounts::create(
        &app.db,
        &app.auth,
        audit_only.clone(),
        PASSWORD.into(),
        false,
        true,
    )
    .await
    .unwrap();
    let audit_role = data(
        &router, "POST", "/api/v1/admin/roles", Some(&admin_cookie),
        Some(json!({"name": format!("Audit {}", auditor.id), "description":"", "permissions":["audit.read"]})),
    ).await;
    let assigned = request(
        &router,
        "PUT",
        &format!("/api/v1/admin/users/{}/access", auditor.id),
        Some(&admin_cookie),
        Some(json!({"roles": [audit_role["id"]], "overrides":{}})),
    )
    .await;
    assert_eq!(assigned.status, StatusCode::OK);
    let audit_only_cookie = login(&router, &audit_only, "/admin").await;
    let hidden = data(
        &router,
        "GET",
        &audit_search,
        Some(&audit_only_cookie),
        None,
    )
    .await;
    assert_eq!(hidden, json!([]));
    let visible = data(
        &router,
        "GET",
        &format!("/api/v1/admin/audit?kind=portal&q={id}"),
        Some(&audit_only_cookie),
        None,
    )
    .await;
    assert_eq!(visible[0]["target"], id);
    assert!(visible[0].get("target_label").is_none());
    let page = data(
        &router,
        "GET",
        &format!(
            "{ANNOUNCEMENTS}?q={}",
            title.split_whitespace().last().unwrap()
        ),
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(page["items"][0]["status"], "draft");
    assert_eq!(
        request(
            &router,
            "POST",
            &format!("{item}/publish"),
            Some(&admin_cookie),
            None
        )
        .await
        .status,
        StatusCode::ACCEPTED
    );
    let before = data(&router, "GET", INBOX, Some(&member_cookie), None).await;
    assert!(
        before["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["id"] != id)
    );
    let (first, second) = tokio::join!(messages::drain(&app.db), messages::drain(&app.db));
    assert_eq!(first.unwrap() + second.unwrap(), 1);
    let after = data(&router, "GET", INBOX, Some(&member_cookie), None).await;
    assert!(
        after["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == id && row["read"] == false)
    );
    assert_eq!(
        request(
            &router,
            "PUT",
            &format!("{INBOX}/read"),
            Some(&member_cookie),
            Some(json!({"ids": [id]}))
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    let mine = data(&router, "GET", INBOX, Some(&member_cookie), None).await;
    assert!(
        mine["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == id && row["read"] == true)
    );
    let theirs = data(&router, "GET", INBOX, Some(&admin_cookie), None).await;
    assert!(
        theirs["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == id && row["read"] == false)
    );
    assert_eq!(
        request(
            &router,
            "POST",
            &format!("{ANNOUNCEMENTS}/bulk"),
            Some(&admin_cookie),
            Some(json!({"action": "archive", "ids": [id, Uuid::new_v4()]}))
        )
        .await
        .status,
        StatusCode::CONFLICT
    );
    assert!(
        data(&router, "GET", INBOX, Some(&member_cookie), None).await["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == id)
    );
    assert_eq!(
        request(
            &router,
            "POST",
            &format!("{item}/archive"),
            Some(&admin_cookie),
            None
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&router, "DELETE", &item, Some(&admin_cookie), None)
            .await
            .status,
        StatusCode::NO_CONTENT
    );

    let mut disabled = saved.clone();
    disabled["panel"]["features"]["registration"] = json!(false);
    disabled["panel"]["features"]["announcements"] = json!(false);
    let disabled = data(
        &router,
        "PUT",
        SETTINGS,
        Some(&admin_cookie),
        Some(disabled),
    )
    .await;
    assert_eq!(
        request(&router, "GET", "/register", None, None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&router, "GET", INBOX, Some(&member_cookie), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let mut restored = original;
    restored["revision"] = disabled["revision"].clone();
    data(
        &router,
        "PUT",
        SETTINGS,
        Some(&admin_cookie),
        Some(restored),
    )
    .await;

    let another = login(&router, &replacement, "/workspace").await;
    let (first, second) = tokio::join!(
        request(&router, "DELETE", SESSIONS, Some(&member_cookie), None),
        request(&router, "DELETE", SESSIONS, Some(&another), None),
    );
    let (winner, loser) = if first.status == StatusCode::NO_CONTENT {
        assert_eq!(second.status, StatusCode::NOT_FOUND);
        (&member_cookie, &another)
    } else {
        assert_eq!(first.status, StatusCode::NOT_FOUND);
        assert_eq!(second.status, StatusCode::NO_CONTENT);
        (&another, &member_cookie)
    };
    for (cookie, active) in [(winner, true), (loser, false)] {
        assert_eq!(
            data(&router, "GET", "/auth/session", Some(cookie), None).await["signed_in"],
            active
        );
    }
}

#[tokio::test]
async fn fullscreen_and_scheduled_announcements_respect_display_window() {
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
    let email = |name: &str| format!("{name}.{}@example.net", Uuid::new_v4());
    let admin = email("sched-admin");
    let member = email("sched-member");
    for (address, owner) in [(&admin, true), (&member, false)] {
        accounts::create(
            &app.db,
            &app.auth,
            address.clone(),
            PASSWORD.into(),
            owner,
            true,
        )
        .await
        .unwrap();
    }
    let admin_cookie = login(&router, &admin, "/admin").await;
    let member_cookie = login(&router, &member, "/workspace").await;

    let now = chrono::Utc::now();
    // Invalid schedule (ends_at <= starts_at) rejected with 400
    let invalid = request(
        &router,
        "POST",
        ANNOUNCEMENTS,
        Some(&admin_cookie),
        Some(json!({
            "title": "Bad window",
            "body": "Invalid schedule",
            "display_mode": "fullscreen",
            "starts_at": (now + chrono::TimeDelta::hours(2)).to_rfc3339(),
            "ends_at": (now + chrono::TimeDelta::hours(1)).to_rfc3339(),
        })),
    )
    .await;
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST);

    // 1. Active fullscreen announcement
    let active_fs = data(
        &router,
        "POST",
        ANNOUNCEMENTS,
        Some(&admin_cookie),
        Some(json!({
            "title": "Active Fullscreen Notice",
            "body": "Important maintenance details.",
            "display_mode": "fullscreen",
            "starts_at": (now - chrono::TimeDelta::minutes(5)).to_rfc3339(),
            "ends_at": (now + chrono::TimeDelta::hours(24)).to_rfc3339(),
        })),
    )
    .await;
    let active_id = active_fs["id"].as_str().unwrap().to_string();

    // 2. Future scheduled fullscreen announcement (should NOT show yet)
    let future_fs = data(
        &router,
        "POST",
        ANNOUNCEMENTS,
        Some(&admin_cookie),
        Some(json!({
            "title": "Future Notice",
            "body": "Starts next week.",
            "display_mode": "fullscreen",
            "starts_at": (now + chrono::TimeDelta::days(7)).to_rfc3339(),
            "ends_at": (now + chrono::TimeDelta::days(14)).to_rfc3339(),
        })),
    )
    .await;
    let future_id = future_fs["id"].as_str().unwrap().to_string();

    // 3. Expired normal announcement (should NOT show)
    let expired_normal = data(
        &router,
        "POST",
        ANNOUNCEMENTS,
        Some(&admin_cookie),
        Some(json!({
            "title": "Expired Notice",
            "body": "Already ended.",
            "display_mode": "normal",
            "starts_at": (now - chrono::TimeDelta::days(3)).to_rfc3339(),
            "ends_at": (now - chrono::TimeDelta::minutes(1)).to_rfc3339(),
        })),
    )
    .await;
    let expired_id = expired_normal["id"].as_str().unwrap().to_string();

    for id in [&active_id, &future_id, &expired_id] {
        assert_eq!(
            request(
                &router,
                "POST",
                &format!("{ANNOUNCEMENTS}/{id}/publish"),
                Some(&admin_cookie),
                None,
            )
            .await
            .status,
            StatusCode::ACCEPTED
        );
    }
    while messages::drain(&app.db).await.unwrap() > 0 {}

    // Member sees ONLY the active fullscreen announcement
    let summary = data(&router, "GET", &format!("{INBOX}/unread"), Some(&member_cookie), None).await;
    let fullscreen = summary["fullscreen"].as_array().unwrap();
    assert!(fullscreen.iter().any(|n| n["id"] == active_id && n["display_mode"] == "fullscreen"));
    assert!(fullscreen.iter().all(|n| n["id"] != future_id && n["id"] != expired_id));

    let inbox = data(&router, "GET", INBOX, Some(&member_cookie), None).await;
    let items = inbox["items"].as_array().unwrap();
    assert!(items.iter().any(|n| n["id"] == active_id && n["display_mode"] == "fullscreen"));
    assert!(items.iter().all(|n| n["id"] != future_id && n["id"] != expired_id));

    // Mark active fullscreen announcement as read -> clears from fullscreen popup list
    assert_eq!(
        request(
            &router,
            "PUT",
            &format!("{INBOX}/read"),
            Some(&member_cookie),
            Some(json!({"ids": [active_id]})),
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    let after = data(&router, "GET", &format!("{INBOX}/unread"), Some(&member_cookie), None).await;
    assert!(
        after["fullscreen"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["id"] != active_id)
    );

    // Clean up published test notices so other tests remain clean
    for id in [&active_id, &future_id, &expired_id] {
        assert_eq!(
            request(
                &router,
                "POST",
                &format!("{ANNOUNCEMENTS}/{id}/archive"),
                Some(&admin_cookie),
                None,
            )
            .await
            .status,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            request(
                &router,
                "DELETE",
                &format!("{ANNOUNCEMENTS}/{id}"),
                Some(&admin_cookie),
                None,
            )
            .await
            .status,
            StatusCode::NO_CONTENT
        );
    }
}

#[tokio::test]
async fn poison_messages_retry_then_stop_without_blocking_the_queue() {
    let Ok(url) = std::env::var("YUZUKI_TEST_PORTAL_QUEUE_URL") else {
        return;
    };
    let db = postgres::connect(&url).await.unwrap();
    migration::run(&db).await.unwrap();
    let job = db
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "INSERT INTO message_jobs (kind,payload) VALUES ('unsupported','{}') RETURNING id",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "id")
        .unwrap();
    let no_longer_needed = Uuid::new_v4();
    messages::enqueue(
        &db,
        messages::Message::PublishAnnouncement {
            announcement_id: no_longer_needed,
        },
    )
    .await
    .unwrap();
    for attempt in 1_i16..=6 {
        assert_eq!(
            messages::drain(&db).await.unwrap(),
            if attempt == 1 { 2 } else { 1 }
        );
        let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "SELECT attempts, failed_at IS NOT NULL AS failed, available_at > now() AS waiting FROM message_jobs WHERE id = $1",
            [job.into()])).await.unwrap().unwrap();
        assert_eq!(row.try_get::<i16>("", "attempts").unwrap(), attempt);
        assert_eq!(row.try_get::<bool>("", "failed").unwrap(), attempt == 6);
        assert!(row.try_get::<bool>("", "waiting").unwrap());
        db.execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE message_jobs SET available_at = now() WHERE id = $1",
            [job.into()],
        ))
        .await
        .unwrap();
    }
    assert_eq!(messages::drain(&db).await.unwrap(), 0);
    let completed = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "SELECT completed_at IS NOT NULL AS completed FROM message_jobs WHERE payload->>'announcement_id' = $1",
        [no_longer_needed.to_string().into()])).await.unwrap().unwrap();
    assert!(completed.try_get::<bool>("", "completed").unwrap());
}

struct Response {
    status: StatusCode,
    headers: header::HeaderMap,
    body: axum::body::Bytes,
}

impl Response {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|error| {
            panic!("{error}: {}", String::from_utf8_lossy(&self.body));
        })
    }
}

async fn login(router: &Router, email: &str, expected_workspace: &str) -> String {
    let response = request(
        router,
        "POST",
        "/auth/login",
        None,
        Some(json!({
            "email": email, "password": PASSWORD,
        })),
    )
    .await;
    assert_eq!(response.status, StatusCode::NO_CONTENT);
    assert_eq!(response.headers["x-workspace-path"], expected_workspace);
    response.headers[header::SET_COOKIE]
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
    cookie: Option<&str>,
    body: Option<Value>,
) -> Value {
    let response = request(router, method, path, cookie, body).await;
    assert!(
        response.status.is_success(),
        "{method} {path}: {} {}",
        response.status,
        String::from_utf8_lossy(&response.body)
    );
    response.json()
}

async fn request(
    router: &Router,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-workspace-request", "1")
        .header(header::USER_AGENT, "Portal integration");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let body = if let Some(body) = body {
        request = request.header(header::CONTENT_TYPE, "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    let response = router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    Response {
        status: parts.status,
        headers: parts.headers,
        body: to_bytes(body, 1024 * 1024).await.unwrap(),
    }
}
