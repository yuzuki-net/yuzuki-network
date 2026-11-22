use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QuerySelect, Set,
    TransactionTrait,
};
use uuid::Uuid;
use yuzuki_protocol::v1::{MAX_USAGE_EVENTS, UsageBatch};

use crate::infra::{
    error::{Error, Result, problem},
    postgres::entities::{account, proxy_node, server, usage_event},
};

use crate::services::quotas::{QuotaLedger, policy};

pub struct PostgresLedger(pub DatabaseConnection);

#[async_trait::async_trait]
impl QuotaLedger for PostgresLedger {
    async fn record(
        &self,
        server_id: Uuid,
        session: Uuid,
        mut batch: UsageBatch,
    ) -> Result<Vec<Uuid>> {
        if batch.events.is_empty() || batch.events.len() > MAX_USAGE_EVENTS {
            return Err(Error::BadRequest(problem::USAGE_BATCH));
        }
        let tx = self.0.begin().await?;
        server::Entity::find_by_id(server_id)
            .filter(server::Column::DeletedAt.is_null())
            .lock_exclusive()
            .one(&tx)
            .await?
            .filter(|srv| srv.session_id == Some(session))
            .ok_or(Error::NotFound)?;

        // Sort by account so simultaneous batches lock account rows in the same order.
        batch.events.sort_by_key(|event| event.access_id);
        let mut accepted = Vec::with_capacity(batch.events.len());
        for event in batch.events {
            if event.event_id.is_nil() || event.uploaded < 0 || event.downloaded < 0 {
                return Err(Error::BadRequest(problem::USAGE_EVENT));
            }
            let raw_amount = event
                .uploaded
                .checked_add(event.downloaded)
                .filter(|bytes| *bytes > 0)
                .ok_or(Error::BadRequest(problem::USAGE_BYTES))?;
            let node = proxy_node::Entity::find_by_id(event.instance_id)
                .one(&tx)
                .await?
                .filter(|node| node.server_id == Some(server_id))
                .ok_or(Error::BadRequest(problem::USAGE_INSTANCE))?;
            let account = account::Entity::find()
                .filter(account::Column::AccessId.eq(event.access_id))
                .lock_exclusive()
                .one(&tx)
                .await?
                .ok_or(Error::BadRequest(problem::USAGE_ACCOUNT))?;
            let previous = usage_event::Entity::find_by_id((server_id, event.event_id))
                .one(&tx)
                .await?;
            if let Some(previous) = previous {
                if previous.account_id != account.id
                    || previous.node_id != event.instance_id
                    || previous.uploaded != event.uploaded
                    || previous.downloaded != event.downloaded
                {
                    return Err(Error::Conflict(problem::USAGE_EVENT_CONFLICT));
                }
            } else {
                let rate = node.rate.clamp(0.0, 100.0);
                let billed = ((raw_amount as f64) * rate).round() as i64;
                let billed = billed.max(0);
                let total = account
                    .used_bytes
                    .checked_add(billed)
                    .ok_or(Error::Conflict(problem::USAGE_TOTAL_RANGE))?;
                let received_at = Utc::now();
                usage_event::ActiveModel {
                    server_id: Set(server_id),
                    event_id: Set(event.event_id),
                    node_id: Set(event.instance_id),
                    account_id: Set(account.id),
                    uploaded: Set(event.uploaded),
                    downloaded: Set(event.downloaded),
                    rate: Set(rate),
                    billed_bytes: Set(billed),
                    received_at: Set(received_at),
                }
                .insert(&tx)
                .await?;
                if billed > 0 {
                    policy::record_usage(&tx, account.id, received_at, billed).await?;
                    let mut account: account::ActiveModel = account.into();
                    account.used_bytes = Set(total);
                    account.update(&tx).await?;
                }
            }
            accepted.push(event.event_id);
        }
        tx.commit().await?;
        Ok(accepted)
    }
}
