use std::net::IpAddr;

use axum::http::HeaderMap;

const MAX_FORWARDED_HOPS: usize = 16;

pub fn client_address(
    peer: Option<IpAddr>,
    headers: &HeaderMap,
    trusted: &[IpAddr],
) -> Option<IpAddr> {
    let peer = peer?.to_canonical();
    let trusted = |address| trusted.iter().any(|proxy| proxy.to_canonical() == address);
    if !trusted(peer) {
        return Some(peer);
    }
    forwarded_address(headers, trusted).or(Some(peer))
}

fn forwarded_address(headers: &HeaderMap, trusted: impl Fn(IpAddr) -> bool) -> Option<IpAddr> {
    let mut hops = 0;
    for header in headers.get_all("x-forwarded-for").iter().rev() {
        for address in header.as_bytes().rsplit(|&byte| byte == b',') {
            if hops == MAX_FORWARDED_HOPS {
                return None;
            }
            hops += 1;
            let address = std::str::from_utf8(address)
                .ok()?
                .trim()
                .parse::<IpAddr>()
                .ok()?
                .to_canonical();
            if !trusted(address) {
                return Some(address);
            }
        }
    }
    None
}
