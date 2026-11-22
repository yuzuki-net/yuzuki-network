use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::{
    Core,
    cores::{InfoNodePlacement, RenderOptions},
    protocols::NativeEndpoint,
    routing::{
        Action, DEFAULT_RULESET_INTERVAL_SECS, GroupKind, Match, Policy, parse_port_spec,
        ports::RoutingCompiler,
    },
};

pub(super) struct Mihomo;

impl RoutingCompiler for Mihomo {
    fn core(&self) -> Core {
        Core::Mihomo
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
        let real_proxies: Vec<Value> = endpoints.iter().map(|entry| entry.config.clone()).collect();
        let names: Vec<Value> = real_proxies.iter().map(|entry| entry["name"].clone()).collect();

        let existing_names: Vec<String> = names
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let info_names = options.unique_info_labels(existing_names.iter().cloned());
        let info_proxies: Vec<Value> = info_names
            .iter()
            .map(|label| {
                json!({
                    "name": label,
                    "type": "socks5",
                    "server": "127.0.0.1",
                    "port": 1
                })
            })
            .collect();

        let mut proxies = Vec::with_capacity(real_proxies.len() + info_proxies.len());
        if options.placement == InfoNodePlacement::AppendToGroup {
            proxies.extend(real_proxies);
            proxies.extend(info_proxies);
        } else {
            proxies.extend(info_proxies);
            proxies.extend(real_proxies);
        }

        let auto_group_names: Vec<String> = policy
            .groups
            .iter()
            .filter(|g| !matches!(g.kind, GroupKind::Select))
            .map(|g| g.name.clone())
            .collect();

        let mut groups = Vec::new();
        if !info_names.is_empty() && options.placement == InfoNodePlacement::DedicatedGroup {
            let group_name = if options.group_label() == "group" {
                super::DEFAULT_INFO_GROUP_NAME
            } else {
                options.group_label()
            };
            groups.push(json!({
                "name": group_name,
                "type": "select",
                "proxies": info_names
            }));
        }
        if !names.is_empty() {
            let mut group_proxies: Vec<Value> = auto_group_names.iter().map(|n| json!(n)).collect();
            match options.placement {
                InfoNodePlacement::PrependToGroup if !info_names.is_empty() => {
                    group_proxies.extend(info_names.iter().map(|label| json!(label)));
                    group_proxies.extend(names.clone());
                }
                InfoNodePlacement::AppendToGroup if !info_names.is_empty() => {
                    group_proxies.extend(names.clone());
                    group_proxies.extend(info_names.iter().map(|label| json!(label)));
                }
                _ => {
                    group_proxies.extend(names.clone());
                }
            }
            groups.push(json!({"name":"group","type":"select","proxies":group_proxies}));
        }

        // Emit custom policy groups.
        for group in &policy.groups {
            let mut matched: Vec<String> = existing_names
                .iter()
                .filter(|name| group.matches_node(name))
                .cloned()
                .collect();
            if matched.is_empty() {
                matched = existing_names.clone();
            }
            let kind_str = match group.kind {
                GroupKind::Select => "select",
                GroupKind::UrlTest => "url-test",
                GroupKind::Fallback => "fallback",
                GroupKind::LoadBalance => "load-balance",
            };
            let mut members: Vec<String> = Vec::new();
            if group.kind == GroupKind::Select {
                if group.include_auto {
                    for auto_name in &auto_group_names {
                        if auto_name != &group.name && !members.contains(auto_name) {
                            members.push(auto_name.clone());
                        }
                    }
                }
                for name in &matched {
                    if !members.contains(name) {
                        members.push(name.clone());
                    }
                }
                if group.include_direct && !members.iter().any(|m| m == "DIRECT") {
                    members.push("DIRECT".to_string());
                }
                if group.include_reject && !members.iter().any(|m| m == "REJECT") {
                    members.push("REJECT".to_string());
                }
            } else {
                members.extend(matched);
            }
            if members.is_empty() {
                members.push("DIRECT".to_string());
            }

            let mut obj = json!({
                "name": group.name,
                "type": kind_str,
                "proxies": members
            });
            if group.kind != GroupKind::Select {
                obj["url"] = json!(group.effective_test_url());
                obj["interval"] = json!(group.effective_interval_secs());
                if group.kind == GroupKind::UrlTest {
                    obj["tolerance"] = json!(50);
                }
            }
            groups.push(obj);
        }

        // Emit rule-providers from Policy.rule_sets.
        let mut providers = Map::new();
        for rs in &policy.rule_sets {
            let Some(url) = rs.mihomo_url.as_deref() else {
                continue;
            };
            let format = if url.ends_with(".mrs") {
                "mrs"
            } else if url.ends_with(".txt") || url.ends_with(".list") {
                "text"
            } else {
                "yaml"
            };
            providers.insert(
                rs.tag.clone(),
                json!({
                    "type": "http",
                    "behavior": rs.behavior.as_mihomo(),
                    "format": format,
                    "url": url,
                    "interval": rs.interval_secs.unwrap_or(DEFAULT_RULESET_INTERVAL_SECS)
                }),
            );
        }

        let mut rules = Vec::new();
        for rule in &policy.rules {
            if names.is_empty() && rule.action == Action::Proxy {
                continue;
            }
            let tgt = target(rule.action, rule.group_id.as_deref(), policy);
            match rule.kind {
                Match::Domain => rules.push(format!("DOMAIN,{},{tgt}", rule.value)),
                Match::DomainSuffix => rules.push(format!("DOMAIN-SUFFIX,{},{tgt}", rule.value)),
                Match::DomainKeyword => rules.push(format!("DOMAIN-KEYWORD,{},{tgt}", rule.value)),
                Match::IpCidr => {
                    let kind = if rule.value.contains(':') {
                        "IP-CIDR6"
                    } else {
                        "IP-CIDR"
                    };
                    rules.push(format!("{kind},{},{tgt},no-resolve", rule.value));
                }
                Match::GeoIp => {
                    let code = if rule.value == "private" {
                        "private".to_string()
                    } else {
                        rule.value.to_ascii_uppercase()
                    };
                    rules.push(format!("GEOIP,{code},{tgt},no-resolve"));
                }
                Match::GeoSite => rules.push(format!("GEOSITE,{},{tgt}", rule.value)),
                Match::Port => {
                    for (start, end) in parse_port_spec(&rule.value)? {
                        if start == end {
                            rules.push(format!("DST-PORT,{start},{tgt}"));
                        } else {
                            rules.push(format!("DST-PORT,{start}-{end},{tgt}"));
                        }
                    }
                }
                Match::Protocol => match rule.value.as_str() {
                    "quic" => rules.push(format!("AND,((NETWORK,UDP),(DST-PORT,443)),{tgt}")),
                    "tcp" => rules.push(format!("NETWORK,TCP,{tgt}")),
                    "udp" => rules.push(format!("NETWORK,UDP,{tgt}")),
                    _ => {}
                },
                Match::ProcessName => rules.push(format!("PROCESS-NAME,{},{tgt}", rule.value)),
                Match::RuleSet => {
                    if providers.contains_key(&rule.value) {
                        rules.push(format!("RULE-SET,{},{tgt}", rule.value));
                    }
                }
            }
        }
        let default = if names.is_empty() && policy.default_action == Action::Proxy {
            "DIRECT".to_string()
        } else {
            target(policy.default_action, policy.default_group_id.as_deref(), policy).to_string()
        };
        rules.push(format!("MATCH,{default}"));

        let mut doc = json!({
            "mixed-port": 1080,
            "allow-lan": false,
            "bind-address": "127.0.0.1",
            "mode": "rule",
            "proxies": proxies,
            "proxy-groups": groups,
            "rules": rules
        });
        if !providers.is_empty() {
            doc["rule-providers"] = Value::Object(providers);
        }
        Ok(doc)
    }
}

fn target<'a>(action: Action, group_id: Option<&str>, policy: &'a Policy) -> &'a str {
    match action {
        Action::Proxy => "group",
        Action::Direct => "DIRECT",
        Action::Block => "REJECT",
        Action::Group => group_id
            .and_then(|id| policy.find_group(id))
            .map(|g| g.name.as_str())
            .unwrap_or("group"),
    }
}
