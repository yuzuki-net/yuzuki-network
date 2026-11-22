use anyhow::Result;
use serde_json::{Value, json};

use crate::{
    Core,
    cores::{InfoNodePlacement, RenderOptions},
    protocols::NativeEndpoint,
    routing::{Action, GroupKind, Match, Policy, ports::RoutingCompiler},
};

pub(super) struct Xray;

impl RoutingCompiler for Xray {
    fn core(&self) -> Core {
        Core::Xray
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
        let mut outbounds = vec![
            json!({"tag":"direct","protocol":"freedom"}),
            json!({"tag":"block","protocol":"blackhole"}),
        ];
        let endpoint_tags: Vec<String> = endpoints
            .iter()
            .filter_map(|entry| entry.config.get("tag").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        // Use standard SOCKS5 127.0.0.1:1 placeholder outbounds so Xray GUI clients
        // always render info nodes visibly instead of hiding system blackhole outbounds.
        let info_outbounds: Vec<Value> = options
            .unique_info_labels(endpoint_tags.iter().cloned())
            .into_iter()
            .map(|label| {
                json!({
                    "tag": label,
                    "protocol": "socks",
                    "settings": {"servers": [{"address": "127.0.0.1", "port": 1}]}
                })
            })
            .collect();

        if options.placement == InfoNodePlacement::AppendToGroup {
            outbounds.extend(endpoints.iter().map(|entry| entry.config.clone()));
            outbounds.extend(info_outbounds);
        } else {
            outbounds.extend(info_outbounds);
            outbounds.extend(endpoints.iter().map(|entry| entry.config.clone()));
        }

        let mut balancers = Vec::new();
        let mut needs_observatory = false;
        let mut probe_url = None;
        let mut probe_interval = None;
        if !endpoint_tags.is_empty() {
            balancers.push(json!({
                "tag": "group",
                "selector": endpoint_tags,
                "strategy": {"type": "random"}
            }));
            for group in &policy.groups {
                let mut matched: Vec<&String> = endpoint_tags
                    .iter()
                    .filter(|tag| group.matches_node(tag))
                    .collect();
                if matched.is_empty() {
                    matched = endpoint_tags.iter().collect();
                }
                let strategy = match group.kind {
                    GroupKind::UrlTest | GroupKind::Fallback => {
                        needs_observatory = true;
                        probe_url.get_or_insert_with(|| group.effective_test_url().to_string());
                        probe_interval.get_or_insert(group.effective_interval_secs());
                        json!({"type": "leastPing"})
                    }
                    GroupKind::Select | GroupKind::LoadBalance => json!({"type": "random"}),
                };
                balancers.push(json!({
                    "tag": format!("group-{}", group.id),
                    "selector": matched,
                    "strategy": strategy
                }));
            }
        }

        let mut rules = Vec::new();
        for rule in &policy.rules {
            let mut config = route(rule.action, rule.group_id.as_deref());
            match rule.kind {
                Match::Domain => config["domain"] = json!([format!("full:{}", rule.value)]),
                Match::DomainSuffix => config["domain"] = json!([format!("domain:{}", rule.value)]),
                Match::DomainKeyword => config["domain"] = json!([rule.value]),
                Match::IpCidr => config["ip"] = json!([rule.value]),
                Match::GeoIp => config["ip"] = json!([format!("geoip:{}", rule.value)]),
                Match::GeoSite => config["domain"] = json!([format!("geosite:{}", rule.value)]),
                Match::Port => config["port"] = json!(rule.value),
                Match::Protocol => config["protocol"] = json!([rule.value]),
                Match::ProcessName | Match::RuleSet => continue,
            }
            rules.push(config);
        }
        let mut fallback = route(policy.default_action, policy.default_group_id.as_deref());
        fallback["network"] = json!("tcp,udp");
        rules.push(fallback);
        // Without nodes a native routing overlay can still declare a usable direct/block configuration.
        if endpoints.is_empty() && policy.requires_proxy() {
            rules.retain(|rule| rule.get("balancerTag").is_none());
        }

        let domain_strategy = if policy
            .rules
            .iter()
            .any(|r| matches!(r.kind, Match::GeoIp | Match::IpCidr))
        {
            "IPIfNonMatch"
        } else {
            "AsIs"
        };

        let mut doc = json!({
            "inbounds": [{"tag":"local","listen":"127.0.0.1","port":1080,"protocol":"socks","settings":{"udp":true}}],
            "outbounds": outbounds,
            "routing": {
                "domainStrategy": domain_strategy,
                "rules": rules,
                "balancers": balancers
            }
        });
        if needs_observatory && !endpoint_tags.is_empty() {
            doc["observatory"] = json!({
                "subjectSelector": endpoint_tags,
                "probeURL": probe_url.unwrap_or_else(|| crate::routing::DEFAULT_TEST_URL.to_string()),
                "probeInterval": format!("{}s", probe_interval.unwrap_or(crate::routing::DEFAULT_GROUP_INTERVAL_SECS))
            });
        }
        Ok(doc)
    }
}

fn route(action: Action, group_id: Option<&str>) -> Value {
    match action {
        Action::Proxy => json!({"type":"field","balancerTag":"group"}),
        Action::Direct => json!({"type":"field","outboundTag":"direct"}),
        Action::Block => json!({"type":"field","outboundTag":"block"}),
        Action::Group => {
            let tag = group_id
                .map(|id| format!("group-{id}"))
                .unwrap_or_else(|| "group".to_string());
            json!({"type":"field","balancerTag":tag})
        }
    }
}
