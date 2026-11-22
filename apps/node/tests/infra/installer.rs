use std::{
    fs,
    io::Write,
    sync::{Arc, Mutex},
};

use flate2::{Compression, write::DeflateEncoder, write::GzEncoder};
use node::infra::{
    config::{CoreManagementSettings, Settings},
    filesystem, installer,
};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{CoreActionStage, CoreSource},
};

#[test]
fn settings_load_without_binaries_section() {
    let dir = std::env::temp_dir().join(format!("yuzuki-node-cfg-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let ca_path = dir.join("ca.crt");
    fs::write(&ca_path, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n").unwrap();
    let cfg_path = dir.join("node.toml");
    fs::write(
        &cfg_path,
        format!(
            "board_url = \"https://control.example.net:3443\"\nca_certificate = \"{}\"\nstate_dir = \"{}\"\n",
            ca_path.display(),
            dir.join("state").display()
        ),
    )
    .unwrap();

    let settings = Settings::load(&cfg_path).unwrap();
    assert!(settings.binaries.is_empty());
    assert!(settings.core_management.enabled);
    assert!(settings.core_management.detect_system_binaries);
    assert!(!settings.core_management.allow_http_downloads);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn builds_official_download_urls_and_rejects_bad_versions() {
    assert_eq!(
        installer::default_download_url(Core::Xray, "v26.11.9", "linux", "amd64", None).unwrap(),
        "https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip"
    );
    assert_eq!(
        installer::default_download_url(Core::SingBox, "1.14.4", "linux", "arm64", None).unwrap(),
        "https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-arm64.tar.gz"
    );
    assert_eq!(
        installer::default_download_url(
            Core::Mihomo,
            "1.19.34",
            "linux",
            "amd64",
            Some("https://mirror.example.net/")
        )
        .unwrap(),
        "https://mirror.example.net/https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/mihomo-linux-amd64-compatible-v1.19.34.gz"
    );
    assert!(installer::default_download_url(Core::Xray, "../bad", "linux", "amd64", None).is_err());
}

#[test]
fn extracts_gzip_tar_gz_and_zip_packages() {
    // 1. Single-file gzip (mihomo style)
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(b"#!/bin/sh\necho mihomo\n").unwrap();
    let gz_bytes = gz.finish().unwrap();
    let extracted = installer::extract_package(Core::Mihomo, &gz_bytes).unwrap();
    assert_eq!(extracted.binary, b"#!/bin/sh\necho mihomo\n");

    // 2. tar.gz archive (sing-box style)
    let tar_bytes = build_tar(&[
        ("sing-box-1.14.4-linux-amd64/README.md", b"docs"),
        ("sing-box-1.14.4-linux-amd64/sing-box", b"SINGBOX-BIN"),
    ]);
    let mut tgz = GzEncoder::new(Vec::new(), Compression::default());
    tgz.write_all(&tar_bytes).unwrap();
    let tgz_bytes = tgz.finish().unwrap();
    let extracted = installer::extract_package(Core::SingBox, &tgz_bytes).unwrap();
    assert_eq!(extracted.binary, b"SINGBOX-BIN");

    // 3. zip archive (xray style with geo assets, deflated)
    let zip_bytes = build_zip(&[
        ("../evil/xray", b"NOPE"),
        ("xray", b"XRAY-BIN"),
        ("geoip.dat", b"GEOIP"),
        ("geosite.dat", b"GEOSITE"),
    ]);
    let extracted = installer::extract_package(Core::Xray, &zip_bytes).unwrap();
    assert_eq!(extracted.binary, b"XRAY-BIN");
    assert_eq!(extracted.extras.len(), 2);
}

#[tokio::test]
async fn installs_verifies_and_removes_managed_core_from_http_source() {
    let dir = std::env::temp_dir().join(format!("yuzuki-node-inst-{}", Uuid::new_v4()));
    let state_dir = dir.join("state");
    filesystem::directory(&state_dir).unwrap();

    let script = b"#!/bin/sh\necho \"Xray 26.11.9 (test-build)\"\n";
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(script).unwrap();
    let body = gz.finish().unwrap();
    let sha = hex::encode(Sha256::digest(&body));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let payload = Arc::new(body);
    let server = tokio::spawn({
        let payload = payload.clone();
        async move {
            for _ in 0..2 {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut req_buf = [0u8; 1024];
                let _ = socket.read(&mut req_buf).await;
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(&payload).await;
                let _ = socket.shutdown().await;
            }
        }
    });

    let settings = Settings {
        board_url: "https://control.example.net:3443".parse().unwrap(),
        ca_certificate: String::new(),
        state_dir: state_dir.clone(),
        binaries: Default::default(),
        core_management: CoreManagementSettings {
            enabled: true,
            detect_system_binaries: false,
            download_mirror: None,
            allow_http_downloads: true,
        },
        config_warnings: Vec::new(),
    };
    let url = format!("http://{addr}/xray.gz");

    // Wrong SHA-256 must fail cleanly
    let bad = installer::install_core(
        &settings,
        Core::Xray,
        "26.11.9",
        Some(&url),
        Some(&"0".repeat(64)),
        |_, _| {},
    )
    .await;
    assert!(bad.is_err());
    assert!(!installer::managed_binary_path(&settings, Core::Xray).exists());

    // Valid SHA-256 installs, self-checks, and sets Managed source
    let stages = Arc::new(Mutex::new(Vec::new()));
    let cap = installer::install_core(
        &settings,
        Core::Xray,
        "26.11.9",
        Some(&url),
        Some(&sha),
        {
            let stages = stages.clone();
            move |stage, _| {
                stages.lock().unwrap().push(stage);
            }
        },
    )
    .await
    .unwrap();

    assert_eq!(cap.core, Core::Xray);
    assert_eq!(cap.source, CoreSource::Managed);
    assert!(cap.version.contains("26.11.9"));
    assert!(installer::managed_binary_path(&settings, Core::Xray).is_file());
    let recorded = stages.lock().unwrap().clone();
    assert!(recorded.contains(&CoreActionStage::Downloading));
    assert!(recorded.contains(&CoreActionStage::Verifying));
    assert!(recorded.contains(&CoreActionStage::Testing));
    assert!(recorded.contains(&CoreActionStage::Installing));

    installer::remove_core(&settings, Core::Xray).unwrap();
    assert!(!installer::managed_binary_path(&settings, Core::Xray).exists());

    server.abort();
    let _ = fs::remove_dir_all(&dir);
}

fn build_tar(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, data) in entries {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..108].copy_from_slice(b"0000755\0");
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        let size_oct = format!("{:011o}\0", data.len());
        header[124..136].copy_from_slice(size_oct.as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        header[148..156].copy_from_slice(b"        ");
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let checksum: u32 = header.iter().map(|&b| u32::from(b)).sum();
        let chk = format!("{checksum:06o}\0 ");
        header[148..156].copy_from_slice(chk.as_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(data);
        let pad = (512 - (data.len() % 512)) % 512;
        out.extend(std::iter::repeat_n(0u8, pad));
    }
    out.extend(std::iter::repeat_n(0u8, 1024));
    out
}

fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(data).unwrap();
        let compressed = enc.finish().unwrap();
        let local_offset = out.len() as u32;
        let name_bytes = name.as_bytes();

        // Local file header
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&8u16.to_le_bytes()); // Deflate
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(&compressed);

        // Central directory header
        central.extend_from_slice(b"PK\x01\x02");
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&8u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&local_offset.to_le_bytes());
        central.extend_from_slice(name_bytes);
    }

    let cd_offset = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);

    // EOCD
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}
