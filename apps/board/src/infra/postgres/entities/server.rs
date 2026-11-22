use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "servers")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub remark: String,
    pub default_host: Option<String>,
    pub enrollment_hash: Option<String>,
    pub enrollment_expires_at: Option<DateTimeUtc>,
    pub session_id: Option<Uuid>,
    pub last_seen_at: Option<DateTimeUtc>,
    pub applied_revision: Option<String>,
    pub deployment_error: Option<String>,
    pub capabilities: Json,
    pub runtime_status: Option<Json>,
    pub host_info: Option<Json>,
    pub config_warnings: Json,
    pub created_at: DateTimeUtc,
    pub deleted_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
