mod notices;
mod settings_account;

use super::{console_page, pages, permit};
use crate::{
    app::State,
    services::access::{Permission::*, Rules::Require},
};
use axum::{
    Router,
    routing::{MethodFilter as M, delete, get, put},
};

pub(super) fn routes() -> Router<State> {
    Router::new()
        .route("/workspace/announcements", get(notices::page))
        .route("/api/v1/me/announcements", get(notices::inbox))
        .route("/api/v1/me/announcements/unread", get(notices::unread))
        .route("/api/v1/me/announcements/read", put(notices::mark_read))
        .route("/api/v1/me/profile", put(settings_account::profile))
        .route("/api/v1/me/locale", put(settings_account::locale))
        .route(
            "/api/v1/me/sessions",
            get(settings_account::sessions).delete(settings_account::revoke_other),
        )
        .route(
            "/api/v1/me/sessions/{id}",
            delete(settings_account::revoke_session),
        )
        .route(
            "/admin/settings",
            console_page(pages::admin, Require(&[SettingsRead])),
        )
        .route(
            "/api/v1/admin/settings",
            permit(M::GET, settings_account::settings, Require(&[SettingsRead])),
        )
        .route(
            "/api/v1/admin/settings",
            permit(
                M::PUT,
                settings_account::update_settings,
                Require(&[SettingsManage]),
            ),
        )
        .route(
            "/admin/announcements",
            console_page(pages::admin, Require(&[AnnouncementsRead])),
        )
        .route(
            "/api/v1/admin/announcements",
            permit(M::GET, notices::admin_view, Require(&[AnnouncementsRead])),
        )
        .route(
            "/api/v1/admin/announcements",
            permit(M::POST, notices::create, Require(&[AnnouncementsManage])),
        )
        .route(
            "/api/v1/admin/announcements/bulk",
            permit(M::POST, notices::bulk, Require(&[AnnouncementsManage])),
        )
        .route(
            "/api/v1/admin/announcements/{id}",
            permit(M::PUT, notices::update, Require(&[AnnouncementsManage])),
        )
        .route(
            "/api/v1/admin/announcements/{id}",
            permit(M::DELETE, notices::delete, Require(&[AnnouncementsManage])),
        )
        .route(
            "/api/v1/admin/announcements/{id}/publish",
            permit(M::POST, notices::publish, Require(&[AnnouncementsManage])),
        )
        .route(
            "/api/v1/admin/announcements/{id}/archive",
            permit(M::POST, notices::archive, Require(&[AnnouncementsManage])),
        )
}
