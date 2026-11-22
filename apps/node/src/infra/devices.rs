use std::{
    collections::BTreeSet,
    net::{IpAddr, SocketAddr},
};

use anyhow::{Result, ensure};
use prost::Message;
use reqwest::Client;
use ring::hmac;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{Instance, MAX_ONLINE_SOURCES, Meter, OnlineSource},
};

use super::metering::statistics_client;

const MAX_SAMPLE_BYTES: usize = 2 * 1024 * 1024;
const FINGERPRINT_CONTEXT: &[u8] = b"yuzuki-online-source-v1\0";

pub(super) async fn sample(
    http: &Client,
    instance: &Instance,
    key: &[u8; 32],
) -> Result<Option<Vec<OnlineSource>>> {
    let mut sample = SourceSample::new(key);
    match (instance.core, &instance.meter) {
        (Core::Xray, Some(Meter::UserStats { addr })) if xray_enabled(&instance.config) => {
            xray(*addr, &mut sample).await?;
        }
        (
            Core::Mihomo,
            Some(Meter::DedicatedTraffic {
                addr,
                access_id,
                secret,
            }),
        ) if mihomo_has_user(&instance.config, *access_id) => {
            mihomo(http, *addr, *access_id, secret, &mut sample).await?;
        }
        _ => return Ok(None),
    };
    Ok(Some(sample.sources.into_iter().collect()))
}

fn xray_enabled(config: &Value) -> bool {
    config["policy"]["levels"]
        .as_object()
        .is_some_and(|levels| {
            levels
                .values()
                .any(|level| level["statsUserOnline"] == true)
        })
}

fn mihomo_has_user(config: &Value, access_id: Uuid) -> bool {
    let id = access_id.to_string();
    config["listeners"].as_array().is_some_and(|listeners| {
        listeners.iter().any(|listener| match &listener["users"] {
            Value::Object(users) => users.contains_key(&id),
            Value::Array(users) => users.iter().any(|user| user["username"] == id),
            _ => false,
        })
    })
}

struct SourceSample {
    key: hmac::Key,
    sources: BTreeSet<OnlineSource>,
}

impl SourceSample {
    fn new(key: &[u8; 32]) -> Self {
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, key),
            sources: BTreeSet::new(),
        }
    }

    fn add(&mut self, access_id: Uuid, raw_address: &str) -> Result<()> {
        let address = raw_address
            .strip_prefix('[')
            .and_then(|address| address.strip_suffix(']'))
            .unwrap_or(raw_address);
        let Ok(address) = address.parse::<IpAddr>() else {
            return Ok(());
        };
        let mut mac = hmac::Context::with_key(&self.key);
        mac.update(FINGERPRINT_CONTEXT);
        mac.update(access_id.as_bytes());
        match address.to_canonical() {
            IpAddr::V4(address) => mac.update(&address.octets()),
            IpAddr::V6(address) => mac.update(&address.octets()),
        }
        let mut source = [0; 32];
        source.copy_from_slice(mac.sign().as_ref());
        self.sources.insert(OnlineSource { access_id, source });
        ensure!(
            self.sources.len() <= MAX_ONLINE_SOURCES,
            "online source sample exceeds the limit"
        );
        Ok(())
    }
}

#[derive(Clone, PartialEq, Message)]
struct GetUsersStatsRequest {}

#[derive(Clone, PartialEq, Message)]
struct OnlineEntry {
    #[prost(string, tag = "1")]
    ip: String,
}

#[derive(Clone, PartialEq, Message)]
struct UserStats {
    #[prost(string, tag = "1")]
    email: String,
    #[prost(message, repeated, tag = "2")]
    ips: Vec<OnlineEntry>,
}

#[derive(Clone, PartialEq, Message)]
struct GetUsersStatsResponse {
    #[prost(message, repeated, tag = "1")]
    users: Vec<UserStats>,
}

async fn xray(addr: SocketAddr, sample: &mut SourceSample) -> Result<()> {
    let mut grpc = statistics_client(addr)
        .await?
        .max_decoding_message_size(MAX_SAMPLE_BYTES);
    let result: tonic::Response<GetUsersStatsResponse> = grpc
        .unary(
            tonic::Request::new(GetUsersStatsRequest {}),
            http::uri::PathAndQuery::from_static(
                "/xray.app.stats.command.StatsService/GetUsersStats",
            ),
            tonic_prost::ProstCodec::default(),
        )
        .await?;
    for user in result.into_inner().users {
        let Ok(id) = user.email.parse() else { continue };
        for address in user.ips {
            sample.add(id, &address.ip)?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct MihomoSnapshot {
    connections: Option<Vec<MihomoConnection>>,
}

#[derive(Deserialize)]
struct MihomoConnection {
    metadata: MihomoMetadata,
}

#[derive(Deserialize)]
struct MihomoMetadata {
    #[serde(rename = "sourceIP")]
    source_ip: Option<String>,
    #[serde(rename = "inboundUser")]
    user: Option<String>,
}

async fn mihomo(
    http: &Client,
    addr: SocketAddr,
    id: Uuid,
    secret: &str,
    sample: &mut SourceSample,
) -> Result<()> {
    ensure!(
        addr.ip().is_loopback(),
        "connection statistics must use a loopback address"
    );
    let mut response = http
        .get(format!("http://{addr}/connections"))
        .bearer_auth(secret)
        .send()
        .await?
        .error_for_status()?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            body.len() + chunk.len() <= MAX_SAMPLE_BYTES,
            "connection statistics snapshot exceeds the limit"
        );
        body.extend_from_slice(&chunk);
    }
    let snapshot: MihomoSnapshot = serde_json::from_slice(&body)?;
    let expected = id.to_string();
    for connection in snapshot.connections.into_iter().flatten() {
        if let Some(source) = connection
            .metadata
            .source_ip
            .filter(|_| connection.metadata.user.as_deref() == Some(expected.as_str()))
        {
            sample.add(id, &source)?;
        }
    }
    Ok(())
}
