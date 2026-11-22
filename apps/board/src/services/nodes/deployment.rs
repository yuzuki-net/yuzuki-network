use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use chrono::Utc;
use sea_orm::{
    AccessMode, ColumnTrait, DatabaseConnection, EntityTrait, IsolationLevel, QueryFilter,
    QueryOrder, TransactionTrait,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use yuzuki_core_config::{Core, server::ManagedProtocolConfig, templates};
use yuzuki_protocol::v1::{Instance, Meter, Snapshot};

use crate::{
    infra::{
        error::{Error, Result},
        postgres::entities::{proxy_node, server, server_identity},
    },
    services::access,
};

pub async fn desired(
    db: &DatabaseConnection,
    server_id: Uuid,
    fingerprint: &str,
    session: Uuid,
) -> Result<Snapshot> {
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    server::Entity::find_by_id(server_id)
        .filter(server::Column::DeletedAt.is_null())
        .one(&tx)
        .await?
        .filter(|row| row.session_id == Some(session))
        .ok_or(Error::NotFound)?;
    server_identity::Entity::find_by_id(fingerprint)
        .one(&tx)
        .await?
        .filter(|cert| cert.server_id == server_id && cert.expires_at > Utc::now())
        .ok_or(Error::NotFound)?;

    let nodes = proxy_node::Entity::find()
        .filter(proxy_node::Column::ServerId.eq(server_id))
        .filter(proxy_node::Column::DeletedAt.is_null())
        .filter(proxy_node::Column::Enabled.eq(true))
        .filter(proxy_node::Column::Mode.is_in(["managed", "custom"]))
        .order_by_asc(proxy_node::Column::Id)
        .all(&tx)
        .await?;

    let mut instances = Vec::new();
    for row in nodes {
        let accounts = access::entitled_ids_for_node(&tx, row.id).await?;
        if let Some(instance) = prepare(row, &accounts)? {
            instances.push(instance);
        }
    }
    tx.commit().await?;

    let data = serde_json::to_vec(&instances).map_err(|error| Error::Internal(error.into()))?;
    let revision = format!("{:x}", Sha256::digest(data));
    Ok(Snapshot {
        revision,
        instances,
    })
}

fn prepare(row: proxy_node::Model, accounts: &[String]) -> Result<Option<Instance>> {
    let Some(core_str) = row.core.as_deref() else {
        return Ok(None);
    };
    let core: Core = core_str
        .parse()
        .map_err(|error: &str| Error::Internal(anyhow::anyhow!("{error}")))?;

    let (template, meter) = if row.mode == "managed" {
        let listen_port = u16::try_from(row.listen_port.or(row.port).unwrap_or(0))
            .map_err(|_| Error::Internal(anyhow::anyhow!("invalid listen port")))?;
        if listen_port == 0 {
            return Ok(None);
        }
        let cfg: ManagedProtocolConfig = serde_json::from_value(row.protocol_config)
            .map_err(|error| Error::Internal(error.into()))?;
        let meter = if row.meter_enabled && core != Core::Mihomo {
            row.meter_port
                .and_then(|p| u16::try_from(p).ok())
                .map(|port| Meter::UserStats {
                    addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                })
        } else {
            None
        };
        let compiled = cfg
            .compile_server(core, listen_port, meter.as_ref())
            .map_err(Error::Internal)?;
        (compiled, meter)
    } else {
        let Some(native) = row.native_server_config else {
            return Ok(None);
        };
        let meter = row
            .meter_config
            .map(serde_json::from_value::<Meter>)
            .transpose()
            .map_err(|error| Error::Internal(error.into()))?;
        (native, meter)
    };

    let selected;
    let accounts = if let Some(Meter::DedicatedTraffic { access_id, .. }) = &meter {
        let id = access_id.to_string();
        if !accounts.contains(&id) {
            return Ok(None);
        }
        selected = [id];
        &selected
    } else {
        accounts
    };
    if accounts.is_empty() && templates::has_managed_credentials(&template) {
        return Ok(None);
    }
    let config = templates::server(&template, accounts).map_err(Error::Internal)?;
    Ok(Some(Instance {
        id: row.id,
        core,
        config,
        meter,
    }))
}
