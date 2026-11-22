mod location;
pub mod presence;
mod traffic;

use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseBackend, FromQueryResult, Statement};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    infra::error::Result,
    services::access::{Access, Permission},
};

pub use location::{Location, clear_location, read_location, write_location};
pub use traffic::prune_history;

#[derive(Clone, Copy, Deserialize, Default)]
pub enum Range {
    #[serde(rename = "1h")]
    Hour,
    #[default]
    #[serde(rename = "24h")]
    Day,
    #[serde(rename = "7d")]
    Week,
}

impl Range {
    fn minutes(self) -> (i32, i32) {
        match self {
            Self::Hour => (60, 1),
            Self::Day => (1_440, 15),
            Self::Week => (10_080, 120),
        }
    }
}

#[derive(Serialize)]
pub struct Overview {
    as_of: DateTime<Utc>,
    accounts: Option<AccountCounts>,
    infrastructure: Option<Infrastructure>,
}

#[derive(FromQueryResult, Serialize)]
struct AccountCounts {
    users: i64,
    enabled_users: i64,
    active_console_sessions: i64,
    recent_subscription_devices: i64,
}

#[derive(Serialize)]
struct Infrastructure {
    totals: traffic::Traffic,
    last_minute: traffic::Traffic,
    registered_nodes: i64,
    online_agents: i64,
    published_nodes: i64,
    attention_nodes: i64,
    timeseries: Vec<traffic::Point>,
    locations: Vec<LocationSummary>,
    presence: presence::Presence,
}

#[derive(FromQueryResult)]
struct InfrastructureCounts {
    registered_nodes: i64,
    online_agents: i64,
    published_nodes: i64,
    attention_nodes: i64,
}

#[derive(FromQueryResult, Serialize)]
struct LocationSummary {
    id: Uuid,
    label: String,
    name: String,
    latitude: f64,
    longitude: f64,
    online: bool,
    uploaded: String,
    downloaded: String,
}

pub async fn overview(
    db: &impl ConnectionTrait,
    access: &Access,
    range: Range,
) -> Result<Overview> {
    let as_of = Utc::now();
    let (accounts, infrastructure) = tokio::try_join!(
        async {
            if access.allows(Permission::UsersRead) {
                accounts(db, as_of).await.map(Some)
            } else {
                Ok(None)
            }
        },
        async {
            if access.allows(Permission::NodesRead) {
                infrastructure(db, as_of, range).await.map(Some)
            } else {
                Ok(None)
            }
        },
    )?;
    Ok(Overview {
        as_of,
        accounts,
        infrastructure,
    })
}

async fn accounts(db: &impl ConnectionTrait, as_of: DateTime<Utc>) -> Result<AccountCounts> {
    AccountCounts::find_by_statement(sql(
        "SELECT
         (SELECT count(*) FROM accounts) AS users,
         (SELECT count(*) FROM accounts WHERE active) AS enabled_users,
         (SELECT count(*) FROM sessions s JOIN accounts a ON a.id = s.account_id
          WHERE a.active AND s.expires_at > $1 AND s.last_seen_at > $1::timestamptz - INTERVAL '5 minutes') AS active_console_sessions,
         (SELECT count(*) FROM subscription_devices d JOIN accounts a ON a.id = d.account_id
          WHERE a.active AND d.last_seen_at > $1::timestamptz - INTERVAL '15 minutes') AS recent_subscription_devices",
        [as_of.into()],
    ))
    .one(db)
    .await?
    .ok_or_else(invalid_result)
}

async fn infrastructure(
    db: &impl ConnectionTrait,
    as_of: DateTime<Utc>,
    range: Range,
) -> Result<Infrastructure> {
    let counts = InfrastructureCounts::find_by_statement(sql(
        "SELECT
            (SELECT count(*) FROM servers WHERE deleted_at IS NULL) AS registered_nodes,
            (SELECT count(*) FROM servers
             WHERE deleted_at IS NULL AND session_id IS NOT NULL
               AND last_seen_at > $1::timestamptz - INTERVAL '60 seconds') AS online_agents,
            (SELECT count(*) FROM proxy_nodes
             WHERE deleted_at IS NULL AND enabled AND show) AS published_nodes,
            (SELECT count(*) FROM servers s
             WHERE s.deleted_at IS NULL AND (
                (EXISTS (SELECT 1 FROM proxy_nodes n WHERE n.server_id = s.id AND n.deleted_at IS NULL AND n.enabled)
                 AND (s.session_id IS NULL OR s.last_seen_at IS NULL OR s.last_seen_at <= $1::timestamptz - INTERVAL '60 seconds'))
                OR s.deployment_error IS NOT NULL
                OR jsonb_array_length(s.config_warnings) > 0
                OR jsonb_path_exists(s.runtime_status, '$[*] ? (@.running == false)')
             )) AS attention_nodes",
        [as_of.into()],
    ))
    .one(db)
    .await?
    .ok_or_else(invalid_result)?;
    let (totals, last_minute, timeseries, locations, presence) = tokio::try_join!(
        traffic::totals(db),
        traffic::last_minute(db, as_of),
        traffic::points(db, as_of, range),
        locations(db, as_of, range),
        presence::read(db, as_of)
    )?;
    Ok(Infrastructure {
        registered_nodes: counts.registered_nodes,
        online_agents: counts.online_agents,
        published_nodes: counts.published_nodes,
        attention_nodes: counts.attention_nodes,
        totals,
        last_minute,
        timeseries,
        locations,
        presence,
    })
}

async fn locations(
    db: &impl ConnectionTrait,
    as_of: DateTime<Utc>,
    range: Range,
) -> Result<Vec<LocationSummary>> {
    let query = format!(
        "{} SELECT s.id, s.name, l.label, l.latitude, l.longitude,
                COALESCE(s.session_id IS NOT NULL AND s.last_seen_at > $1::timestamptz - INTERVAL '60 seconds', false) AS online,
                COALESCE(r.uploaded, 0)::text AS uploaded, COALESCE(r.downloaded, 0)::text AS downloaded
         FROM server_locations l
         JOIN servers s ON l.server_id = s.id AND s.deleted_at IS NULL
         LEFT JOIN (
            SELECT server_id, sum(uploaded) AS uploaded, sum(downloaded) AS downloaded
            FROM period_usage GROUP BY server_id
         ) r ON r.server_id = s.id ORDER BY s.name, s.id",
        traffic::window(range)
    );
    Ok(
        LocationSummary::find_by_statement(sql(&query, [as_of.into(), range.minutes().0.into()]))
            .all(db)
            .await?,
    )
}

fn sql(query: &str, values: impl IntoIterator<Item = sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, query, values)
}

fn invalid_result() -> crate::infra::error::Error {
    crate::infra::error::Error::Internal(anyhow::anyhow!("dashboard aggregate returned no row"))
}
