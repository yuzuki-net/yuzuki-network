use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, FromQueryResult};
use serde::Serialize;

use super::{Range, invalid_result, sql};
use crate::infra::error::Result;

#[derive(FromQueryResult, Serialize)]
pub struct Traffic {
    pub uploaded: String,
    pub downloaded: String,
}

#[derive(FromQueryResult, Serialize)]
pub struct Point {
    timestamp: DateTime<Utc>,
    uploaded: String,
    downloaded: String,
}

pub async fn totals(db: &impl ConnectionTrait) -> Result<Traffic> {
    Traffic::find_by_statement(sql(
        "SELECT COALESCE(sum(uploaded), 0)::text AS uploaded, COALESCE(sum(downloaded), 0)::text AS downloaded
         FROM server_usage_days",
        [],
    ))
    .one(db)
    .await?
    .ok_or_else(invalid_result)
}

pub async fn prune_history(db: &impl ConnectionTrait) -> Result<()> {
    db.execute_unprepared(
        "DELETE FROM server_usage_minutes WHERE bucket < now() - INTERVAL '8 days';
         DELETE FROM server_usage_hours WHERE bucket < now() - INTERVAL '8 days';",
    )
    .await?;
    Ok(())
}

pub async fn last_minute(db: &impl ConnectionTrait, as_of: DateTime<Utc>) -> Result<Traffic> {
    Traffic::find_by_statement(sql(
        "SELECT COALESCE(sum(uploaded), 0)::text AS uploaded, COALESCE(sum(downloaded), 0)::text AS downloaded
         FROM usage_events WHERE received_at > $1::timestamptz - INTERVAL '60 seconds' AND received_at <= $1",
        [as_of.into()],
    ))
    .one(db)
    .await?
    .ok_or_else(invalid_result)
}

pub async fn points(
    db: &impl ConnectionTrait,
    as_of: DateTime<Utc>,
    range: Range,
) -> Result<Vec<Point>> {
    let (duration, step) = range.minutes();
    let query = format!(
        "{}, chart_period AS NOT MATERIALIZED (
            SELECT *, $3::int * INTERVAL '1 minute' AS step FROM period
         ), totals AS (
            SELECT date_bin(r.step, u.bucket, r.origin) AS bucket, sum(uploaded) AS uploaded, sum(downloaded) AS downloaded
            FROM period_usage u CROSS JOIN chart_period r GROUP BY 1
         ), ticks AS (
            SELECT tick AS bucket FROM chart_period r CROSS JOIN LATERAL
            generate_series(date_bin(r.step, r.since, r.origin), date_bin(r.step, r.until, r.origin), r.step) AS tick
         )
         SELECT t.bucket AS timestamp, COALESCE(a.uploaded, 0)::text AS uploaded,
                COALESCE(a.downloaded, 0)::text AS downloaded
         FROM ticks t LEFT JOIN totals a ON a.bucket = t.bucket ORDER BY t.bucket",
        window(range)
    );
    Ok(
        Point::find_by_statement(sql(&query, [as_of.into(), duration.into(), step.into()]))
            .all(db)
            .await?,
    )
}

pub(super) fn window(range: Range) -> String {
    let samples = if matches!(range, Range::Week) {
        "SELECT u.* FROM server_usage_hours u CROSS JOIN period p
          WHERE u.bucket >= date_bin(INTERVAL '1 hour', p.since, p.origin) + INTERVAL '1 hour'
            AND u.bucket < date_bin(INTERVAL '1 hour', p.until, p.origin)
         UNION ALL
         SELECT u.* FROM server_usage_minutes u CROSS JOIN period p
          WHERE (u.bucket >= p.since AND u.bucket < date_bin(INTERVAL '1 hour', p.since, p.origin) + INTERVAL '1 hour')
             OR (u.bucket >= date_bin(INTERVAL '1 hour', p.until, p.origin) AND u.bucket <= p.until)"
    } else {
        "SELECT u.* FROM server_usage_minutes u CROSS JOIN period p WHERE u.bucket >= p.since AND u.bucket <= p.until"
    };
    format!(
        "WITH period AS NOT MATERIALIZED (
            SELECT $1::timestamptz AS until,
                   $1::timestamptz - ($2::int * INTERVAL '1 minute') AS since,
                   '2000-01-01T00:00:00Z'::timestamptz AS origin
         ), period_usage AS ({samples})"
    )
}
