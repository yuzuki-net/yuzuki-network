use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "usage_events")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub server_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub event_id: Uuid,
    pub node_id: Uuid,
    pub account_id: Uuid,
    pub uploaded: i64,
    pub downloaded: i64,
    pub rate: f64,
    pub billed_bytes: i64,
    pub received_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
