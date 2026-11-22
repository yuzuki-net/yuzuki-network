mod management;
mod model;
mod queries;

pub(super) use management::deliver;
pub use management::{archive, bulk, create, delete, publish, update};
pub use model::{AdminView, Bulk, DisplayMode, Draft, DraftUpdate, Filter, Inbox, Read, UnreadSummary};
pub use queries::{admin_view, inbox, mark_read, unread_summary};

use sea_orm::{DatabaseBackend, Statement, Value};

fn stmt(sql: &str, values: impl IntoIterator<Item = Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, values)
}
