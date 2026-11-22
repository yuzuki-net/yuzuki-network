mod permissions;
mod repository;
pub(crate) use repository::sql;
mod roles;

pub use permissions::{Access, Permission, Role, RoleSummary, Rules};
pub use repository::{
    ADMIN_ROLE, AuditEntry, AuditKind, MEMBER, add_admin_role, add_default_role, audit,
    audit_entries, audit_subject, entitled_ids_for_node, permissions_for, remove_admin_role,
    roles_for_accounts,
};
pub use roles::{Assignment, RoleInput, remove_role, roles, update_assignment, update_role};

use sea_orm::{ConnectionTrait, DatabaseTransaction, EntityTrait, QuerySelect};
use uuid::Uuid;

use crate::infra::{
    error::{Error, Result},
    postgres::entities::account,
};

const POLICY_LOCK: i64 = 650480402;

pub async fn begin_change(tx: &DatabaseTransaction) -> Result<()> {
    tx.execute(sql(
        "SELECT pg_advisory_xact_lock($1)",
        [POLICY_LOCK.into()],
    ))
    .await?;
    Ok(())
}

pub(crate) async fn begin_read(tx: &DatabaseTransaction) -> Result<()> {
    tx.execute(sql(
        "SELECT pg_advisory_xact_lock_shared($1)",
        [POLICY_LOCK.into()],
    ))
    .await?;
    Ok(())
}

pub async fn actor(tx: &DatabaseTransaction, id: Uuid, required: &[Permission]) -> Result<Access> {
    let row = account::Entity::find_by_id(id)
        .one(tx)
        .await?
        .filter(|row| row.active)
        .ok_or(Error::NotFound)?;
    let access = permissions_for(tx, &row).await?;
    if !required.iter().all(|&point| access.allows(point)) {
        return Err(Error::NotFound);
    }
    Ok(access)
}

pub async fn subject(
    tx: &DatabaseTransaction,
    actor: &Access,
    id: Uuid,
) -> Result<(account::Model, Access)> {
    let row = account::Entity::find_by_id(id)
        .lock_exclusive()
        .one(tx)
        .await?
        .ok_or(Error::NotFound)?;
    let access = permissions_for(tx, &row).await?;
    if !actor.can_manage(&access) {
        return Err(Error::NotFound);
    }
    Ok((row, access))
}
