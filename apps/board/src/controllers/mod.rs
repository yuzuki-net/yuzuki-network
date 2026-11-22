mod access;
mod accounts;
mod admin;
mod auth;
mod batch;
mod dashboard;
mod links;
mod pages;
mod portal;
mod quota;
mod routing;
mod subscriptions;

use crate::{
    app::State,
    infra::error::Error,
    services::{
        access::{Permission, Rules},
        auth::Session,
    },
};
use axum::{
    Extension, Router,
    extract::Request,
    handler::Handler,
    http::{StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::{MethodFilter, MethodRouter, get, post, put},
};
use tower_http::compression::CompressionLayer;

pub fn router(state: State) -> Router {
    use MethodFilter as M;
    use Permission::*;
    use Rules::{Admin, Require};

    let public = Router::new()
        .route("/auth/login", post(auth::login))
        .route("/auth/register", post(auth::register))
        .route_layer(middleware::from_fn(auth::browser_request))
        .route("/", get(pages::home))
        .route("/login", get(pages::login))
        .route("/register", get(pages::register))
        .route(
            "/assets/{*name}",
            get(pages::assets).layer(CompressionLayer::new()),
        )
        .route("/auth/options", get(auth::options))
        .route("/auth/session", get(auth::public_session))
        .route(
            &format!("/{}/{{token}}", state.settings.subscription_route),
            get(subscriptions::download),
        );

    let private = Router::new()
        .route("/workspace", get(pages::workspace))
        .route("/workspace/security", get(pages::workspace))
        .route(
            "/workspace/subscriptions",
            console_page(pages::workspace, Require(&[SubscriptionsRead])),
        )
        .route(
            "/workspace/assets/{*name}",
            get(pages::workspace_assets).layer(CompressionLayer::new()),
        )
        .route("/auth/logout", post(auth::logout))
        .route("/api/v1/me", get(auth::me))
        .route("/api/v1/me/password", put(auth::change_password))
        .route("/admin", console_page(pages::admin, Admin))
        .route(
            "/api/v1/admin/dashboard",
            permit(M::GET, dashboard::overview, Admin),
        )
        .route(
            "/admin/users",
            console_page(pages::admin, Require(&[UsersRead])),
        )
        .route(
            "/admin/roles",
            console_page(pages::admin, Require(&[RolesRead])),
        )
        .route(
            "/admin/audit",
            console_page(pages::admin, Require(&[AuditRead])),
        )
        .route(
            "/admin/quotas",
            console_page(pages::admin, Require(&[QuotasRead])),
        )
        .route(
            "/admin/nodes",
            console_page(pages::admin, Require(&[NodesRead])),
        )
        .route(
            "/admin/servers",
            console_page(pages::admin, Require(&[NodesRead])),
        )
        .route(
            "/admin/routing",
            console_page(pages::admin, Require(&[RoutingRead])),
        )
        .route(
            "/api/v1/admin/users",
            permit(M::POST, accounts::create_user, Require(&[UsersCreate])),
        )
        .route(
            "/api/v1/admin/users/status",
            permit(
                M::POST,
                batch::account_status,
                Require(&[UsersRead, UsersUpdate]),
            ),
        )
        .route(
            "/api/v1/admin/users/{id}",
            permit(M::GET, accounts::user, Require(&[UsersRead])),
        )
        .route(
            "/api/v1/admin/users/{id}/profile",
            permit(M::PUT, accounts::profile, Require(&[UsersUpdate])),
        )
        .route(
            "/api/v1/admin/users/{id}/status",
            permit(M::PUT, accounts::status, Require(&[UsersUpdate])),
        )
        .route(
            "/api/v1/admin/users/{id}/credentials",
            permit(M::PUT, accounts::reset, Require(&[UsersCredentials])),
        )
        .route(
            "/api/v1/admin/users/{id}/sessions",
            permit(
                M::DELETE,
                accounts::revoke_sessions,
                Require(&[UsersCredentials]),
            ),
        )
        .route(
            "/api/v1/admin/users/{id}/access",
            permit(
                M::GET,
                accounts::account_access,
                Require(&[UsersRead, RolesRead]),
            ),
        )
        .route(
            "/api/v1/admin/users/{id}/access",
            permit(M::PUT, accounts::assign, Require(&[RolesAssign])),
        )
        .route(
            "/api/v1/admin/directory",
            permit(M::GET, accounts::directory, Require(&[UsersRead])),
        )
        .route(
            "/api/v1/admin/quotas",
            permit(M::GET, accounts::directory, Require(&[QuotasRead])),
        )
        .route(
            "/api/v1/admin/roles",
            permit(M::GET, access::roles, Require(&[RolesRead])),
        )
        .route(
            "/api/v1/admin/roles",
            permit(M::POST, access::create_role, Require(&[RolesManage])),
        )
        .route(
            "/api/v1/admin/roles/{id}",
            permit(M::PUT, access::update_role, Require(&[RolesManage])),
        )
        .route(
            "/api/v1/admin/roles/{id}",
            permit(M::DELETE, access::remove_role, Require(&[RolesManage])),
        )
        .route(
            "/api/v1/admin/permissions",
            permit(M::GET, access::permissions, Require(&[RolesRead])),
        )
        .route(
            "/api/v1/admin/audit",
            permit(M::GET, access::audit, Require(&[AuditRead])),
        )
        // ── Managed Servers (Hosts / Agents) ────────────────────────────────
        .route(
            "/api/v1/admin/servers",
            permit(M::GET, admin::servers, Require(&[NodesRead])),
        )
        .route(
            "/api/v1/admin/servers",
            permit(M::POST, admin::create_server, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/servers/control",
            permit(M::GET, admin::server_control, Require(&[NodesRead])),
        )
        .route(
            "/api/v1/admin/servers/cores/catalog",
            permit(M::GET, admin::core_catalog, Require(&[NodesRead])),
        )
        .route(
            "/api/v1/admin/servers/trash",
            permit(M::DELETE, admin::purge_server_trash, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/servers/{id}",
            permit(M::PUT, admin::update_server, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/servers/{id}",
            permit(M::DELETE, admin::delete_server, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/servers/{id}/restore",
            permit(M::POST, admin::restore_server, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/servers/{id}/purge",
            permit(M::DELETE, admin::purge_server, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/servers/{id}/enrollment",
            permit(M::POST, admin::enrollment, Require(&[NodesEnroll])),
        )
        .route(
            "/api/v1/admin/servers/{id}/enrollment",
            permit(M::DELETE, admin::revoke_server, Require(&[NodesEnroll])),
        )
        .route(
            "/api/v1/admin/servers/{id}/location",
            permit(M::GET, dashboard::location, Require(&[NodesRead])),
        )
        .route(
            "/api/v1/admin/servers/{id}/location",
            permit(M::PUT, dashboard::save_location, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/servers/{id}/location",
            permit(
                M::DELETE,
                dashboard::remove_location,
                Require(&[NodesManage]),
            ),
        )
        .route(
            "/api/v1/admin/servers/{id}/cores/tasks",
            permit(M::GET, admin::server_core_tasks, Require(&[NodesRead])),
        )
        .route(
            "/api/v1/admin/servers/{id}/cores/probe",
            permit(M::POST, admin::probe_server_cores, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/servers/{id}/cores/{core}/install",
            permit(M::POST, admin::install_server_core, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/servers/{id}/cores/{core}",
            permit(M::DELETE, admin::remove_server_core, Require(&[NodesManage])),
        )
        // ── Proxy Nodes (V2Board / XBoard Style Lines) ──────────────────────
        .route(
            "/api/v1/admin/nodes",
            permit(M::GET, admin::nodes, Require(&[NodesRead])),
        )
        .route(
            "/api/v1/admin/nodes",
            permit(M::POST, admin::create_node, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/nodes/reorder",
            permit(M::PUT, admin::reorder_nodes, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/nodes/batch",
            permit(M::POST, admin::batch_nodes, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/nodes/trash",
            permit(M::DELETE, admin::purge_node_trash, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/nodes/{id}",
            permit(M::PUT, admin::update_node, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/nodes/{id}",
            permit(M::PATCH, admin::patch_node, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/nodes/{id}",
            permit(M::DELETE, admin::delete_node, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/nodes/{id}/restore",
            permit(M::POST, admin::restore_node, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/nodes/{id}/purge",
            permit(M::DELETE, admin::purge_node, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/nodes/{id}/clone",
            permit(M::POST, admin::clone_node, Require(&[NodesManage])),
        )
        .route(
            "/api/v1/admin/nodes/{id}/restart",
            permit(M::POST, admin::restart_node, Require(&[NodesManage])),
        )
        // ── Routing ─────────────────────────────────────────────────────────
        .route(
            "/api/v1/admin/routing",
            permit(M::GET, admin::policies, Require(&[RoutingRead])),
        )
        .route(
            "/api/v1/admin/routing",
            permit(M::PUT, admin::save_policy, Require(&[RoutingEdit])),
        )
        .route(
            "/api/v1/admin/routing/publish",
            permit(M::POST, admin::publish, Require(&[RoutingPublish])),
        )
        .route(
            "/api/v1/admin/routing/preview",
            permit(M::POST, routing::preview, Require(&[RoutingRead])),
        )
        .route(
            "/api/v1/admin/routing/draft",
            permit(M::DELETE, admin::discard_policy, Require(&[RoutingEdit])),
        )
        .route(
            "/api/v1/admin/routing/revisions",
            permit(M::GET, admin::revisions, Require(&[RoutingRead])),
        )
        .route(
            "/api/v1/admin/routing/revisions/{id}",
            permit(M::POST, admin::rollback, Require(&[RoutingPublish])),
        )
        .merge(portal::routes())
        .merge(links::routes())
        .merge(quota::routes())
        .route_layer(middleware::from_fn(auth::browser_request))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::session));
    public.merge(private).with_state(state)
}

fn console_page<H, T>(handler: H, rule: Rules) -> MethodRouter<State>
where
    H: Handler<T, State>,
    T: 'static,
{
    get(handler).route_layer(middleware::from_fn(
        move |Extension(session): Extension<Session>, request: Request, next: Next| async move {
            if rule.allows(&session.access) {
                return Ok::<Response, Error>(next.run(request).await);
            }
            let accepts_html = request
                .headers()
                .get(header::ACCEPT)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value.split(',').any(|entry| {
                        entry
                            .split(';')
                            .next()
                            .is_some_and(|mime| mime.trim() == "text/html")
                    })
                });
            if !accepts_html {
                return Err(Error::NotFound);
            }
            let mut response = pages::workspace().await?;
            *response.status_mut() = StatusCode::NOT_FOUND;
            Ok(response)
        },
    ))
}

fn permit<H, T>(method: MethodFilter, handler: H, rule: Rules) -> MethodRouter<State>
where
    H: Handler<T, State>,
    T: 'static,
{
    axum::routing::on(method, handler).route_layer(middleware::from_fn(
        move |Extension(session): Extension<Session>, request: Request, next: Next| async move {
            if !rule.allows(&session.access) {
                return Err(Error::NotFound);
            }
            Ok(next.run(request).await)
        },
    ))
}
