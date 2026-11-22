use std::collections::HashSet;

use anyhow::Result;
use serde_json::{Value, json};

use crate::{
    Core,
    cores::{InfoNodePlacement, RenderOptions},
    protocols::{NativeEndpoint, Section},
    routing::{
        Action, DEFAULT_RULESET_INTERVAL_SECS, GroupKind, Match, Policy, parse_port_spec,
        ports::RoutingCompiler,
    },
};

const SING_GEOSITE_BASE: &str =
    "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set";
const SING_GEOIP_BASE: &str = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set";

pub(super) struct SingBox;

impl RoutingCompiler for SingBox {
    fn core(&self) -> Core {
        Core::SingBox
    }

    fn compile(&self, endpoints: &[NativeEndpoint], policy: &Policy) -> Result<Value> {
        self.compile_with_options(endpoints, policy, &RenderOptions::default())
    }

    fn compile_with_options(
        &self,
        endpoints: &[NativeEndpoint],
        policy: &Policy,
        options: &RenderOptions,
    ) -> Result<Value> {
        let mut outbounds = vec![json!({"type":"direct","tag":"direct"})];
        let mut real_outbounds = Vec::new();
        let mut core_endpoints = Vec::new();
        let mut tags = Vec::new();
        for entry in endpoints {
            tags.push(entry.config["tag"].clone());
            match entry.section {
                Section::Outbound => real_outbounds.push(entry.config.clone()),
                Section::Endpoint => core_endpoints.push(entry.config.clone()),
            }
        }

        let existing_tags: Vec<String> = tags
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let info_tags = options.unique_info_labels(existing_tags.iter().cloned());
        let info_outbounds: Vec<Value> = info_tags
            .iter()
            .map(|label| {
                json!({
                    "type": "socks",
                    "tag": label,
                    "server": "127.0.0.1",
                    "server_port": 1
                })
            })
            .collect();

        if options.placement == InfoNodePlacement::AppendToGroup {
            outbounds.extend(real_outbounds);
            outbounds.extend(info_outbounds);
        } else {
            outbounds.extend(info_outbounds);
            outbounds.extend(real_outbounds);
        }

        if !info_tags.is_empty() && options.placement == InfoNodePlacement::DedicatedGroup {
            let group_tag = if options.group_label() == "group" {
                "info"
            } else {
                options.group_label()
            };
            outbounds.push(json!({
                "type": "selector",
                "tag": group_tag,
                "outbounds": info_tags
            }));
        }

        // Track automated (urltest/fallback/load_balance) group names so select groups can reference them.
        let auto_group_names: Vec<String> = policy
            .groups
            .iter()
            .filter(|g| !matches!(g.kind, GroupKind::Select))
            .map(|g| g.name.clone())
            .collect();

        if !tags.is_empty() {
            let mut base_group = Vec::new();
            for auto_name in &auto_group_names {
                base_group.push(json!(auto_name));
            }
            match options.placement {
                InfoNodePlacement::PrependToGroup if !info_tags.is_empty() => {
                    base_group.extend(info_tags.iter().map(|label| json!(label)));
                    base_group.extend(tags.clone());
                }
                InfoNodePlacement::AppendToGroup if !info_tags.is_empty() => {
                    base_group.extend(tags.clone());
                    base_group.extend(info_tags.iter().map(|label| json!(label)));
                }
                _ => {
                    base_group.extend(tags.clone());
                }
            }
            outbounds.push(json!({"type":"selector","tag":"group","outbounds":base_group}));
        }

        // Build custom policy groups (selector / urltest outbounds).
        for group in &policy.groups {
            let mut matched: Vec<String> = existing_tags
                .iter()
                .filter(|tag| group.matches_node(tag))
                .cloned()
                .collect();
            if matched.is_empty() {
                matched = existing_tags.clone();
            }
            match group.kind {
                GroupKind::Select => {
                    let mut members: Vec<String> = Vec::new();
                    if group.include_auto {
                        for auto_name in &auto_group_names {
                            if auto_name != &group.name && !members.contains(auto_name) {
                                members.push(auto_name.clone());
                            }
                        }
                    }
                    if !existing_tags.is_empty() && !members.iter().any(|m| m == "group") {
                        // Allow falling back to matched nodes directly
                        for tag in &matched {
                            if !members.contains(tag) {
                                members.push(tag.clone());
                            }
                        }
                    }
                    if group.include_direct && !members.iter().any(|m| m == "direct") {
                        members.push("direct".to_string());
                    }
                    if members.is_empty() {
                        members.push("direct".to_string());
                    }
                    outbounds.push(json!({
                        "type": "selector",
                        "tag": group.name,
                        "outbounds": members
                    }));
                }
                GroupKind::UrlTest | GroupKind::Fallback | GroupKind::LoadBalance => {
                    let members = if matched.is_empty() {
                        vec!["direct".to_string()]
                    } else {
                        matched
                    };
                    outbounds.push(json!({
                        "type": "urltest",
                        "tag": group.name,
                        "outbounds": members,
                        "url": group.effective_test_url(),
                        "interval": format!("{}s", group.effective_interval_secs()),
                        "tolerance": 50
                    }));
                }
            }
        }

        // Build remote rule_sets: user-defined + auto-injected SRS for GeoSite / GeoIP rules.
        let mut rule_sets: Vec<Value> = Vec::new();
        let mut defined_rs_tags: HashSet<String> = HashSet::new();
        for rs in &policy.rule_sets {
            let Some(url) = rs.sing_box_url.as_deref() else {
                continue;
            };
            let format = if url.ends_with(".json") {
                "source"
            } else {
                "binary"
            };
            defined_rs_tags.insert(rs.tag.clone());
            rule_sets.push(json!({
                "tag": rs.tag,
                "type": "remote",
                "format": format,
                "url": url,
                "update_interval": format!("{}s", rs.interval_secs.unwrap_or(DEFAULT_RULESET_INTERVAL_SECS))
            }));
        }

        let mut rules = Vec::new();
        if policy.rules.iter().any(|r| r.kind == Match::Protocol) {
            rules.push(json!({"action": "sniff"}));
        }

        for rule in &policy.rules {
            if tags.is_empty() && rule.action == Action::Proxy {
                continue;
            }
            let mut config = route(rule.action, rule.group_id.as_deref(), policy);
            match rule.kind {
                Match::Domain => config["domain"] = json!([rule.value]),
                Match::DomainSuffix => config["domain_suffix"] = json!([rule.value]),
                Match::DomainKeyword => config["domain_keyword"] = json!([rule.value]),
                Match::IpCidr => config["ip_cidr"] = json!([rule.value]),
                Match::GeoIp => {
                    if rule.value == "private" {
                        config["ip_is_private"] = json!(true);
                    } else {
                        let rs_tag = format!("geoip-{}", rule.value);
                        if defined_rs_tags.insert(rs_tag.clone()) {
                            rule_sets.push(json!({
                                "tag": rs_tag,
                                "type": "remote",
                                "format": "binary",
                                "url": format!("{SING_GEOIP_BASE}/geoip-{}.srs", rule.value)
                            }));
                        }
                        config["rule_set"] = json!([rs_tag]);
                    }
                }
                Match::GeoSite => {
                    let rs_tag = format!("geosite-{}", rule.value);
                    if defined_rs_tags.insert(rs_tag.clone()) {
                        rule_sets.push(json!({
                            "tag": rs_tag,
                            "type": "remote",
                            "format": "binary",
                            "url": format!("{SING_GEOSITE_BASE}/geosite-{}.srs", rule.value)
                        }));
                    }
                    config["rule_set"] = json!([rs_tag]);
                }
                Match::Port => {
                    let ranges = parse_port_spec(&rule.value)?;
                    let singles: Vec<u16> = ranges
                        .iter()
                        .filter(|(a, b)| a == b)
                        .map(|(a, _)| *a)
                        .collect();
                    let spans: Vec<String> = ranges
                        .iter()
                        .filter(|(a, b)| a != b)
                        .map(|(a, b)| format!("{a}:{b}"))
                        .collect();
                    if !singles.is_empty() {
                        config["port"] = json!(singles);
                    }
                    if !spans.is_empty() {
                        config["port_range"] = json!(spans);
                    }
                }
                Match::Protocol => config["protocol"] = json!([rule.value]),
                Match::ProcessName => config["process_name"] = json!([rule.value]),
                Match::RuleSet => {
                    if !defined_rs_tags.contains(&rule.value) {
                        continue;
                    }
                    config["rule_set"] = json!([rule.value]);
                }
            }
            rules.push(config);
        }

        if policy.default_action == Action::Block {
            rules.push(json!({"inbound":["local"],"action":"reject"}));
        }
        let default = match policy.default_action {
            Action::Proxy if !tags.is_empty() => "group".to_string(),
            Action::Group => policy
                .default_group_id
                .as_deref()
                .and_then(|id| policy.find_group(id))
                .map(|g| g.name.clone())
                .unwrap_or_else(|| "direct".to_string()),
            _ => "direct".to_string(),
        };

        let mut route_obj = json!({"rules": rules, "final": default});
        if !rule_sets.is_empty() {
            route_obj["rule_set"] = Value::Array(rule_sets);
        }

        Ok(json!({
            "inbounds":[{"type":"mixed","tag":"local","listen":"127.0.0.1","listen_port":1080}],
            "outbounds":outbounds,
            "endpoints":core_endpoints,
            "route":route_obj
        }))
    }
}

fn route(action: Action, group_id: Option<&str>, policy: &Policy) -> Value {
    match action {
        Action::Proxy => json!({"action":"route","outbound":"group"}),
        Action::Direct => json!({"action":"route","outbound":"direct"}),
        Action::Block => json!({"action":"reject"}),
        Action::Group => {
            let outbound = group_id
                .and_then(|id| policy.find_group(id))
                .map(|g| g.name.as_str())
                .unwrap_or("group");
            json!({"action":"route","outbound":outbound})
        }
    }
}
