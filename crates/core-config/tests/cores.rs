use serde_json::{Value, json};
use yuzuki_core_config::{
    Core, Format,
    cores::Registry,
    protocols::{Endpoint, PortableEndpoint, Transport},
    routing::Policy,
};

fn portable(protocol: &str, fields: Value) -> Endpoint {
    let mut endpoint = json!({"host":"example.net", "port":443, "protocol":protocol,
        "server_name":"example.net"});
    endpoint
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    serde_json::from_value(json!({"portable":endpoint})).unwrap()
}

#[test]
fn target_availability_matches_resolved_entries_and_native_overrides() {
    let account = "9ff9e02e-fd42-473f-817c-f7aed9e03b6f";
    let mut tuic = portable("tuic", json!({}));
    tuic.validate().unwrap();
    assert_eq!(tuic.compatible_formats(), [false, true, true, true]);
    assert!(tuic.resolve(Core::Xray, "edge", account).unwrap().is_none());
    assert_eq!(
        tuic.resolve(Core::Mihomo, "edge", account)
            .unwrap()
            .unwrap()
            .config["uuid"],
        account
    );
    let added: Endpoint = serde_json::from_value(json!({"native":{"xray":{
        "section":"outbound", "config":{"protocol":"socks", "settings":{"servers":[{"address":"example.net","port":1080}]}}
    }}})).unwrap();
    tuic.native = added.native;
    assert_eq!(tuic.compatible_formats(), [true, true, true, true]);
    assert_eq!(
        tuic.resolve(Core::Xray, "edge", account)
            .unwrap()
            .unwrap()
            .config["protocol"],
        "socks"
    );

    let plain = portable("hysteria2", json!({}));
    assert_eq!(plain.compatible_formats(), [true; 4]);
    assert_eq!(
        plain
            .resolve(Core::Xray, "edge", account)
            .unwrap()
            .unwrap()
            .config["streamSettings"]["hysteriaSettings"]["auth"],
        account
    );
    assert!(
        portable("hysteria2", json!({"server_name":null}))
            .validate()
            .is_err()
    );
    assert!(
        portable("hysteria2", json!({"network":{"kind":"ws","path":"/"}}))
            .validate()
            .is_err()
    );
}

#[test]
fn each_target_renders_endpoints_from_all_three_sources() {
    let endpoints = Core::ALL.map(|source| {
        (
            source,
            Endpoint {
                native: Default::default(),
                portable: Some(PortableEndpoint {
                    protocol: Transport::Vless,
                    host: format!("{source}.example.net"),
                    port: 443,
                    server_name: Some(format!("{source}.example.net")),
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
            },
        )
    });
    let registry = Registry::builtins();
    for code in ["0", "1", "2"] {
        let target = Format::from_code(code).unwrap().core().unwrap();
        let resolved: Vec<_> = endpoints
            .iter()
            .map(|(source, endpoint)| {
                endpoint
                    .resolve(target, source.id(), "9ff9e02e-fd42-473f-817c-f7aed9e03b6f")
                    .unwrap()
                    .unwrap()
            })
            .collect();
        let result = registry
            .render(target, &resolved, &Policy::default())
            .unwrap()
            .to_string();
        for source in Core::ALL {
            assert!(result.contains(&format!("{source}.example.net")));
        }
    }
    assert!(Format::from_code("xray").is_none());
}

#[test]
fn info_nodes_render_visibly_at_top_across_all_three_cores() {
    use yuzuki_core_config::cores::{InfoNodePlacement, RenderOptions};

    let endpoint = Endpoint {
        native: Default::default(),
        portable: Some(PortableEndpoint {
            protocol: Transport::Vless,
            host: "tokyo.example.net".into(),
            port: 443,
            server_name: Some("tokyo.example.net".into()),
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
    };
    let registry = Registry::builtins();
    let options = RenderOptions {
        info_nodes: vec![
            "📊 剩余流量：80 GB / 100 GB".into(),
            "📅 到期时间：2026-12-31".into(),
        ],
        info_group_name: "📊 套餐信息".into(),
        placement: InfoNodePlacement::PrependToGroup,
    };

    // Xray: info nodes sit visibly at the top of proxy outbounds as SOCKS5 placeholders
    let xray_ep = endpoint
        .resolve(Core::Xray, "Tokyo 01", "9ff9e02e-fd42-473f-817c-f7aed9e03b6f")
        .unwrap()
        .unwrap();
    let xray = registry
        .render_with_options(Core::Xray, &[xray_ep], &Policy::default(), &options)
        .unwrap();
    let xray_outbounds = xray["outbounds"].as_array().unwrap();
    assert_eq!(xray_outbounds[2]["tag"], "📊 剩余流量：80 GB / 100 GB");
    assert_eq!(xray_outbounds[2]["protocol"], "socks");
    assert_eq!(xray_outbounds[4]["tag"], "Tokyo 01");

    // Mihomo default (PrependToGroup): info nodes sit at top of proxies and main group
    let mihomo_ep = endpoint
        .resolve(Core::Mihomo, "Tokyo 01", "9ff9e02e-fd42-473f-817c-f7aed9e03b6f")
        .unwrap()
        .unwrap();
    let mihomo = registry
        .render_with_options(Core::Mihomo, &[mihomo_ep.clone()], &Policy::default(), &options)
        .unwrap();
    assert_eq!(mihomo["proxies"][0]["name"], "📊 剩余流量：80 GB / 100 GB");
    assert_eq!(mihomo["proxy-groups"][0]["name"], "group");
    assert_eq!(
        mihomo["proxy-groups"][0]["proxies"],
        json!(["📊 剩余流量：80 GB / 100 GB", "📅 到期时间：2026-12-31", "Tokyo 01"])
    );

    // sing-box default (PrependToGroup): info nodes sit at top of outbounds and main selector
    let sb_ep = endpoint
        .resolve(Core::SingBox, "Tokyo 01", "9ff9e02e-fd42-473f-817c-f7aed9e03b6f")
        .unwrap()
        .unwrap();
    let sb = registry
        .render_with_options(Core::SingBox, &[sb_ep], &Policy::default(), &options)
        .unwrap();
    let sb_group = sb["outbounds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["tag"] == "group")
        .unwrap();
    assert_eq!(
        sb_group["outbounds"],
        json!(["📊 剩余流量：80 GB / 100 GB", "📅 到期时间：2026-12-31", "Tokyo 01"])
    );

    // DedicatedGroup option still works when explicitly chosen
    let dedicated = RenderOptions {
        placement: InfoNodePlacement::DedicatedGroup,
        ..options
    };
    let mihomo_ded = registry
        .render_with_options(Core::Mihomo, &[mihomo_ep], &Policy::default(), &dedicated)
        .unwrap();
    assert_eq!(mihomo_ded["proxy-groups"][0]["name"], "📊 套餐信息");
    assert_eq!(mihomo_ded["proxy-groups"][1]["proxies"], json!(["Tokyo 01"]));
}

#[test]
fn real_cores_parse_all_portable_protocols() {
    use std::{env, fs, process::Command};
    use yuzuki_core_config::routing::{Action, Match, Rule};

    let targets = [
        (Core::Xray, "YUZUKI_XRAY"),
        (Core::SingBox, "YUZUKI_SING_BOX"),
        (Core::Mihomo, "YUZUKI_MIHOMO"),
    ];
    let account = "9ff9e02e-fd42-473f-817c-f7aed9e03b6f";
    let registry = Registry::builtins();
    let mut policy = Policy {
        rules: vec![
            Rule {
                kind: Match::Domain,
                value: "blocked.example.net".into(),
                action: Action::Block,
                group_id: None,
            },
            Rule {
                kind: Match::DomainSuffix,
                value: "direct.example.net".into(),
                action: Action::Direct,
                group_id: None,
            },
            Rule {
                kind: Match::IpCidr,
                value: "2001:db8::/32".into(),
                action: Action::Proxy,
                group_id: None,
            },
        ],
        ..Policy::default()
    };
    policy.normalize().unwrap();

    for (core, executable) in targets {
        let Some(executable) = env::var_os(executable) else {
            continue;
        };
        let endpoints = [
            Transport::Vless,
            Transport::Vmess,
            Transport::Trojan,
            Transport::Shadowsocks,
            Transport::Socks5,
            Transport::Http,
        ];
        let mut entries: Vec<_> = endpoints
            .into_iter()
            .enumerate()
            .map(|(index, protocol)| {
                let tls = !matches!(protocol, Transport::Shadowsocks | Transport::Socks5);
                let endpoint = Endpoint {
                    native: Default::default(),
                    portable: Some(PortableEndpoint {
                        protocol,
                        host: "example.net".into(),
                        port: 443,
                        server_name: tls.then(|| "example.net".into()),
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
                };
                endpoint
                    .resolve(core, &format!("test-{index}"), account)
                    .unwrap()
                    .unwrap()
            })
            .collect();
        let additional = [
            portable("hysteria2", json!({})),
            portable(
                "hysteria2",
                json!({"options":{"kind":"hysteria2","obfs_password":"example-password"}}),
            ),
            portable(
                "hysteria",
                json!({"options":{"kind":"hysteria","up_mbps":50,"down_mbps":100}}),
            ),
            portable("tuic", json!({})),
            portable("anytls", json!({})),
            portable("naive", json!({})),
            portable(
                "shadowsocks2022",
                json!({"server_name":null,"options":{
                "kind":"shadowsocks2022","cipher":"2022-blake3-aes-128-gcm","server_key":"MDEyMzQ1Njc4OWFiY2RlZg=="}}),
            ),
            portable(
                "shadowsocks2022",
                json!({"server_name":null,"options":{
                "kind":"shadowsocks2022","cipher":"2022-blake3-aes-256-gcm","server_key":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}}),
            ),
            portable(
                "vless",
                json!({"network":{"kind":"ws","path":"/connect","host":"example.net"}}),
            ),
            portable(
                "trojan",
                json!({"network":{"kind":"grpc","service_name":"tunnel"}}),
            ),
            portable(
                "vmess",
                json!({"network":{"kind":"http_upgrade","path":"/connect","host":"example.net"}}),
            ),
            portable(
                "vless",
                json!({"flow":"xtls-rprx-vision","reality":{
                "public_key":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY","short_id":"ab12"}}),
            ),
        ];
        for (index, endpoint) in additional.iter().enumerate() {
            endpoint.validate().unwrap();
            if let Some(entry) = endpoint
                .resolve(core, &format!("advanced-{index}"), account)
                .unwrap()
            {
                entries.push(entry);
            }
        }
        let value = registry.render(core, &entries, &policy).unwrap();

        let root = env::temp_dir().join(format!("yuzuki-check-{}-{core}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let path = root.join("test.json");
        fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();

        let mut command = Command::new(executable);
        match core {
            Core::Xray => {
                command.args(["run", "-test", "-config"]).arg(&path);
            }
            Core::SingBox => {
                command.args(["check", "-c"]).arg(&path);
            }
            Core::Mihomo => {
                command.arg("-t").arg("-d").arg(&root).arg("-f").arg(&path);
            }
        }
        let result = command.output();
        fs::remove_dir_all(&root).unwrap();
        let result = result.unwrap();
        assert!(
            result.status.success(),
            "{core} config check failed:\n{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
