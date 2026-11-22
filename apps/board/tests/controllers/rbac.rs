use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header::SET_COOKIE},
};
use board::{
    app::{self, State},
    infra::{config::Settings, migration, postgres},
    services::accounts,
};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "test-login-password";
const ADMIN_ROLE: &str = "00000000-0000-4000-8000-000000000000";
const MEMBER: &str = "00000000-0000-4000-8000-000000000001";

#[tokio::test]
async fn permission_points_gate_routes_and_prevent_escalation() {
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
    let root = accounts::create(
        &app.db,
        &app.auth,
        email("owner"),
        PASSWORD.into(),
        true,
        true,
    )
    .await
    .unwrap();
    let operator = accounts::create(
        &app.db,
        &app.auth,
        email("operator"),
        PASSWORD.into(),
        false,
        true,
    )
    .await
    .unwrap();
    let subject = accounts::create(
        &app.db,
        &app.auth,
        email("subject"),
        PASSWORD.into(),
        false,
        true,
    )
    .await
    .unwrap();
    let root_cookie = login(&router, &root.email, PASSWORD).await;
    let operator_cookie = login(&router, &operator.email, PASSWORD).await;
    let subject_cookie = login(&router, &subject.email, PASSWORD).await;
    let own = format!("/api/v1/admin/users/{}/access", operator.id);
    let assignment = format!("/api/v1/admin/users/{}/access", subject.id);

    let root_profile = data(&router, "GET", "/api/v1/me", &root_cookie, None).await;
    assert_eq!(root_profile["access"]["owner"], true);
    assert_eq!(root_profile["access"]["roles"][0]["id"], ADMIN_ROLE);
    assert_eq!(root_profile["access"]["roles"][0]["locked"], true);

    // Multiple N admins all display the locked Administrator role and cannot edit it.
    let second_admin = accounts::create(
        &app.db,
        &app.auth,
        email("owner2"),
        PASSWORD.into(),
        true,
        true,
    )
    .await
    .unwrap();
    let second_admin_access = data(
        &router,
        "GET",
        &format!("/api/v1/admin/users/{}/access", second_admin.id),
        &root_cookie,
        None,
    )
    .await;
    assert_eq!(second_admin_access["roles"][0]["id"], ADMIN_ROLE);
    assert_eq!(second_admin_access["roles"][0]["locked"], true);

    // Built-in Administrator role is listed and locked against PUT/DELETE & assignment.
    let roles_list = data(&router, "GET", "/api/v1/admin/roles", &root_cookie, None).await;
    assert_eq!(roles_list[0]["id"], ADMIN_ROLE);
    assert_eq!(roles_list[0]["locked"], true);
    assert_eq!(
        call(
            &router,
            "PUT",
            &format!("/api/v1/admin/roles/{ADMIN_ROLE}"),
            Some(&root_cookie),
            Some(json!({"name": "Hacked", "description": "", "permissions": []})),
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &router,
            "DELETE",
            &format!("/api/v1/admin/roles/{ADMIN_ROLE}"),
            Some(&root_cookie),
            None,
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            &format!("/api/v1/admin/users/{}/access", second_admin.id),
            Some(&root_cookie),
            Some(json!({"roles": [MEMBER], "overrides": {}})),
        )
        .await
        .0,
        StatusCode::CONFLICT
    );

    let profile = data(&router, "GET", "/api/v1/me", &operator_cookie, None).await;
    assert_eq!(profile["access"]["owner"], false);
    assert_eq!(profile["access"]["roles"][0]["id"], MEMBER);
    assert_eq!(profile["admin_workspace"], false);
    for path in [
        "/admin",
        "/admin/users",
        "/admin/assets/admin.js",
        "/api/v1/admin/directory",
    ] {
        assert_hidden(&router, "GET", path, &operator_cookie, None).await;
    }
    let existing = data(&router, "GET", "/api/v1/me/subscriptions", &subject_cookie, None).await;
    assert_eq!(existing["links"].as_array().unwrap().len(), 4);
    let token_path = existing["links"][0]["path"].as_str().unwrap().to_string();

    let reader = data(&router, "POST", "/api/v1/admin/roles", &root_cookie, Some(json!({
        "name": format!("Operators {}", Uuid::new_v4()), "description": "Scoped directory and delegation",
        "permissions": ["users.read","users.update","roles.read","roles.assign","roles.manage"]
    }))).await;
    data(
        &router,
        "PUT",
        &own,
        &root_cookie,
        Some(json!({"roles":[MEMBER, reader["id"]],"overrides":{}})),
    )
    .await;
    let page = call(&router, "GET", "/admin/users", Some(&operator_cookie), None).await;
    assert_eq!(page.0, StatusCode::OK);
    let html = std::str::from_utf8(&page.2).unwrap();
    let console_asset = html
        .split('"')
        .find(|part| part.starts_with("/workspace/assets/") && part.ends_with(".js"))
        .unwrap();
    let admin_asset = console_asset.replacen("/workspace/assets/", "/admin/assets/", 1);
    assert_hidden(&router, "GET", &admin_asset, &operator_cookie, None).await;
    let entry = call(&router, "GET", console_asset, Some(&operator_cookie), None).await;
    assert_eq!(entry.0, StatusCode::OK);
    let admin_chunk = std::str::from_utf8(&entry.2)
        .unwrap()
        .split('"')
        .find(|part| part.ends_with(".js") && part.contains("admin-accounts-"))
        .and_then(|part| part.rsplit('/').next())
        .expect("the user directory has a distinct lazy chunk");
    let guarded = format!("/workspace/assets/{admin_chunk}");
    assert_hidden(&router, "GET", &guarded, &subject_cookie, None).await;

    let display_name = format!("Scoped user {}", subject.id);
    data(
        &router,
        "PUT",
        &format!("/api/v1/admin/users/{}/profile", subject.id),
        &operator_cookie,
        Some(json!({"email":subject.email,"display_name":display_name})),
    )
    .await;
    let directory = data(
        &router,
        "GET",
        &format!(
            "/api/v1/admin/directory?q={}",
            display_name.replace(' ', "%20")
        ),
        &operator_cookie,
        None,
    )
    .await;
    assert_eq!(directory["total"], 1);
    assert_eq!(directory["items"][0]["display_name"], display_name);
    assert_eq!(directory["items"][0]["used_bytes"], "");
    let owner_details = data(
        &router,
        "GET",
        &format!("/api/v1/admin/users/{}", root.id),
        &operator_cookie,
        None,
    )
    .await;
    let subject_details = data(
        &router,
        "GET",
        &format!("/api/v1/admin/users/{}", subject.id),
        &operator_cookie,
        None,
    )
    .await;
    assert_eq!(owner_details["actions"]["profile"], false);
    assert_eq!(subject_details["actions"]["profile"], true);
    assert_eq!(subject_details["actions"]["quota"], false);
    assert_hidden(
        &router,
        "GET",
        "/api/v1/admin/quotas",
        &operator_cookie,
        None,
    )
    .await;
    assert_hidden(
        &router,
        "PUT",
        &format!("/api/v1/admin/quotas/{}/policy", subject.id),
        &operator_cookie,
        Some(json!({"max_devices":2})),
    )
    .await;
    assert_hidden(
        &router,
        "PUT",
        &format!("/api/v1/admin/users/{}/status", root.id),
        &operator_cookie,
        Some(json!({"active":false})),
    )
    .await;
    assert_hidden(
        &router,
        "PUT",
        &own,
        &operator_cookie,
        Some(json!({"roles":[],"overrides":{}})),
    )
    .await;
    assert_hidden(
        &router,
        "POST",
        "/api/v1/admin/roles",
        &operator_cookie,
        Some(json!({"name":"Illegal escalation","description":"","permissions":["quotas.manage"]})),
    )
    .await;
    assert_hidden(
        &router,
        "PUT",
        &assignment,
        &operator_cookie,
        Some(json!({"roles":[MEMBER],"overrides":{"quotas.manage":true}})),
    )
    .await;
    assert_hidden(
        &router,
        "DELETE",
        &format!("/api/v1/admin/roles/{MEMBER}"),
        &root_cookie,
        None,
    )
    .await;

    let scoped = data(
        &router,
        "PUT",
        &assignment,
        &operator_cookie,
        Some(json!({"roles":[MEMBER],"overrides":{"users.read":true,"subscriptions.read":false}})),
    )
    .await;
    assert!(
        !scoped["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|key| key == "subscriptions.read")
    );
    assert_eq!(
        call(&router, "GET", "/admin/users", Some(&subject_cookie), None)
            .await
            .0,
        StatusCode::OK
    );
    assert_hidden(
        &router,
        "GET",
        "/workspace/subscriptions",
        &subject_cookie,
        None,
    )
    .await;
    assert_hidden(
        &router,
        "POST",
        "/api/v1/me/subscriptions",
        &subject_cookie,
        Some(json!({"name":"Blocked","format":0})),
    )
    .await;
    let denied = call(&router, "GET", &token_path, None, None).await;
    assert_eq!(denied.0, StatusCode::NOT_FOUND);
    assert!(denied.2.is_empty());

    let events = data(&router, "GET", "/api/v1/admin/audit", &root_cookie, None).await;
    assert!(events.as_array().unwrap().iter().any(|event| {
        event["actor"] == operator.email && event["action"] == "account.access_updated"
    }));
    let filtered = data(
        &router,
        "GET",
        &format!("/api/v1/admin/audit?kind=permissions&q={}", operator.email),
        &root_cookie,
        None,
    )
    .await;
    assert!(!filtered.as_array().unwrap().is_empty());
    assert!(filtered.as_array().unwrap().iter().all(|event| {
        event["actor"] == operator.email
            && (event["action"] == "account.access_updated"
                || event["action"].as_str().unwrap().starts_with("role."))
    }));
    assert_hidden(
        &router,
        "DELETE",
        "/api/v1/admin/routing/draft",
        &operator_cookie,
        None,
    )
    .await;
    assert_hidden(
        &router,
        "GET",
        "/api/v1/admin/audit",
        &operator_cookie,
        None,
    )
    .await;

    data(
        &router,
        "PUT",
        &own,
        &root_cookie,
        Some(json!({"roles":[MEMBER],"overrides":{}})),
    )
    .await;
    assert_hidden(&router, "GET", "/admin/users", &operator_cookie, None).await;

    let password = "new-test-password";
    let response = call(
        &router,
        "PUT",
        "/api/v1/me/password",
        Some(&subject_cookie),
        Some(json!({"current_password":PASSWORD, "new_password":password})),
    )
    .await;
    assert_eq!(response.0, StatusCode::NO_CONTENT);
    assert_hidden(&router, "GET", "/api/v1/me", &subject_cookie, None).await;
    login(&router, &subject.email, password).await;
}

async fn login(router: &Router, email: &str, password: &str) -> String {
    let (status, headers, _) = call(
        router,
        "POST",
        "/auth/login",
        None,
        Some(json!({"email":email,"password":password})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{email}");
    headers[SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into()
}

async fn assert_hidden(
    router: &Router,
    method: &str,
    path: &str,
    cookie: &str,
    payload: Option<Value>,
) {
    let (status, _, body) = call(router, method, path, Some(cookie), payload).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
    assert!(body.is_empty(), "{method} {path}");
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
