use std::{collections::BTreeMap, net::SocketAddr, time::Duration};

use anyhow::{Context, Result, ensure};
use prost::Message;
use serde::Deserialize;
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{Instance, Meter, OnlineSource},
};

use super::devices;
use crate::services::metering::{Reading, ports::UsageCollector};

pub struct NativeCollector(reqwest::Client);

impl NativeCollector {
    pub fn new() -> Result<Self> {
        Ok(Self(
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(4))
                .build()?,
        ))
    }
}

#[async_trait::async_trait]
impl UsageCollector for NativeCollector {
    async fn online(
        &self,
        instance: &Instance,
        key: &[u8; 32],
    ) -> Result<Option<Vec<OnlineSource>>> {
        devices::sample(&self.0, instance, key).await
    }

    async fn sample(&self, instance: &Instance) -> Result<Vec<Reading>> {
        match &instance.meter {
            None => Ok(Vec::new()),
            Some(Meter::UserStats { addr }) => stats(instance.core, *addr).await,
            Some(Meter::DedicatedTraffic {
                addr,
                access_id,
                secret,
            }) => {
                let mut response = self
                    .0
                    .get(format!("http://{addr}/traffic"))
                    .bearer_auth(secret)
                    .send()
                    .await?
                    .error_for_status()?;
                let mut line = Vec::new();
                while let Some(data) = response.chunk().await? {
                    line.extend_from_slice(&data);
                    ensure!(line.len() <= 8192, "traffic sample too large");
                    if let Some(end) = line.iter().position(|&byte| byte == b'\n') {
                        line.truncate(end);
                        break;
                    }
                    if serde_json::from_slice::<Traffic>(&line).is_ok() {
                        break;
                    }
                }
                let counters: Traffic = serde_json::from_slice(&line)?;
                Ok(vec![Reading {
                    access_id: *access_id,
                    uploaded: counters.up_total,
                    downloaded: counters.down_total,
                }])
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Traffic {
    up_total: i64,
    down_total: i64,
}

#[derive(Clone, PartialEq, Message)]
struct QueryStatsRequest {
    #[prost(string, tag = "1")]
    pattern: String,
    #[prost(bool, tag = "2")]
    reset: bool,
    #[prost(string, repeated, tag = "3")]
    patterns: Vec<String>,
}

#[derive(Clone, PartialEq, Message)]
struct Stat {
    #[prost(string, tag = "1")]
    name: String,
    #[prost(int64, tag = "2")]
    value: i64,
}

#[derive(Clone, PartialEq, Message)]
struct QueryStatsResponse {
    #[prost(message, repeated, tag = "1")]
    stat: Vec<Stat>,
}

async fn stats(core: Core, addr: SocketAddr) -> Result<Vec<Reading>> {
    let path = match core {
        Core::Xray => "/xray.app.stats.command.StatsService/QueryStats",
        // sing-box publishes its statistics service under the V2Ray-compatible name.
        Core::SingBox => "/v2ray.core.app.stats.command.StatsService/QueryStats",
        Core::Mihomo => anyhow::bail!("UserStats is unavailable for mihomo"),
    };
    let mut client = statistics_client(addr).await?;
    let request = QueryStatsRequest {
        pattern: "user>>>".into(),
        reset: false,
        patterns: if core == Core::SingBox {
            vec!["user>>>".into()]
        } else {
            Vec::new()
        },
    };
    let response: tonic::Response<QueryStatsResponse> = client
        .unary(
            tonic::Request::new(request),
            http::uri::PathAndQuery::from_static(path),
            tonic_prost::ProstCodec::default(),
        )
        .await?;
    let mut counters = BTreeMap::<Uuid, Reading>::new();
    for stat in response.into_inner().stat {
        let fields: Vec<_> = stat.name.split(">>>").collect();
        if let ["user", name, "traffic", direction] = fields.as_slice() {
            let Ok(access_id) = name.parse() else {
                continue;
            };
            let row = counters.entry(access_id).or_insert(Reading {
                access_id,
                uploaded: 0,
                downloaded: 0,
            });
            match *direction {
                "uplink" => row.uploaded = stat.value,
                "downlink" => row.downloaded = stat.value,
                _ => {}
            }
        }
    }
    Ok(counters.into_values().collect())
}

pub(super) async fn statistics_client(
    addr: SocketAddr,
) -> Result<tonic::client::Grpc<tonic::transport::Channel>> {
    ensure!(
        addr.ip().is_loopback(),
        "statistics must use a loopback address"
    );
    let endpoint = tonic::transport::Endpoint::from_shared(format!("http://{addr}"))?
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(2));
    let mut client = tonic::client::Grpc::new(endpoint.connect().await?);
    client
        .ready()
        .await
        .context("statistics service is not ready")?;
    Ok(client)
}
