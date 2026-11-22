pub mod ports;
mod preview;

pub use preview::Decision;

use std::collections::{BTreeMap, HashSet};

use anyhow::{Result, ensure};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Core, protocols::valid_host};

pub const DEFAULT_TEST_URL: &str = "http://www.gstatic.com/generate_204";
pub const DEFAULT_GROUP_INTERVAL_SECS: u32 = 300;
pub const DEFAULT_RULESET_INTERVAL_SECS: u32 = 86_400;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Proxy,
    Direct,
    Block,
    Group,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Match {
    Domain,
    DomainSuffix,
    DomainKeyword,
    IpCidr,
    #[serde(rename = "geoip")]
    GeoIp,
    #[serde(rename = "geosite")]
    GeoSite,
    Port,
    Protocol,
    ProcessName,
    RuleSet,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GroupKind {
    #[default]
    Select,
    UrlTest,
    Fallback,
    LoadBalance,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RouteGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: GroupKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_filter: Option<String>,
    #[serde(default)]
    pub include_direct: bool,
    #[serde(default)]
    pub include_reject: bool,
    #[serde(default)]
    pub include_auto: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_secs: Option<u32>,
}

impl RouteGroup {
    /// Matches a node name against optional `|` or `,` separated keywords (case-insensitive).
    /// Tokens prefixed with `!` act as exclusions. Blank filter matches all nodes.
    pub fn matches_node(&self, node_name: &str) -> bool {
        let Some(raw) = self.node_filter.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
            return true;
        };
        let lower = node_name.to_lowercase();
        let mut includes = Vec::new();
        let mut excludes = Vec::new();
        for token in raw.split(['|', ',']).map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(neg) = token.strip_prefix('!') {
                let neg = neg.trim();
                if !neg.is_empty() {
                    excludes.push(neg.to_lowercase());
                }
            } else {
                includes.push(token.to_lowercase());
            }
        }
        if excludes.iter().any(|ex| lower.contains(ex)) {
            return false;
        }
        includes.is_empty() || includes.iter().any(|inc| lower.contains(inc))
    }

    pub fn effective_test_url(&self) -> &str {
        self.test_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_TEST_URL)
    }

    pub fn effective_interval_secs(&self) -> u32 {
        self.interval_secs.unwrap_or(DEFAULT_GROUP_INTERVAL_SECS)
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleSetBehavior {
    #[default]
    Classical,
    Domain,
    Ipcidr,
}

impl RuleSetBehavior {
    pub const fn as_mihomo(self) -> &'static str {
        match self {
            Self::Classical => "classical",
            Self::Domain => "domain",
            Self::Ipcidr => "ipcidr",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuleSet {
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sing_box_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mihomo_url: Option<String>,
    #[serde(default)]
    pub behavior: RuleSetBehavior,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_secs: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub kind: Match,
    pub value: String,
    pub action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub default_action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_group_id: Option<String>,
    #[serde(default)]
    pub groups: Vec<RouteGroup>,
    #[serde(default)]
    pub rule_sets: Vec<RuleSet>,
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub native: BTreeMap<Core, Value>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            default_action: Action::Proxy,
            default_group_id: None,
            groups: Vec::new(),
            rule_sets: Vec::new(),
            rules: Vec::new(),
            native: BTreeMap::new(),
        }
    }
}

fn valid_slug(raw: &str, max_len: usize) -> bool {
    !raw.is_empty()
        && raw.len() <= max_len
        && raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn valid_geo_tag(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 64
        && raw.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'!')
        })
}

fn valid_http_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
        && trimmed.len() <= 2048
        && !trimmed.chars().any(|c| c.is_control() || c.is_whitespace())
}

pub(crate) fn parse_port_spec(raw: &str) -> Result<Vec<(u16, u16)>> {
    let mut ranges = Vec::new();
    for part in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if let Some((a, b)) = part.split_once('-').or_else(|| part.split_once(':')) {
            let start: u16 = a.trim().parse()?;
            let end: u16 = b.trim().parse()?;
            ensure!(start >= 1 && start <= end, "invalid port range");
            ranges.push((start, end));
        } else {
            let port: u16 = part.parse()?;
            ensure!(port >= 1, "invalid port");
            ranges.push((port, port));
        }
    }
    ensure!(!ranges.is_empty(), "empty port specification");
    Ok(ranges)
}

fn format_port_spec(ranges: &[(u16, u16)]) -> String {
    ranges
        .iter()
        .map(|(a, b)| {
            if a == b {
                a.to_string()
            } else {
                format!("{a}-{b}")
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

impl Policy {
    pub fn find_group(&self, id: &str) -> Option<&RouteGroup> {
        self.groups.iter().find(|g| g.id == id)
    }

    pub fn normalize(&mut self) -> Result<()> {
        let mut group_ids = HashSet::new();
        let mut group_names = HashSet::new();
        for group in &mut self.groups {
            group.id = group.id.trim().to_ascii_lowercase();
            group.name = group.name.trim().to_string();
            ensure!(valid_slug(&group.id, 40), "invalid group id");
            ensure!(
                !group.name.is_empty()
                    && group.name.chars().count() <= 64
                    && !group.name.chars().any(char::is_control)
                    && !matches!(
                        group.name.to_ascii_lowercase().as_str(),
                        "direct" | "reject" | "block" | "group"
                    ),
                "invalid group name"
            );
            ensure!(group_ids.insert(group.id.clone()), "duplicate group id");
            ensure!(
                group_names.insert(group.name.to_lowercase()),
                "duplicate group name"
            );
            group.node_filter = group
                .node_filter
                .take()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if let Some(filter) = &group.node_filter {
                ensure!(
                    filter.chars().count() <= 200 && !filter.chars().any(char::is_control),
                    "invalid node filter"
                );
            }
            group.test_url = group
                .test_url
                .take()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if let Some(url) = &group.test_url {
                ensure!(valid_http_url(url), "invalid group test URL");
            }
            if let Some(interval) = group.interval_secs {
                ensure!(
                    (30..=86_400).contains(&interval),
                    "group interval must be between 30 and 86400 seconds"
                );
            }
        }

        let mut rule_set_tags = HashSet::new();
        for rs in &mut self.rule_sets {
            rs.tag = rs.tag.trim().to_ascii_lowercase();
            ensure!(valid_slug(&rs.tag, 64), "invalid rule set tag");
            ensure!(rule_set_tags.insert(rs.tag.clone()), "duplicate rule set tag");
            rs.sing_box_url = rs
                .sing_box_url
                .take()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            rs.mihomo_url = rs
                .mihomo_url
                .take()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            ensure!(
                rs.sing_box_url.is_some() || rs.mihomo_url.is_some(),
                "rule set requires at least one URL"
            );
            if let Some(url) = &rs.sing_box_url {
                ensure!(valid_http_url(url), "invalid sing-box rule set URL");
            }
            if let Some(url) = &rs.mihomo_url {
                ensure!(valid_http_url(url), "invalid mihomo rule set URL");
            }
            if let Some(interval) = rs.interval_secs {
                ensure!(
                    (300..=604_800).contains(&interval),
                    "rule set interval must be between 300 and 604800 seconds"
                );
            }
        }

        if self.default_action == Action::Group {
            let gid = self
                .default_group_id
                .as_deref()
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("default group action requires a group_id"))?;
            ensure!(group_ids.contains(&gid), "unknown default_group_id");
            self.default_group_id = Some(gid);
        } else {
            self.default_group_id = None;
        }

        for rule in &mut self.rules {
            let raw_trimmed = rule.value.trim();
            let lower = raw_trimmed.to_ascii_lowercase();
            rule.value = match rule.kind {
                Match::IpCidr => lower.parse::<IpNet>()?.trunc().to_string(),
                Match::Domain | Match::DomainSuffix => {
                    ensure!(
                        valid_host(&lower) && lower.parse::<std::net::IpAddr>().is_err(),
                        "invalid domain"
                    );
                    lower
                }
                Match::DomainKeyword => {
                    ensure!(
                        !lower.is_empty()
                            && lower.len() <= 253
                            && !lower.chars().any(|c| c.is_control() || c.is_whitespace() || c == ','),
                        "invalid domain keyword"
                    );
                    lower
                }
                Match::GeoIp => {
                    let tag = lower.strip_prefix("geoip:").unwrap_or(&lower);
                    ensure!(valid_geo_tag(tag), "invalid GeoIP code");
                    tag.to_string()
                }
                Match::GeoSite => {
                    let tag = lower.strip_prefix("geosite:").unwrap_or(&lower);
                    ensure!(valid_geo_tag(tag), "invalid GeoSite tag");
                    tag.to_string()
                }
                Match::Port => {
                    let ranges = parse_port_spec(&lower)?;
                    format_port_spec(&ranges)
                }
                Match::Protocol => {
                    ensure!(valid_slug(&lower, 32), "invalid protocol matcher");
                    lower
                }
                Match::ProcessName => {
                    ensure!(
                        !raw_trimmed.is_empty()
                            && raw_trimmed.chars().count() <= 128
                            && !raw_trimmed.chars().any(|c| c.is_control() || c == ','),
                        "invalid process name"
                    );
                    raw_trimmed.to_string()
                }
                Match::RuleSet => {
                    ensure!(valid_slug(&lower, 64), "invalid rule set tag");
                    lower
                }
            };

            if rule.action == Action::Group {
                let gid = rule
                    .group_id
                    .as_deref()
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("group rule requires group_id"))?;
                ensure!(group_ids.contains(&gid), "rule references unknown group_id");
                rule.group_id = Some(gid);
            } else {
                rule.group_id = None;
            }
        }
        for entry in self.native.values() {
            ensure!(entry.is_object(), "native overlay must be a JSON object");
        }
        Ok(())
    }

    pub fn requires_proxy(&self) -> bool {
        matches!(self.default_action, Action::Proxy | Action::Group)
            || self
                .rules
                .iter()
                .any(|rule| matches!(rule.action, Action::Proxy | Action::Group))
    }
}

// Overlay maps recursively. Arrays of rules and groups are replaced atomically.
pub fn overlay(base: &mut Value, additional: &Value) {
    match (base, additional) {
        (Value::Object(base), Value::Object(additional)) => {
            for (key, value) in additional {
                overlay(base.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (base, value) => *base = value.clone(),
    }
}
