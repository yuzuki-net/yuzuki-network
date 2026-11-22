use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    infra::postgres::entities::account,
    services::access::RoleSummary,
};

#[derive(Serialize)]
pub struct Account {
    id: Uuid,
    display_name: String,
    locale: Option<String>,
    created_at: DateTime<Utc>,
    email: String,
    admin: bool,
    active: bool,
    quota_bytes: Option<String>,
    used_bytes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    roles: Option<Vec<RoleSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quota: Option<crate::services::quotas::policy::Status>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_editable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quota_editable: Option<bool>,
}

impl From<account::Model> for Account {
    fn from(row: account::Model) -> Self {
        Self {
            id: row.id,
            email: row.email,
            display_name: row.display_name,
            locale: row.locale,
            created_at: row.created_at,
            admin: row.admin,
            active: row.active,
            quota_bytes: None,
            used_bytes: row.used_bytes.to_string(),
            roles: None,
            quota: None,
            status_editable: None,
            quota_editable: None,
        }
    }
}

impl Account {
    pub fn directory(row: account::Model, read_quota: bool) -> Self {
        let mut profile = Self::from(row);
        if !read_quota {
            profile.quota_bytes = None;
            profile.used_bytes.clear();
        }
        profile
    }

    pub fn with_roles(mut self, roles: Option<Vec<RoleSummary>>) -> Self {
        self.roles = roles;
        self
    }

    pub fn with_quota(mut self, quota: Option<crate::services::quotas::policy::Status>) -> Self {
        if let Some(ref status) = quota {
            self.quota_bytes = status.quota_bytes.clone();
        }
        self.quota = quota;
        self
    }

    pub fn with_directory_actions(mut self, status: bool, quota: bool) -> Self {
        self.status_editable = Some(status);
        self.quota_editable = Some(quota);
        self
    }
}
