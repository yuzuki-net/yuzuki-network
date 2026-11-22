use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "proxy_nodes")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub mode: String,
    pub server_id: Option<Uuid>,
    pub parent_id: Option<Uuid>,
    pub core: Option<String>,
    pub enabled: bool,
    pub show: bool,
    pub sort_order: i32,
    pub rate: f64,
    pub tags: Vec<String>,
    pub visibility: String,
    pub protocol: Option<String>,
    pub host: String,
    pub port: Option<i32>,
    pub listen_port: Option<i32>,
    pub protocol_config: Json,
    pub meter_enabled: bool,
    pub meter_port: Option<i32>,
    pub meter_config: Option<Json>,
    pub native_server_config: Option<Json>,
    pub native_client_overrides: Json,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub deleted_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
