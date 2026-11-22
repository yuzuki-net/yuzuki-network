use std::sync::Arc;

use crate::infra::postgres::repositories::quota_ledger::PostgresLedger;
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{
        HeaderValue, StatusCode,
        header::{CACHE_CONTROL, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS},
    },
    middleware,
};
use sea_orm::DatabaseConnection;
use yuzuki_core_config::cores::Registry;

use crate::{
    controllers,
    extensions::NativeRenderer,
    infra::{config::Settings, error::Result},
    services::{
        auth::Auth, nodes::broker::NodeBroker, quotas::QuotaLedger,
        subscriptions::ports::SubscriptionRenderer,
    },
};

#[derive(Clone)]
pub struct State {
    pub db: DatabaseConnection,
    pub settings: Arc<Settings>,
    pub public_dir: Arc<crate::infra::frontend::PublicDir>,
    pub auth: Arc<Auth>,
    pub renderer: Arc<dyn SubscriptionRenderer>,
    pub ledger: Arc<dyn QuotaLedger>,
    pub broker: NodeBroker,
}

impl State {
    pub async fn new(db: DatabaseConnection, settings: Settings) -> Result<Self> {
        Ok(Self {
            auth: Arc::new(Auth::new(settings.secure_cookies).await?),
            public_dir: Arc::new(
                crate::infra::frontend::PublicDir::resolve(settings.public_dir.as_deref()).await?,
            ),
            settings: Arc::new(settings),
            renderer: Arc::new(NativeRenderer(Registry::builtins())),
            ledger: Arc::new(PostgresLedger(db.clone())),
            broker: NodeBroker::default(),
            db,
        })
    }
}

pub fn router(state: State) -> Router {
    controllers::router(state)
        .layer(DefaultBodyLimit::max(512 * 1024))
        .method_not_allowed_fallback(not_found)
        .fallback(not_found)
        .layer(middleware::map_response(headers))
}

pub async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

pub async fn headers(mut response: axum::response::Response) -> axum::response::Response {
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}
