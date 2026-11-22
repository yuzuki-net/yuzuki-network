use sea_orm::{ConnectionTrait, FromQueryResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::sql;
use crate::infra::error::{Error, Result, problem};

#[derive(FromQueryResult, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Location {
    label: String,
    latitude: f64,
    longitude: f64,
}

pub async fn read_location(db: &impl ConnectionTrait, id: Uuid) -> Result<Option<Location>> {
    Ok(Location::find_by_statement(sql(
        "SELECT label, latitude, longitude FROM server_locations WHERE server_id = $1",
        [id.into()],
    ))
    .one(db)
    .await?)
}

pub async fn write_location(db: &impl ConnectionTrait, id: Uuid, location: Location) -> Result<()> {
    let label = location.label.trim();
    if label.is_empty() || label.chars().count() > 100 || label.chars().any(char::is_control) {
        return Err(Error::BadRequest(problem::LOCATION_NAME));
    }
    if !(-90.0..=90.0).contains(&location.latitude)
        || !(-180.0..=180.0).contains(&location.longitude)
    {
        return Err(Error::BadRequest(problem::LOCATION_COORDINATES));
    }
    let result = db.execute(sql(
        "INSERT INTO server_locations (server_id, label, latitude, longitude)
         SELECT id, $2, $3, $4 FROM servers WHERE id = $1 AND deleted_at IS NULL
         ON CONFLICT (server_id) DO UPDATE SET label = EXCLUDED.label, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude",
        [id.into(), label.into(), location.latitude.into(), location.longitude.into()],
    )).await?;
    if result.rows_affected() == 0 {
        return Err(Error::NotFound);
    }
    Ok(())
}

pub async fn clear_location(db: &impl ConnectionTrait, id: Uuid) -> Result<()> {
    db.execute(sql(
        "DELETE FROM server_locations WHERE server_id = $1",
        [id.into()],
    ))
    .await?;
    Ok(())
}
