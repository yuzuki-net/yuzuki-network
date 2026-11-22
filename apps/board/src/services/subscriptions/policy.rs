use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryOrder, QuerySelect,
    Set, TransactionTrait,
};
use serde::Serialize;
use yuzuki_core_config::{Core, cores::Registry, routing::Policy};

use crate::infra::{
    error::{Error, Result, problem},
    postgres::entities::{routing_policy, routing_revision},
};

#[derive(Serialize)]
pub struct Policies {
    pub revision: i64,
    pub published: Policy,
    pub draft: Option<Policy>,
}

pub async fn published(db: &impl ConnectionTrait) -> Result<Policy> {
    let state = routing_policy::Entity::find_by_id(1_i16)
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    revision(db, state.published_id).await
}

pub async fn read(db: &DatabaseConnection) -> Result<Policies> {
    let state = routing_policy::Entity::find_by_id(1_i16)
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    let policy = revision(db, state.published_id).await?;
    let draft = state
        .draft
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| Error::Internal(e.into()))?;
    Ok(Policies {
        revision: state.published_id,
        published: policy,
        draft,
    })
}

async fn revision(db: &impl ConnectionTrait, id: i64) -> Result<Policy> {
    let row = routing_revision::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    serde_json::from_value(row.policy).map_err(|e| Error::Internal(e.into()))
}

pub async fn save(db: &DatabaseConnection, mut policy: Policy) -> Result<()> {
    policy
        .normalize()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let registry = Registry::builtins();
    for core in Core::ALL {
        registry
            .render(core, &[], &policy)
            .map_err(|e| Error::Invalid(e.to_string()))?;
    }
    let data = serde_json::to_value(policy).map_err(|e| Error::Internal(e.into()))?;
    routing_policy::ActiveModel {
        id: Set(1),
        draft: Set(Some(data)),
        ..Default::default()
    }
    .update(db)
    .await?;
    Ok(())
}

pub async fn publish(db: &DatabaseConnection) -> Result<i64> {
    let tx = db.begin().await?;
    let state = routing_policy::Entity::find_by_id(1_i16)
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(Error::NotFound)?;
    let draft = state
        .draft
        .clone()
        .ok_or(Error::Conflict(problem::ROUTING_NO_DRAFT))?;
    let entry = routing_revision::ActiveModel {
        policy: Set(draft),
        created_at: Set(Utc::now()),
        ..Default::default()
    }
    .insert(&tx)
    .await?;
    let mut state: routing_policy::ActiveModel = state.into();
    state.draft = Set(None);
    state.published_id = Set(entry.id);
    state.update(&tx).await?;
    tx.commit().await?;
    Ok(entry.id)
}

pub async fn discard(db: &DatabaseConnection) -> Result<()> {
    routing_policy::ActiveModel {
        id: Set(1),
        draft: Set(None),
        ..Default::default()
    }
    .update(db)
    .await?;
    Ok(())
}

pub async fn rollback(db: &DatabaseConnection, id: i64) -> Result<()> {
    revision(db, id).await?;
    routing_policy::ActiveModel {
        id: Set(1),
        published_id: Set(id),
        ..Default::default()
    }
    .update(db)
    .await?;
    Ok(())
}

pub async fn revisions(db: &DatabaseConnection) -> Result<Vec<i64>> {
    Ok(routing_revision::Entity::find()
        .order_by_desc(routing_revision::Column::Id)
        .select_only()
        .column(routing_revision::Column::Id)
        .limit(100)
        .into_tuple::<i64>()
        .all(db)
        .await?)
}
