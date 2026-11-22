use std::{sync::Arc, time::Duration};

use axum::{
    Extension, Json, Router,
    extract::{
        DefaultBodyLimit, State as AxumState, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::HeaderMap,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use uuid::Uuid;
use yuzuki_protocol::{
    codec::{self, MAX_FRAME_SIZE},
    v1::{
        BoardMessage, CONNECT_PATH, ENROLL_PATH, NodeMessage, RENEW_PATH, SUBPROTOCOL, SignRequest,
        SignedIdentity,
    },
};

use crate::{
    app::{self, State},
    infra::error::{Error, Result},
    services::{
        auth::bearer_hash,
        dashboard::presence,
        nodes::{cores, deployment, sessions},
    },
};

use super::{Peer, Signer};

const LEASE_SECONDS: u64 = 45;
const REFRESH: Duration = Duration::from_secs(3);

#[derive(Clone)]
struct Control {
    app: State,
    signer: Arc<Signer>,
    device_key: [u8; 32],
}

pub fn router(app: State, signer: Signer, device_key: [u8; 32]) -> Router {
    Router::new()
        .route(ENROLL_PATH, post(enroll))
        .route(RENEW_PATH, post(renew))
        .route(CONNECT_PATH, get(connect))
        .with_state(Control {
            app,
            signer: Arc::new(signer),
            device_key,
        })
        .layer(DefaultBodyLimit::max(16 * 1024))
        .method_not_allowed_fallback(app::not_found)
        .fallback(app::not_found)
        .layer(middleware::map_response(app::headers))
}

async fn enroll(
    AxumState(control): AxumState<Control>,
    headers: HeaderMap,
    Json(request): Json<SignRequest>,
) -> Result<Json<SignedIdentity>> {
    let hash = bearer_hash(&headers).ok_or(Error::NotFound)?;
    let (identity, signed) = control.signer.issue(&request.csr_pem)?;
    sessions::enroll(&control.app.db, hash, identity).await?;
    Ok(Json(signed))
}

async fn renew(
    AxumState(control): AxumState<Control>,
    Extension(peer): Extension<Peer>,
    Json(request): Json<SignRequest>,
) -> Result<Json<SignedIdentity>> {
    let fingerprint = peer.0.ok_or(Error::NotFound)?;
    let (identity, signed) = control.signer.issue(&request.csr_pem)?;
    sessions::renew(&control.app.db, &fingerprint, identity).await?;
    Ok(Json(signed))
}

async fn connect(
    AxumState(control): AxumState<Control>,
    Extension(peer): Extension<Peer>,
    ws: std::result::Result<
        WebSocketUpgrade,
        axum::extract::ws::rejection::WebSocketUpgradeRejection,
    >,
) -> Result<Response> {
    let fingerprint = peer.0.ok_or(Error::NotFound)?;
    let ws = ws.map_err(|_| Error::NotFound)?.protocols([SUBPROTOCOL]);
    if ws.selected_protocol().is_none() {
        return Err(Error::NotFound);
    }
    let id = sessions::authenticate(&control.app.db, &fingerprint).await?;
    Ok(ws
        .max_message_size(MAX_FRAME_SIZE)
        .max_frame_size(MAX_FRAME_SIZE)
        .on_upgrade(move |socket| async move {
            match session(socket, control, id, fingerprint).await {
                Ok(()) | Err(Error::NotFound) => {}
                Err(error) => tracing::warn!(node = %id, ?error, "node session ended"),
            }
        })
        .into_response())
}

async fn session(mut socket: WebSocket, control: Control, id: Uuid, cert: String) -> Result<()> {
    let state = &control.app;
    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv())
        .await
        .map_err(|_| Error::NotFound)?;
    let Some(Ok(Message::Binary(bytes))) = first else {
        return Err(Error::NotFound);
    };
    let NodeMessage::Hello {
        capabilities,
        mut applied,
        host,
        config_warnings,
    } = codec::decode(&bytes).map_err(|_| Error::NotFound)?
    else {
        return Err(Error::NotFound);
    };
    let session = sessions::claim(&state.db, id, &cert, capabilities, host, config_warnings).await?;
    let mut commands = state.broker.register(id, session);
    let result = run_session(
        &mut socket,
        state,
        id,
        &cert,
        session,
        &mut applied,
        control.device_key,
        &mut commands,
    )
    .await;
    state.broker.unregister(id, session);
    if let Err(error) = sessions::release(&state.db, id, session).await {
        tracing::warn!(node = %id, ?error, "unable to release node session");
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    socket: &mut WebSocket,
    state: &State,
    id: Uuid,
    cert: &str,
    session: Uuid,
    applied: &mut Option<String>,
    device_key: [u8; 32],
    commands: &mut tokio::sync::mpsc::UnboundedReceiver<BoardMessage>,
) -> Result<()> {
    tracing::debug!(node = %id, "node connected");
    send(
        socket,
        BoardMessage::Welcome {
            session,
            lease_seconds: LEASE_SECONDS,
            online_devices: device_key,
        },
    )
    .await?;
    let mut sent = None;
    let mut ticks = tokio::time::interval(REFRESH);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = ticks.tick() => {
                let snapshot = deployment::desired(&state.db, id, cert, session).await?;
                if applied.as_ref() == Some(&snapshot.revision) {
                    send(socket, BoardMessage::Lease { seconds: LEASE_SECONDS }).await?;
                } else if sent.as_ref() != Some(&snapshot.revision) {
                    sent = Some(snapshot.revision.clone());
                    send(socket, BoardMessage::Snapshot(snapshot)).await?;
                }
            }
            Some(command) = commands.recv() => {
                let is_disconnect = matches!(command, BoardMessage::Disconnect { .. });
                send(socket, command).await?;
                if is_disconnect {
                    return Ok(());
                }
            }
            message = socket.recv() => {
                let Some(Ok(message)) = message else { return Ok(()); };
                let bytes = match message {
                    Message::Binary(bytes) => bytes,
                    Message::Close(_) => return Ok(()),
                    Message::Ping(_) | Message::Pong(_) => continue,
                    _ => return Err(Error::NotFound),
                };
                let message = codec::decode(&bytes).map_err(|_| Error::NotFound)?;
                match message {
                    NodeMessage::Hello { .. } => return Err(Error::NotFound),
                    NodeMessage::Capabilities { host, capabilities } => {
                        sessions::update_capabilities(&state.db, id, session, capabilities, Some(host), false).await?;
                        sent = None;
                    }
                    NodeMessage::Heartbeat { instances } => sessions::heartbeat(&state.db, id, session, instances).await?,
                    NodeMessage::Devices { instances } => presence::record(&state.db, id, session, instances).await?,
                    NodeMessage::Applied { revision, instances } if sent.as_ref() == Some(&revision) => {
                        sessions::report(&state.db, id, session, &revision, None).await?;
                        if !instances.is_empty() {
                            sessions::heartbeat(&state.db, id, session, instances).await?;
                        }
                        *applied = Some(revision);
                    }
                    NodeMessage::Rejected { revision, reason } if sent.as_ref() == Some(&revision) => {
                        let reason = reason.chars().filter(|c| !c.is_control()).take(240).collect();
                        sessions::report(&state.db, id, session, &revision, Some(reason)).await?;
                    }
                    NodeMessage::Applied { .. } | NodeMessage::Rejected { .. } => {}
                    NodeMessage::Usage(batch) => {
                        let reply = match state.ledger.record(id, session, batch).await {
                            Ok(event_ids) => BoardMessage::UsageAck { event_ids },
                            Err(Error::NotFound) => return Err(Error::NotFound),
                            Err(Error::BadRequest(problem) | Error::Conflict(problem)) => BoardMessage::UsageRejected { reason: problem.message.into() },
                            Err(error) => return Err(error),
                        };
                        send(socket, reply).await?;
                    }
                    NodeMessage::CoreActionProgress { request_id, stage, message, .. } => {
                        cores::record_progress(&state.db, id, request_id, stage, message).await?;
                    }
                    NodeMessage::CoreActionResult {
                        request_id,
                        ok,
                        version,
                        error,
                        capabilities,
                        host,
                        ..
                    } => {
                        cores::record_result(
                            &state.db,
                            id,
                            session,
                            request_id,
                            ok,
                            version,
                            error,
                            capabilities,
                            host,
                        )
                        .await?;
                        if ok {
                            sent = None;
                        }
                    }
                }
            }
        }
    }
}

async fn send(socket: &mut WebSocket, message: BoardMessage) -> Result<()> {
    let data = codec::encode(&message).map_err(|error| Error::Internal(error.into()))?;
    tokio::time::timeout(
        Duration::from_secs(10),
        socket.send(Message::Binary(data.into())),
    )
    .await
    .map_err(|_| Error::NotFound)?
    .map_err(|_| Error::NotFound)
}
