use sea_orm::{ConnectionTrait, DatabaseConnection, TransactionTrait};
use sea_orm_migration::prelude::*;

mod m20261121_000001_initial;

struct Migrations;

#[async_trait::async_trait]
impl MigratorTrait for Migrations {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m20261121_000001_initial::Migration)]
    }
}

pub async fn run(db: &DatabaseConnection) -> Result<(), DbErr> {
    let transaction = db.begin().await?;
    transaction
        .execute_unprepared("SELECT pg_advisory_xact_lock(650480401)")
        .await?;
    Migrations::up(&transaction, None).await?;
    transaction.commit().await
}
