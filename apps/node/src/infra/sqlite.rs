use std::path::Path;

use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;
use yuzuki_protocol::v1::{MAX_USAGE_EVENTS, UsageEvent};

use crate::services::metering::Reading;

pub struct Outbox(Connection);

impl Outbox {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS samples (
                instance TEXT NOT NULL, account TEXT NOT NULL, epoch TEXT NOT NULL,
                up INTEGER NOT NULL, down INTEGER NOT NULL, PRIMARY KEY (instance, account)
            );
            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY, event TEXT NOT NULL UNIQUE, instance TEXT NOT NULL,
                account TEXT NOT NULL, up INTEGER NOT NULL, down INTEGER NOT NULL
            );",
        )?;
        Ok(Self(db))
    }

    pub fn sample(&mut self, instance: Uuid, epoch: Uuid, readings: &[Reading]) -> Result<()> {
        let instance = instance.to_string();
        let epoch = epoch.to_string();
        let tx = self.0.transaction()?;
        for reading in readings {
            ensure!(
                reading.uploaded >= 0 && reading.downloaded >= 0,
                "invalid traffic counter"
            );
            let account = reading.access_id.to_string();
            let previous: Option<(String, i64, i64)> = tx
                .query_row(
                    "SELECT epoch, up, down FROM samples WHERE instance = ?1 AND account = ?2",
                    params![instance, account],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let (up, down) = match previous {
                Some((prior, up, down)) if prior == epoch => {
                    (delta(reading.uploaded, up), delta(reading.downloaded, down))
                }
                _ => (reading.uploaded, reading.downloaded),
            };
            tx.execute("INSERT INTO samples VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(instance, account) DO UPDATE SET epoch = excluded.epoch, up = excluded.up, down = excluded.down",
                params![instance, account, epoch, reading.uploaded, reading.downloaded])?;
            if up > 0 || down > 0 {
                tx.execute("INSERT INTO outbox (event, instance, account, up, down) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![Uuid::new_v4().to_string(), instance, account, up, down])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn pending(&self) -> Result<Vec<UsageEvent>> {
        let mut statement = self.0.prepare(
            "SELECT event, instance, account, up, down FROM outbox ORDER BY id LIMIT ?1",
        )?;
        let mut rows = statement.query([MAX_USAGE_EVENTS])?;
        let mut events = Vec::new();
        while let Some(row) = rows.next()? {
            events.push(UsageEvent {
                event_id: row.get::<_, String>(0)?.parse()?,
                instance_id: row.get::<_, String>(1)?.parse()?,
                access_id: row.get::<_, String>(2)?.parse()?,
                uploaded: row.get(3)?,
                downloaded: row.get(4)?,
            });
        }
        Ok(events)
    }

    pub fn acknowledge(&mut self, ids: &[Uuid]) -> Result<()> {
        let tx = self.0.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM outbox WHERE event = ?1", [id.to_string()])?;
        }
        tx.commit()?;
        Ok(())
    }
}

fn delta(next: i64, prior: i64) -> i64 {
    if next >= prior { next - prior } else { next }
}
