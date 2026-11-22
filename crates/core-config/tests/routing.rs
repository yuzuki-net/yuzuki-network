use serde_json::json;
use yuzuki_core_config::{
    Core,
    cores::Registry,
    protocols::{Endpoint, PortableEndpoint, Transport},
    routing::{Action, Decision, GroupKind, Match, Policy, RouteGroup, Rule, RuleSet, RuleSetBehavior},
};

fn rule(kind: Match, value: &str, action: Action) -> Rule {
    Rule {
        kind,
        value: value.into(),
        action,
        group_id: None,
    }
}

#[test]
fn geo_rules_round_trip_with_panel_json_names() {
    let input = json!([
        {"kind": "geoip", "value": "private", "action": "direct"},
        {"kind": "geosite", "value": "category-ads-all", "action": "block"}
    ]);
    let rules: Vec<Rule> = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(rules[0].kind, Match::GeoIp);
    assert_eq!(rules[1].kind, Match::GeoSite);
    assert_eq!(serde_json::to_value(rules).unwrap(), input);
}

#[test]
fn preview_matches_first_rule_and_uses_domain_boundaries() {
    let mut policy = Policy {
        default_action: Action::Proxy,
        rules: vec![
            rule(Match::Domain, "admin.Example.net", Action::Block),
            rule(Match::DomainSuffix, "example.net", Action::Direct),
            rule(Match::DomainKeyword, "openai", Action::Proxy),
            rule(Match::IpCidr, "192.0.2.14/24", Action::Block),
            rule(Match::IpCidr, "2001:db8::/32", Action::Direct),
            rule(Match::GeoIp, "private", Action::Direct),
            rule(Match::Port, "80,8000-8080", Action::Block),
        ],
        ..Policy::default()
    };
    policy.normalize().unwrap();
    for (destination, port, action, rule_index) in [
        ("Admin.EXAMPLE.net.", None, Action::Block, Some(0)),
        ("www.example.net", None, Action::Direct, Some(1)),
        ("example.net", None, Action::Direct, Some(1)),
        ("chat.openai.com", None, Action::Proxy, Some(2)),
        ("testexample.net", None, Action::Proxy, None),
        ("192.0.2.100", None, Action::Block, Some(3)),
        ("192.0.3.100", None, Action::Proxy, None),
        ("2001:db8::8", None, Action::Direct, Some(4)),
        ("10.20.30.40", None, Action::Direct, Some(5)),
        ("1.1.1.1", Some(8080), Action::Block, Some(6)),
    ] {
        let decision = policy.evaluate_with_port(destination, port).unwrap();
        assert_eq!(decision.action, action, "{destination}");
        assert_eq!(decision.rule_index, rule_index, "{destination}");
    }
    for destination in [
        "",
        "https://example.net/a",
        "example.net..",
        "[2001:db8::8]:443",
    ] {
        assert!(policy.evaluate(destination).is_err(), "{destination}");
    }
}

#[test]
fn policy_allows_more_than_256_rules_without_artificial_cap() {
    let rules = (0..600)
        .map(|i| {
            rule(
                Match::DomainSuffix,
                &format!("svc-{i}.example.net"),
                if i % 2 == 0 {
                    Action::Direct
                } else {
                    Action::Proxy
                },
            )
        })
        .collect();
    let mut policy = Policy {
        default_action: Action::Proxy,
        rules,
        ..Policy::default()
    };
    policy.normalize().unwrap();
    assert_eq!(policy.rules.len(), 600);
    assert_eq!(
        policy.evaluate("api.svc-500.example.net").unwrap(),
        Decision {
            action: Action::Direct,
            rule_index: Some(500),
            group_id: None,
            group_name: None,
            skipped_dynamic_rules: vec![],
        }
    );
}

#[test]
fn compiles_geoip_geosite_rule_sets_and_policy_groups_across_all_three_cores() {
    let mut policy = Policy {
        default_action: Action::Proxy,
        groups: vec![
            RouteGroup {
                id: "auto".into(),
                name: "Auto Select".into(),
                kind: GroupKind::UrlTest,
                node_filter: None,
                include_direct: false,
                include_reject: false,
                include_auto: false,
                test_url: None,
                interval_secs: Some(300),
            },
            RouteGroup {
                id: "ai".into(),
                name: "AI Services".into(),
                kind: GroupKind::Select,
                node_filter: Some("US|JP".into()),
                include_direct: true,
                include_reject: false,
                include_auto: true,
                test_url: None,
                interval_secs: None,
            },
        ],
        rule_sets: vec![RuleSet {
            tag: "custom-ads".into(),
            sing_box_url: Some("https://example.net/ads.srs".into()),
            mihomo_url: Some("https://example.net/ads.yaml".into()),
            behavior: RuleSetBehavior::Domain,
            interval_secs: Some(3600),
        }],
        rules: vec![
            rule(Match::RuleSet, "custom-ads", Action::Block),
            Rule {
                kind: Match::GeoSite,
                value: "openai".into(),
                action: Action::Group,
                group_id: Some("ai".into()),
            },
            rule(Match::GeoIp, "private", Action::Direct),
            rule(Match::GeoSite, "cn", Action::Direct),
            rule(Match::GeoIp, "cn", Action::Direct),
            rule(Match::Port, "443,8000-8080", Action::Proxy),
            rule(Match::ProcessName, "qbittorrent", Action::Direct),
        ],
        ..Policy::default()
    };
    policy.normalize().unwrap();

    let make_ep = |host: &str| Endpoint {
        portable: Some(PortableEndpoint {
            protocol: Transport::Trojan,
            host: host.into(),
            port: 443,
            server_name: Some(host.into()),
            method: None,
            network: None,
            reality: None,
            flow: None,
            alpn: None,
            fingerprint: None,
            allow_insecure: false,
            credential: None,
            username: None,
            options: None,
        }),
        native: Default::default(),
    };
    let nodes = [
        ("US Los Angeles 01", make_ep("us1.example.net")),
        ("HK Hong Kong 01", make_ep("hk1.example.net")),
    ];
    let registry = Registry::builtins();
    let uid = "11111111-1111-4111-8111-111111111111";

    // 1. Mihomo: proxy-groups + rule-providers + GEOIP/GEOSITE/RULE-SET/DST-PORT/PROCESS-NAME
    let mihomo_eps: Vec<_> = nodes
        .iter()
        .map(|(tag, ep)| ep.resolve(Core::Mihomo, tag, uid).unwrap().unwrap())
        .collect();
    let mihomo = registry.render(Core::Mihomo, &mihomo_eps, &policy).unwrap();
    let groups = mihomo["proxy-groups"].as_array().unwrap();
    assert!(groups.iter().any(|g| g["name"] == "Auto Select" && g["type"] == "url-test"));
    let ai_group = groups.iter().find(|g| g["name"] == "AI Services").unwrap();
    assert_eq!(
        ai_group["proxies"],
        json!(["Auto Select", "US Los Angeles 01", "DIRECT"])
    );
    assert_eq!(mihomo["rule-providers"]["custom-ads"]["behavior"], "domain");
    let mihomo_rules: Vec<&str> = mihomo["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(mihomo_rules.contains(&"RULE-SET,custom-ads,REJECT"));
    assert!(mihomo_rules.contains(&"GEOSITE,openai,AI Services"));
    assert!(mihomo_rules.contains(&"GEOIP,private,DIRECT,no-resolve"));
    assert!(mihomo_rules.contains(&"GEOSITE,cn,DIRECT"));
    assert!(mihomo_rules.contains(&"GEOIP,CN,DIRECT,no-resolve"));
    assert!(mihomo_rules.contains(&"DST-PORT,443,group"));
    assert!(mihomo_rules.contains(&"DST-PORT,8000-8080,group"));
    assert!(mihomo_rules.contains(&"PROCESS-NAME,qbittorrent,DIRECT"));

    // 2. sing-box 1.12+: auto-injected remote SRS rule_set + selector/urltest outbounds
    let sb_eps: Vec<_> = nodes
        .iter()
        .map(|(tag, ep)| ep.resolve(Core::SingBox, tag, uid).unwrap().unwrap())
        .collect();
    let sb = registry.render(Core::SingBox, &sb_eps, &policy).unwrap();
    let sb_outs = sb["outbounds"].as_array().unwrap();
    assert!(sb_outs.iter().any(|o| o["tag"] == "Auto Select" && o["type"] == "urltest"));
    let sb_ai = sb_outs.iter().find(|o| o["tag"] == "AI Services").unwrap();
    assert_eq!(sb_ai["outbounds"], json!(["Auto Select", "US Los Angeles 01", "direct"]));
    let sb_rs = sb["route"]["rule_set"].as_array().unwrap();
    assert!(sb_rs.iter().any(|r| r["tag"] == "custom-ads" && r["format"] == "binary"));
    assert!(sb_rs.iter().any(|r| r["tag"] == "geosite-openai"));
    assert!(sb_rs.iter().any(|r| r["tag"] == "geosite-cn"));
    assert!(sb_rs.iter().any(|r| r["tag"] == "geoip-cn"));
    let sb_rules = sb["route"]["rules"].as_array().unwrap();
    assert!(sb_rules.iter().any(|r| r["ip_is_private"] == true && r["outbound"] == "direct"));
    assert!(sb_rules.iter().any(|r| r["rule_set"] == json!(["geosite-openai"]) && r["outbound"] == "AI Services"));
    assert!(sb_rules.iter().any(|r| r["port"] == json!([443]) && r["port_range"] == json!(["8000:8080"])));

    // 3. xray-core: balancers + observatory + IPIfNonMatch + geoip:/geosite:
    let xr_eps: Vec<_> = nodes
        .iter()
        .map(|(tag, ep)| ep.resolve(Core::Xray, tag, uid).unwrap().unwrap())
        .collect();
    let xr = registry.render(Core::Xray, &xr_eps, &policy).unwrap();
    assert_eq!(xr["routing"]["domainStrategy"], "IPIfNonMatch");
    assert!(xr["observatory"].is_object());
    let xr_balancers = xr["routing"]["balancers"].as_array().unwrap();
    assert!(xr_balancers.iter().any(|b| b["tag"] == "group-ai" && b["selector"] == json!(["US Los Angeles 01"])));
    let xr_rules = xr["routing"]["rules"].as_array().unwrap();
    assert!(xr_rules.iter().any(|r| r["domain"] == json!(["geosite:openai"]) && r["balancerTag"] == "group-ai"));
    assert!(xr_rules.iter().any(|r| r["ip"] == json!(["geoip:cn"]) && r["outboundTag"] == "direct"));
}
