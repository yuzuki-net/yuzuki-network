use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use yuzuki_core_config::{
    Core, Format,
    cores::{InfoNodePlacement, RenderOptions, universal},
    protocols::{
        ClientFingerprint, Endpoint, ProtocolOptions, ShadowsocksCipher, StreamTransport,
        Transport, VlessFlow, XhttpMode,
    },
    server::{ManagedProtocolConfig, ManagedReality},
    templates,
};
use yuzuki_protocol::v1::Meter;

fn sample_accounts() -> Vec<String> {
    vec![
        "00000000-0000-4000-8000-000000000010".into(),
        "00000000-0000-4000-8000-000000000020".into(),
    ]
}

fn b64url_32(byte: u8) -> String {
    URL_SAFE_NO_PAD.encode([byte; 32])
}

fn base_cfg(protocol: Transport) -> ManagedProtocolConfig {
    ManagedProtocolConfig {
        protocol,
        listen_host: None,
        server_name: None,
        certificate: None,
        key: None,
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
    }
}

#[test]
fn compiles_vless_reality_for_xray_and_sing_box_with_auto_metering() {
    let mut cfg = base_cfg(Transport::Vless);
    cfg.server_name = Some("www.microsoft.com".into());
    cfg.reality = Some(ManagedReality {
        private_key: b64url_32(7),
        public_key: b64url_32(9),
        short_id: "a1b2c3d4".into(),
        fingerprint: ClientFingerprint::Chrome,
        handshake_server: None,
        handshake_port: None,
        spider_x: Some("/".into()),
    });
    cfg.flow = Some(VlessFlow::Vision);

    let meter = Meter::UserStats {
        addr: "127.0.0.1:20001".parse().unwrap(),
    };

    for core in [Core::Xray, Core::SingBox] {
        cfg.validate_for_server(core, "edge.example.net", 443, 443)
            .unwrap();
        let template = cfg.compile_server(core, 443, Some(&meter)).unwrap();
        let expanded = templates::server(&template, &sample_accounts()).unwrap();
        if core == Core::Xray {
            assert_eq!(expanded["api"]["listen"], "127.0.0.1:20001");
            assert_eq!(
                expanded["inbounds"][0]["settings"]["clients"]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
            assert_eq!(
                expanded["inbounds"][0]["streamSettings"]["security"],
                "reality"
            );
        } else {
            assert_eq!(
                expanded["experimental"]["v2ray_api"]["listen"],
                "127.0.0.1:20001"
            );
            assert_eq!(
                expanded["experimental"]["v2ray_api"]["stats"]["users"]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
            assert_eq!(
                expanded["inbounds"][0]["users"].as_array().unwrap().len(),
                2
            );
            assert_eq!(expanded["inbounds"][0]["tls"]["reality"]["enabled"], true);
        }
    }

    let endpoint = cfg.to_portable_endpoint("edge.example.net", 443).unwrap();
    assert!(endpoint.supports(Core::Xray));
    assert!(endpoint.supports(Core::SingBox));
    assert!(endpoint.supports(Core::Mihomo));
}

#[test]
fn compiles_hysteria2_and_ss2022_across_all_three_cores() {
    let mut h2 = base_cfg(Transport::Hysteria2);
    h2.listen_host = Some("0.0.0.0".into());
    h2.server_name = Some("h2.example.net".into());
    h2.certificate = Some("/etc/yuzuki/server.crt".into());
    h2.key = Some("/etc/yuzuki/server.key".into());
    h2.options = Some(ProtocolOptions::Hysteria2 {
        obfs_password: Some("salamander-secret".into()),
        up_mbps: Some(100),
        down_mbps: Some(500),
        ports: Some("20000-30000".into()),
        pin_sha256: None,
        ignore_client_bandwidth: false,
    });

    for core in Core::ALL {
        h2.validate_for_server(core, "h2.example.net", 443, 8443)
            .unwrap();
        let template = h2.compile_server(core, 8443, None).unwrap();
        let expanded = templates::server(&template, &sample_accounts()).unwrap();
        assert!(expanded.is_object());
    }

    for (cipher, key_len) in [
        (ShadowsocksCipher::Aes128, 16),
        (ShadowsocksCipher::ChaCha20, 32),
    ] {
        let mut ss2022 = base_cfg(Transport::Shadowsocks2022);
        ss2022.options = Some(ProtocolOptions::Shadowsocks2022 {
            cipher,
            server_key: STANDARD.encode(vec![42u8; key_len]),
        });

        for core in Core::ALL {
            ss2022
                .validate_for_server(core, "203.0.113.5", 8388, 8388)
                .unwrap();
            let template = ss2022.compile_server(core, 8388, None).unwrap();
            let expanded = templates::server(&template, &sample_accounts()).unwrap();
            assert!(expanded.is_object());
        }
    }
}

#[test]
fn compiles_xhttp_reality_wireguard_and_universal_uris() {
    let account = "00000000-0000-4000-8000-000000000010";

    // VLESS + REALITY + XHTTP (vasma style)
    let mut xhttp = base_cfg(Transport::Vless);
    xhttp.server_name = Some("www.microsoft.com".into());
    xhttp.network = Some(StreamTransport::Xhttp {
        path: "/xhttp".into(),
        host: Some("cdn.example.net".into()),
        mode: Some(XhttpMode::PacketUp),
    });
    xhttp.reality = Some(ManagedReality {
        private_key: b64url_32(11),
        public_key: b64url_32(22),
        short_id: "cafe".into(),
        fingerprint: ClientFingerprint::Ios,
        handshake_server: None,
        handshake_port: None,
        spider_x: Some("/index".into()),
    });
    xhttp
        .validate_for_server(Core::Xray, "edge.example.net", 443, 443)
        .unwrap();
    assert!(
        xhttp
            .validate_for_server(Core::SingBox, "edge.example.net", 443, 443)
            .is_err()
    );
    let srv = xhttp.compile_server(Core::Xray, 443, None).unwrap();
    assert_eq!(srv["inbounds"][0]["streamSettings"]["network"], "xhttp");
    assert_eq!(
        srv["inbounds"][0]["streamSettings"]["xhttpSettings"]["mode"],
        "packet-up"
    );

    let xhttp_ep = Endpoint {
        portable: Some(xhttp.to_portable_endpoint("edge.example.net", 443).unwrap()),
        native: Default::default(),
    };
    assert_eq!(xhttp_ep.compatible_formats(), [true, false, false, true]);
    let xhttp_uri = xhttp_ep.resolve_uri("Tokyo XHTTP", account).unwrap().unwrap();
    assert!(xhttp_uri.starts_with("vless://"));
    assert!(xhttp_uri.contains("type=xhttp"));
    assert!(xhttp_uri.contains("mode=packet-up"));
    assert!(xhttp_uri.contains("security=reality"));

    // External Hysteria2 with static password + port hopping + allow_insecure
    let mut ext_h2 = base_cfg(Transport::Hysteria2);
    ext_h2.server_name = Some("jp.example.net".into());
    ext_h2.allow_insecure = true;
    ext_h2.credential = Some("external-static-pass".into());
    ext_h2.options = Some(ProtocolOptions::Hysteria2 {
        obfs_password: Some("obfs-pw".into()),
        up_mbps: Some(50),
        down_mbps: Some(300),
        ports: Some("20000-30000".into()),
        pin_sha256: None,
        ignore_client_bandwidth: false,
    });
    let h2_ep = Endpoint {
        portable: Some(ext_h2.to_portable_endpoint("jp.example.net", 27876).unwrap()),
        native: Default::default(),
    };
    assert_eq!(h2_ep.compatible_formats(), [true, true, true, true]);
    let h2_uri = h2_ep.resolve_uri("Tokyo Vultr", account).unwrap().unwrap();
    assert!(h2_uri.starts_with("hysteria2://external-static-pass@jp.example.net:27876/"));
    assert!(h2_uri.contains("insecure=1"));
    assert!(h2_uri.contains("mport=20000-30000"));
    assert!(h2_uri.contains("obfs=salamander"));

    // WireGuard across all 3 cores + Universal URI
    let mut wg = base_cfg(Transport::WireGuard);
    wg.options = Some(ProtocolOptions::WireGuard {
        private_key: "priv-key".into(),
        peer_public_key: "pub-key".into(),
        preshared_key: None,
        local_address: vec!["10.0.0.2/32".into()],
        reserved: Some([1, 2, 3]),
        mtu: Some(1280),
    });
    let wg_ep = Endpoint {
        portable: Some(wg.to_portable_endpoint("wg.example.net", 51820).unwrap()),
        native: Default::default(),
    };
    assert_eq!(wg_ep.compatible_formats(), [true, true, true, true]);
    assert_eq!(
        wg_ep.resolve(Core::SingBox, "WG", account).unwrap().unwrap().section,
        yuzuki_core_config::protocols::Section::Endpoint
    );
    let wg_uri = wg_ep.resolve_uri("WG", account).unwrap().unwrap();
    assert!(wg_uri.starts_with("wireguard://priv-key@wg.example.net:51820/"));

    // Universal Base64 subscription rendering with info nodes
    assert_eq!(Format::from_code("3"), Some(Format::Universal));
    assert_eq!(Format::Universal.core(), None);
    let b64 = universal::render_subscription(
        &[xhttp_uri, h2_uri, wg_uri],
        &RenderOptions {
            info_nodes: vec!["📊 剩余流量：100 GB".into()],
            info_group_name: String::new(),
            placement: InfoNodePlacement::PrependToGroup,
        },
    );
    let decoded = String::from_utf8(STANDARD.decode(b64).unwrap()).unwrap();
    let lines: Vec<&str> = decoded.lines().collect();
    assert_eq!(lines.len(), 4);
    assert!(lines[0].starts_with("socks://127.0.0.1:1#"));
    assert!(lines[1].starts_with("vless://"));
    assert!(lines[2].starts_with("hysteria2://"));
    assert!(lines[3].starts_with("wireguard://"));
}

#[test]
fn compiles_ws_grpc_and_tuic_configs() {
    let mut vless_ws = base_cfg(Transport::Vless);
    vless_ws.server_name = Some("ws.example.net".into());
    vless_ws.certificate = Some("/etc/yuzuki/server.crt".into());
    vless_ws.key = Some("/etc/yuzuki/server.key".into());
    vless_ws.network = Some(StreamTransport::WebSocket {
        path: "/edge".into(),
        host: Some("cdn.example.net".into()),
        max_early_data: Some(2048),
        early_data_header_name: Some("Sec-WebSocket-Protocol".into()),
    });
    for core in Core::ALL {
        vless_ws
            .validate_for_server(core, "cdn.example.net", 443, 8443)
            .unwrap();
        let template = vless_ws.compile_server(core, 8443, None).unwrap();
        let expanded = templates::server(&template, &sample_accounts()).unwrap();
        assert!(expanded.is_object());
    }

    let mut tuic = base_cfg(Transport::Tuic);
    tuic.server_name = Some("tuic.example.net".into());
    tuic.certificate = Some("/etc/yuzuki/server.crt".into());
    tuic.key = Some("/etc/yuzuki/server.key".into());
    tuic.options = Some(ProtocolOptions::Tuic {
        congestion_control: Some("cubic".into()),
        udp_relay_mode: Some("quic".into()),
        zero_rtt_handshake: true,
        heartbeat: Some("10s".into()),
    });
    for core in [Core::SingBox, Core::Mihomo] {
        tuic.validate_for_server(core, "tuic.example.net", 443, 443)
            .unwrap();
        let template = tuic.compile_server(core, 443, None).unwrap();
        let expanded = templates::server(&template, &sample_accounts()).unwrap();
        assert!(expanded.is_object());
    }
    assert!(
        tuic.validate_for_server(Core::Xray, "tuic.example.net", 443, 443)
            .is_err()
    );
}
