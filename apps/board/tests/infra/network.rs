use axum::http::{HeaderMap, HeaderValue};
use board::infra::network::client_address;
use std::net::IpAddr;

#[test]
fn subscription_address_resolves_only_through_known_proxy_hops() {
    let ip = |value: &str| value.parse::<IpAddr>().unwrap();
    let peer = Some(ip("127.0.0.1"));
    let trusted = [ip("127.0.0.1"), ip("192.0.2.10")];
    let mut headers = HeaderMap::new();
    headers.append(
        "x-forwarded-for",
        HeaderValue::from_static("disregard this, 198.51.100.5"),
    );
    headers.append(
        "x-forwarded-for",
        HeaderValue::from_static("203.0.113.42, ::ffff:192.0.2.10"),
    );
    assert_eq!(
        client_address(peer, &headers, &trusted),
        Some(ip("203.0.113.42"))
    );
    assert_eq!(client_address(peer, &headers, &[]), peer);
    assert_eq!(client_address(None, &headers, &trusted), None);
    headers.append(
        "x-forwarded-for",
        HeaderValue::from_static("not an address"),
    );
    assert_eq!(client_address(peer, &headers, &trusted), peer);
}
