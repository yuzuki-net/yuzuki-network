use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use board::{app, infra::config::Settings};
use sea_orm::DatabaseConnection;
use tower::ServiceExt;

#[tokio::test]
async fn anonymous_requests_hide_private_surfaces() {
    let state = app::State::new(DatabaseConnection::Disconnected, Settings::default())
        .await
        .unwrap();
    let router = app::router(state);
    for (method, path) in [
        ("GET", "/workspace"),
        ("GET", "/api/v1/admin/nodes"),
        ("POST", "/api/v1/admin/nodes"),
        ("PATCH", "/api/v1/me"),
        ("GET", "/auth/login"),
        ("POST", "/auth/register"),
        ("GET", "/documents/invalid?f=0"),
        ("GET", "/documents/invalid?f=xray"),
    ] {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {path}");
        assert!(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .is_empty()
        );
    }
}

#[tokio::test]
async fn custom_home_falls_back_to_embedded_login_and_hides_workspace_assets() {
    let directory = std::env::temp_dir().join(format!("yuzuki-public-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(directory.join("assets")).unwrap();
    std::fs::write(directory.join("index.html"), "Custom home").unwrap();
    let css = ".custom-company-site { color: midnightblue; }\n".repeat(40);
    std::fs::write(directory.join("assets/theme.css"), &css).unwrap();
    let settings = Settings {
        public_dir: Some(directory.clone()),
        ..Settings::default()
    };
    let router = app::router(
        app::State::new(DatabaseConnection::Disconnected, settings)
            .await
            .unwrap(),
    );
    for (path, expected, contains) in [
        ("/", StatusCode::OK, "Custom home"),
        ("/login", StatusCode::OK, "/assets/login-"),
        ("/register", StatusCode::NOT_FOUND, ""),
        ("/workspace/assets/test.js", StatusCode::NOT_FOUND, ""),
    ] {
        let response = router
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        let text = axum::body::to_bytes(response.into_body(), 65_536)
            .await
            .unwrap();
        assert!(std::str::from_utf8(&text).unwrap().contains(contains));
    }
    let request = |encoding: &str, path: &str| {
        Request::builder()
            .uri(path)
            .header(header::ACCEPT_ENCODING, encoding)
            .body(Body::empty())
            .unwrap()
    };
    let compressed = router
        .clone()
        .oneshot(request("gzip", "/assets/theme.css"))
        .await
        .unwrap();
    assert_eq!(compressed.headers()[header::CONTENT_ENCODING], "gzip");
    assert!(
        compressed.headers()[header::VARY]
            .to_str()
            .unwrap()
            .contains("accept-encoding")
    );
    assert!(
        axum::body::to_bytes(compressed.into_body(), 65_536)
            .await
            .unwrap()
            .starts_with(&[0x1f, 0x8b])
    );
    let plain = router
        .clone()
        .oneshot(request("gzip;q=0", "/assets/theme.css"))
        .await
        .unwrap();
    assert!(!plain.headers().contains_key(header::CONTENT_ENCODING));
    assert_eq!(
        axum::body::to_bytes(plain.into_body(), 65_536)
            .await
            .unwrap()
            .as_ref(),
        css.as_bytes()
    );
    let private_asset = router
        .oneshot(request("gzip", "/workspace/assets/private.js"))
        .await
        .unwrap();
    assert_eq!(private_asset.status(), StatusCode::NOT_FOUND);
    assert!(
        !private_asset
            .headers()
            .contains_key(header::CONTENT_ENCODING)
    );
    std::fs::remove_dir_all(directory).unwrap();
}
