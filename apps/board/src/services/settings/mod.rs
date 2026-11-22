use axum::http::Uri;
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement, TransactionTrait};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    infra::error::{Error, Result, problem},
    services::access::{self, Permission},
};

const SUPPORTED_LOCALES: &[&str] = &["en", "zh-CN", "ja", "ru", "fa"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Panel {
    pub name: String,
    pub copyright: Option<String>,
    pub url: Option<String>,
    pub features: Features,
    pub landing: Landing,
    #[serde(default)]
    pub branding: BrandingExtra,
    #[serde(default)]
    pub appearance: Appearance,
    #[serde(default)]
    pub portal: PortalCustomization,
    #[serde(default)]
    pub subscription: SubscriptionUi,
    #[serde(default)]
    pub workspace: WorkspaceUi,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Features {
    pub registration: bool,
    pub announcements: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Accent {
    #[default]
    Emerald,
    Teal,
    Orange,
    Blue,
    Indigo,
    Rose,
    Slate,
    Custom,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Landing {
    pub headline: Option<String>,
    pub description: Option<String>,
    pub accent: Accent,
    pub show_features: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum IconPreset {
    #[default]
    Circles,
    Leaf,
    Shield,
    Globe,
    Lightning,
    Compass,
    Cube,
    Sparkle,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NavLink {
    pub label: String,
    pub url: String,
    #[serde(default = "default_true")]
    pub external: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BrandingExtra {
    #[serde(default)]
    pub tagline: Option<String>,
    #[serde(default)]
    pub icon_preset: IconPreset,
    #[serde(default)]
    pub logo_url: Option<String>,
    #[serde(default)]
    pub logo_dark_url: Option<String>,
    #[serde(default)]
    pub favicon_url: Option<String>,
    #[serde(default)]
    pub footer_links: Vec<NavLink>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ColorMode {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Density {
    #[default]
    Comfortable,
    Compact,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RadiusStyle {
    Sharp,
    #[default]
    Default,
    Rounded,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Appearance {
    #[serde(default)]
    pub default_mode: ColorMode,
    #[serde(default = "default_true")]
    pub allow_mode_switch: bool,
    #[serde(default)]
    pub accent_custom_hex: Option<String>,
    #[serde(default)]
    pub density: Density,
    #[serde(default)]
    pub radius: RadiusStyle,
    #[serde(default)]
    pub sidebar_default_collapsed: bool,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            default_mode: ColorMode::System,
            allow_mode_switch: true,
            accent_custom_hex: None,
            density: Density::Comfortable,
            radius: RadiusStyle::Default,
            sidebar_default_collapsed: false,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HeroStyle {
    #[default]
    Mesh,
    Grid,
    Minimal,
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HighlightCard {
    #[serde(default)]
    pub icon: IconPreset,
    pub title: String,
    pub description: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PortalCustomization {
    #[serde(default)]
    pub hero_badge: Option<String>,
    #[serde(default)]
    pub hero_style: HeroStyle,
    #[serde(default)]
    pub primary_cta: Option<String>,
    #[serde(default)]
    pub highlights: Vec<HighlightCard>,
    #[serde(default)]
    pub auth_title: Option<String>,
    #[serde(default)]
    pub auth_subtitle: Option<String>,
    #[serde(default)]
    pub auth_notice: Option<String>,
    #[serde(default)]
    pub terms_url: Option<String>,
    #[serde(default)]
    pub privacy_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClientPreset {
    Clash,
    Singbox,
    Shadowrocket,
    V2rayn,
    Hiddify,
}

fn default_clients() -> Vec<ClientPreset> {
    vec![
        ClientPreset::Clash,
        ClientPreset::Singbox,
        ClientPreset::Shadowrocket,
        ClientPreset::V2rayn,
        ClientPreset::Hiddify,
    ]
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InfoNodePlacementSetting {
    #[default]
    PrependToGroup,
    AppendToGroup,
    DedicatedGroup,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct InfoNodeFormats {
    #[serde(default = "default_true")]
    pub xray: bool,
    #[serde(default = "default_true")]
    pub sing_box: bool,
    #[serde(default = "default_true")]
    pub mihomo: bool,
    #[serde(default = "default_true")]
    pub universal: bool,
}

impl Default for InfoNodeFormats {
    fn default() -> Self {
        Self {
            xray: true,
            sing_box: true,
            mihomo: true,
            universal: true,
        }
    }
}

fn default_update_interval_hours() -> u16 {
    24
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionInfoNodes {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub formats: InfoNodeFormats,
    #[serde(default)]
    pub placement: InfoNodePlacementSetting,
    #[serde(default, deserialize_with = "deserialize_info_group_name")]
    pub group_name: String,
    #[serde(default = "default_true")]
    pub show_traffic: bool,
    #[serde(default = "default_true")]
    pub show_expiry: bool,
    #[serde(default = "default_true")]
    pub show_website: bool,
    #[serde(default)]
    pub custom_templates: Vec<String>,
}

fn deserialize_info_group_name<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<String, D::Error> {
    let name = String::deserialize(deserializer)?;
    // Older settings persisted the built-in title as if it were a custom title.
    Ok(if name.trim() == "📊 套餐信息" {
        String::new()
    } else {
        name
    })
}

impl Default for SubscriptionInfoNodes {
    fn default() -> Self {
        Self {
            enabled: true,
            formats: InfoNodeFormats::default(),
            placement: InfoNodePlacementSetting::PrependToGroup,
            group_name: String::new(),
            show_traffic: true,
            show_expiry: true,
            show_website: true,
            custom_templates: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionUi {
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub default_format: u8,
    #[serde(default = "default_clients")]
    pub enabled_clients: Vec<ClientPreset>,
    #[serde(default = "default_true")]
    pub show_qr_code: bool,
    #[serde(default)]
    pub guide_url: Option<String>,
    #[serde(default)]
    pub support_links: Vec<NavLink>,
    #[serde(default = "default_true")]
    pub include_userinfo_header: bool,
    #[serde(default = "default_update_interval_hours")]
    pub profile_update_interval_hours: u16,
    #[serde(default = "default_true")]
    pub include_filename_header: bool,
    #[serde(default = "default_true")]
    pub auto_provision_links: bool,
    #[serde(default)]
    pub info_nodes: SubscriptionInfoNodes,
}

impl Default for SubscriptionUi {
    fn default() -> Self {
        Self {
            base_url: None,
            default_format: 0,
            enabled_clients: default_clients(),
            show_qr_code: true,
            guide_url: None,
            support_links: Vec::new(),
            include_userinfo_header: true,
            profile_update_interval_hours: default_update_interval_hours(),
            include_filename_header: true,
            auto_provision_links: true,
            info_nodes: SubscriptionInfoNodes::default(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BannerVariant {
    #[default]
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MaintenanceBanner {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub variant: BannerVariant,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceUi {
    #[serde(default)]
    pub default_locale: Option<String>,
    #[serde(default)]
    pub enabled_locales: Vec<String>,
    #[serde(default = "default_true")]
    pub allow_profile_edit: bool,
    #[serde(default = "default_true")]
    pub show_devices_card: bool,
    #[serde(default)]
    pub maintenance_banner: MaintenanceBanner,
}

impl Default for WorkspaceUi {
    fn default() -> Self {
        Self {
            default_locale: None,
            enabled_locales: Vec::new(),
            allow_profile_edit: true,
            show_devices_card: true,
            maintenance_banner: MaintenanceBanner::default(),
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PanelRecord {
    pub revision: i64,
    pub panel: Panel,
}

impl Panel {
    pub fn defaults(registration: bool) -> Self {
        Self {
            name: "Meridian".to_owned(),
            copyright: None,
            url: None,
            features: Features {
                registration,
                announcements: true,
            },
            landing: Landing {
                headline: None,
                description: None,
                accent: Accent::default(),
                show_features: true,
            },
            branding: BrandingExtra::default(),
            appearance: Appearance::default(),
            portal: PortalCustomization::default(),
            subscription: SubscriptionUi::default(),
            workspace: WorkspaceUi::default(),
        }
    }

    fn normalize(mut self) -> Result<Self> {
        self.name = self.name.trim().to_owned();
        if self.name.is_empty()
            || self.name.chars().count() > 60
            || self.name.chars().any(char::is_control)
        {
            return Err(Error::BadRequest(problem::PANEL_NAME));
        }
        self.copyright = optional_text(self.copyright, 140, false)?;
        self.url = optional_http_url(self.url, 2048)?;
        self.landing.headline = optional_text(self.landing.headline, 120, false)?;
        self.landing.description = optional_text(self.landing.description, 600, true)?;

        // Branding
        self.branding.tagline = optional_text(self.branding.tagline, 100, false)?;
        self.branding.logo_url = optional_asset_url(self.branding.logo_url)?;
        self.branding.logo_dark_url = optional_asset_url(self.branding.logo_dark_url)?;
        self.branding.favicon_url = optional_asset_url(self.branding.favicon_url)?;
        self.branding.footer_links = normalize_links(self.branding.footer_links, 8)?;

        // Appearance
        self.appearance.accent_custom_hex =
            optional_hex_color(self.appearance.accent_custom_hex)?;

        // Portal
        self.portal.hero_badge = optional_text(self.portal.hero_badge, 60, false)?;
        self.portal.primary_cta = optional_text(self.portal.primary_cta, 48, false)?;
        self.portal.auth_title = optional_text(self.portal.auth_title, 80, false)?;
        self.portal.auth_subtitle = optional_text(self.portal.auth_subtitle, 240, false)?;
        self.portal.auth_notice = optional_text(self.portal.auth_notice, 400, true)?;
        self.portal.terms_url = optional_http_url(self.portal.terms_url, 2048)?;
        self.portal.privacy_url = optional_http_url(self.portal.privacy_url, 2048)?;
        self.portal.highlights = normalize_highlights(self.portal.highlights)?;

        // Subscription
        self.subscription.base_url = optional_http_url(self.subscription.base_url, 512)?
            .map(|url| url.trim_end_matches('/').to_owned());
        if self.subscription.default_format > 3 {
            return Err(Error::Invalid(
                "Default subscription format must be 0, 1, or 2.".to_owned(),
            ));
        }
        let mut dedup_clients = Vec::with_capacity(self.subscription.enabled_clients.len());
        for client in self.subscription.enabled_clients {
            if !dedup_clients.contains(&client) {
                dedup_clients.push(client);
            }
        }
        self.subscription.enabled_clients = dedup_clients;
        self.subscription.guide_url = optional_http_url(self.subscription.guide_url, 2048)?;
        self.subscription.support_links = normalize_links(self.subscription.support_links, 6)?;
        if !(1..=720).contains(&self.subscription.profile_update_interval_hours) {
            return Err(Error::Invalid(
                "Profile update interval must be between 1 and 720 hours.".to_owned(),
            ));
        }
        self.subscription.info_nodes.group_name =
            optional_text(Some(self.subscription.info_nodes.group_name), 40, false)?
                .unwrap_or_default();
        if self.subscription.info_nodes.custom_templates.len() > 5 {
            return Err(Error::Invalid(
                "Add up to 5 custom info node templates.".to_owned(),
            ));
        }
        let mut clean_templates = Vec::with_capacity(self.subscription.info_nodes.custom_templates.len());
        for tpl in self.subscription.info_nodes.custom_templates {
            if let Some(cleaned) = optional_text(Some(tpl), 120, false)? {
                clean_templates.push(cleaned);
            }
        }
        self.subscription.info_nodes.custom_templates = clean_templates;

        // Workspace
        self.workspace.default_locale = match self.workspace.default_locale {
            Some(ref loc) if !loc.trim().is_empty() => {
                let trimmed = loc.trim();
                if !SUPPORTED_LOCALES.contains(&trimmed) {
                    return Err(Error::Invalid("Unsupported default locale.".to_owned()));
                }
                Some(trimmed.to_owned())
            }
            _ => None,
        };
        let mut valid_locales = Vec::new();
        for loc in self.workspace.enabled_locales {
            let trimmed = loc.trim();
            if !SUPPORTED_LOCALES.contains(&trimmed) {
                return Err(Error::Invalid("Unsupported locale in enabled list.".to_owned()));
            }
            if !valid_locales.iter().any(|existing| existing == trimmed) {
                valid_locales.push(trimmed.to_owned());
            }
        }
        self.workspace.enabled_locales = valid_locales;
        self.workspace.maintenance_banner.title =
            optional_text(self.workspace.maintenance_banner.title, 120, false)?;
        self.workspace.maintenance_banner.message =
            optional_text(self.workspace.maintenance_banner.message, 500, true)?;

        Ok(self)
    }
}

fn optional_text(value: Option<String>, limit: usize, multiline: bool) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim();
    if value.chars().count() > limit
        || value
            .chars()
            .any(|ch| ch.is_control() && !(multiline && matches!(ch, '\n' | '\r' | '\t')))
    {
        return Err(Error::Invalid(format!(
            "Use up to {limit} characters in each field."
        )));
    }
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

fn is_valid_http_url(value: &str) -> bool {
    value.parse::<Uri>().ok().is_some_and(|uri| {
        matches!(uri.scheme_str(), Some("https" | "http"))
            && uri.authority().is_some_and(|authority| {
                !authority.host().is_empty() && !authority.as_str().contains('@')
            })
    })
}

fn optional_http_url(value: Option<String>, limit: usize) -> Result<Option<String>> {
    let Some(cleaned) = optional_text(value, limit, false)? else {
        return Ok(None);
    };
    if !is_valid_http_url(&cleaned) {
        return Err(Error::BadRequest(problem::PANEL_URL));
    }
    Ok(Some(cleaned))
}

fn optional_asset_url(value: Option<String>) -> Result<Option<String>> {
    let Some(cleaned) = optional_text(value, 2048, false)? else {
        return Ok(None);
    };
    // Allow either safe http(s) URL or root-relative asset path (not protocol-relative //)
    let is_relative = cleaned.starts_with('/') && !cleaned.starts_with("//");
    if !is_relative && !is_valid_http_url(&cleaned) {
        return Err(Error::BadRequest(problem::PANEL_URL));
    }
    Ok(Some(cleaned))
}

fn optional_hex_color(value: Option<String>) -> Result<Option<String>> {
    let Some(cleaned) = optional_text(value, 7, false)? else {
        return Ok(None);
    };
    let bytes = cleaned.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' || !bytes[1..].iter().all(u8::is_ascii_hexdigit) {
        return Err(Error::Invalid(
            "Enter a valid 6-digit hex color such as #10b981.".to_owned(),
        ));
    }
    Ok(Some(cleaned.to_ascii_lowercase()))
}

fn normalize_links(links: Vec<NavLink>, max: usize) -> Result<Vec<NavLink>> {
    if links.len() > max {
        return Err(Error::Invalid(format!("Add up to {max} links.")));
    }
    let mut result = Vec::with_capacity(links.len());
    for link in links {
        let label = optional_text(Some(link.label), 48, false)?
            .ok_or_else(|| Error::Invalid("Link label cannot be empty.".to_owned()))?;
        let url = optional_http_url(Some(link.url), 2048)?
            .ok_or(Error::BadRequest(problem::PANEL_URL))?;
        result.push(NavLink {
            label,
            url,
            external: link.external,
        });
    }
    Ok(result)
}

fn normalize_highlights(cards: Vec<HighlightCard>) -> Result<Vec<HighlightCard>> {
    if cards.len() > 6 {
        return Err(Error::Invalid("Add up to 6 highlight cards.".to_owned()));
    }
    let mut result = Vec::with_capacity(cards.len());
    for card in cards {
        let title = optional_text(Some(card.title), 60, false)?
            .ok_or_else(|| Error::Invalid("Highlight title cannot be empty.".to_owned()))?;
        let description = optional_text(Some(card.description), 240, true)?
            .ok_or_else(|| Error::Invalid("Highlight description cannot be empty.".to_owned()))?;
        result.push(HighlightCard {
            icon: card.icon,
            title,
            description,
        });
    }
    Ok(result)
}

fn record_error(error: serde_json::Error) -> Error {
    Error::Internal(error.into())
}

pub async fn read(db: &impl ConnectionTrait, registration: bool) -> Result<PanelRecord> {
    let row = db
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT value, revision FROM panel_settings WHERE id = 1",
        ))
        .await?;
    match row {
        Some(row) => Ok(PanelRecord {
            revision: row.try_get("", "revision")?,
            panel: serde_json::from_value(row.try_get::<Value>("", "value")?)
                .map_err(record_error)?,
        }),
        None => Ok(PanelRecord {
            revision: 0,
            panel: Panel::defaults(registration),
        }),
    }
}

pub async fn public(db: &DatabaseConnection, registration: bool) -> Result<Panel> {
    // Allow embedded public pages to use their deployment defaults without a connection.
    if matches!(db, DatabaseConnection::Disconnected) {
        return Ok(Panel::defaults(registration));
    }
    Ok(read(db, registration).await?.panel)
}

pub async fn update(
    db: &DatabaseConnection,
    actor: Uuid,
    input: PanelRecord,
) -> Result<PanelRecord> {
    let panel = input.panel.normalize()?;
    let next = input
        .revision
        .checked_add(1)
        .filter(|next| *next > 0)
        .ok_or(Error::BadRequest(problem::PANEL_REVISION))?;
    let value = serde_json::to_value(&panel).map_err(record_error)?;
    let tx = db.begin().await?;
    access::begin_change(&tx).await?;
    access::actor(&tx, actor, &[Permission::SettingsManage]).await?;
    let statement = if input.revision == 0 {
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO panel_settings (id, value, revision) VALUES (1, $1, $2) ON CONFLICT DO NOTHING",
            [value.into(), next.into()],
        )
    } else {
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE panel_settings SET value = $1, revision = $2 WHERE id = 1 AND revision = $3",
            [value.into(), next.into(), input.revision.into()],
        )
    };
    if tx.execute(statement).await?.rows_affected() != 1 {
        return Err(Error::Conflict(problem::PANEL_CHANGED));
    }
    access::audit(&tx, actor, "panel.settings_updated", Uuid::nil()).await?;
    tx.commit().await?;
    Ok(PanelRecord {
        revision: next,
        panel,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_use_emerald_accent() {
        let panel = Panel::defaults(false);
        assert_eq!(panel.landing.accent, Accent::Emerald);
        assert!(panel.appearance.allow_mode_switch);
        assert!(panel.subscription.show_qr_code);
        assert_eq!(panel.subscription.enabled_clients.len(), 5);
    }

    #[test]
    fn legacy_panel_json_deserializes_with_defaults() {
        let legacy = json!({
            "name": "Legacy",
            "copyright": null,
            "url": "https://example.net",
            "features": { "registration": true, "announcements": false },
            "landing": { "headline": null, "description": null, "accent": "indigo", "show_features": true }
        });
        let parsed: Panel = serde_json::from_value(legacy).unwrap();
        let normalized = parsed.normalize().unwrap();
        assert_eq!(normalized.name, "Legacy");
        assert_eq!(normalized.landing.accent, Accent::Indigo);
        assert!(normalized.appearance.allow_mode_switch);
        assert!(normalized.branding.footer_links.is_empty());
    }

    #[test]
    fn legacy_info_group_title_uses_the_localized_default() {
        let old: SubscriptionInfoNodes =
            serde_json::from_value(json!({ "group_name": "📊 套餐信息" })).unwrap();
        let custom: SubscriptionInfoNodes =
            serde_json::from_value(json!({ "group_name": "套餐详情" })).unwrap();
        assert!(old.group_name.is_empty());
        assert_eq!(custom.group_name, "套餐详情");
    }

    #[test]
    fn rejects_invalid_hex_and_urls() {
        let mut bad_hex = Panel::defaults(false);
        bad_hex.appearance.accent_custom_hex = Some("not-a-hex".to_owned());
        assert!(bad_hex.normalize().is_err());

        let mut bad_logo = Panel::defaults(false);
        bad_logo.branding.logo_url = Some("javascript:alert(1)".to_owned());
        assert!(bad_logo.normalize().is_err());

        let mut ok_relative = Panel::defaults(false);
        ok_relative.branding.logo_url = Some("/logo.svg".to_owned());
        ok_relative.appearance.accent_custom_hex = Some("#10B981".to_owned());
        let saved = ok_relative.normalize().unwrap();
        assert_eq!(saved.branding.logo_url.as_deref(), Some("/logo.svg"));
        assert_eq!(
            saved.appearance.accent_custom_hex.as_deref(),
            Some("#10b981")
        );
    }
}
