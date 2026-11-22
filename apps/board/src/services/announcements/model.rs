use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Copy, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Draft,
    Queued,
    Published,
    Archived,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Queued => "queued",
            Self::Published => "published",
            Self::Archived => "archived",
        }
    }
}

#[derive(Copy, Clone, Default, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayMode {
    #[default]
    Normal,
    Fullscreen,
}

impl DisplayMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Fullscreen => "fullscreen",
        }
    }
}

#[derive(Deserialize)]
pub struct Filter {
    pub q: Option<String>,
    pub status: Option<Status>,
    #[serde(default)]
    pub page: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Draft {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub display_mode: DisplayMode,
    #[serde(default)]
    pub starts_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub ends_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftUpdate {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub display_mode: DisplayMode,
    #[serde(default)]
    pub starts_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub ends_at: Option<DateTime<Utc>>,
    pub revision: i64,
}

#[derive(Serialize)]
pub struct AdminNotice {
    pub id: Uuid,
    pub title: String,
    pub body: String,
    pub status: String,
    pub display_mode: String,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub revision: i64,
    pub updated_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
    pub failed: bool,
}

#[derive(Serialize)]
pub struct AdminView {
    pub items: Vec<AdminNotice>,
    pub total: i64,
    pub page_size: i64,
}

#[derive(Serialize)]
pub struct Notice {
    pub id: Uuid,
    pub title: String,
    pub body: String,
    pub display_mode: String,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub published_at: DateTime<Utc>,
    pub read: bool,
}

#[derive(Serialize)]
pub struct Inbox {
    pub items: Vec<Notice>,
    pub unread: i64,
    pub total: i64,
    pub page_size: i64,
}

#[derive(Serialize)]
pub struct UnreadSummary {
    pub unread: i64,
    pub fullscreen: Vec<Notice>,
}

#[derive(Deserialize)]
pub struct Read {
    pub ids: Option<Vec<Uuid>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BulkAction {
    Archive,
    Delete,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bulk {
    pub ids: Vec<Uuid>,
    pub action: BulkAction,
}
