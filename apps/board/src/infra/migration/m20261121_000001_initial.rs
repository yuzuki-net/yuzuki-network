use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for schema in [
            include_str!("schema/accounts.sql"),
            include_str!("schema/nodes.sql"),
            include_str!("schema/subscriptions.sql"),
            include_str!("schema/portal.sql"),
        ] {
            manager.get_connection().execute_unprepared(schema).await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(include_str!("schema/drop.sql"))
            .await?;
        Ok(())
    }
}
