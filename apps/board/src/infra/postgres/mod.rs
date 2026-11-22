use sea_orm::{ConnectOptions, Database, DatabaseConnection, DbErr};

pub(crate) mod entities;
pub mod repositories;

pub async fn connect(url: &str) -> Result<DatabaseConnection, DbErr> {
    let mut options = ConnectOptions::new(url);
    options.max_connections(16).sqlx_logging(false);
    Database::connect(options).await
}
