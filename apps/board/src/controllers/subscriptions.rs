use std::net::SocketAddr;

use axum::{
    Extension,
    extract::{ConnectInfo, Path, RawQuery, State},
    http::{HeaderMap, Method, header::CONTENT_TYPE},
    response::IntoResponse,
};
use serde::Deserialize;
use yuzuki_core_config::Format;

use crate::{
    app::State as App,
    infra::{
        error::{Error, Result},
        network::client_address,
    },
    services::subscriptions::{self, devices::Device},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    f: String,
}

pub async fn download(
    State(app): State<App>,
    Path(token): Path<String>,
    address: Option<Extension<ConnectInfo<SocketAddr>>>,
    RawQuery(query): RawQuery,
    method: Method,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let format = query
        .as_deref()
        .and_then(|q| serde_urlencoded::from_str::<Query>(q).ok())
        .and_then(|q| Format::from_code(&q.f))
        .ok_or(Error::NotFound)?;
    let device = (method == Method::GET).then(|| {
        let peer = address.map(|Extension(ConnectInfo(address))| address.ip());
        Device::from_request(
            &headers,
            client_address(peer, &headers, &app.settings.trusted_proxies),
        )
    });
    let document =
        subscriptions::render(&app.db, app.renderer.as_ref(), &token, format, device).await?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(CONTENT_TYPE, document.content_type);
    for (name, value) in document.headers {
        response_headers.insert(name, value);
    }
    Ok((response_headers, document.body))
}
