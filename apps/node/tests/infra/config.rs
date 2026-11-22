use std::fs;
use uuid::Uuid;

use node::infra::config::Settings;

fn temp_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("yuzuki-node-cfg-{label}-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn loads_valid_config_without_warnings() {
    let dir = temp_dir("valid");
    let ca = dir.join("ca.crt");
    fs::write(&ca, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n").unwrap();
    let cfg_path = dir.join("node.toml");
    fs::write(
        &cfg_path,
        format!(
            r#"
board_url = "https://control.example.net:3443/"
ca_certificate = "{}"
state_dir = "{}"

[core_management]
enabled = true
detect_system_binaries = true
"#,
            ca.display(),
            dir.join("state").display()
        ),
    )
    .unwrap();

    let settings = Settings::load(&cfg_path).unwrap();
    assert_eq!(settings.board_url.as_str(), "https://control.example.net:3443/");
    assert!(settings.core_management.enabled);
    assert!(settings.config_warnings.is_empty());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn ignores_unknown_keys_and_invalid_optional_fields_with_warnings() {
    let dir = temp_dir("lenient");
    let ca = dir.join("ca.crt");
    fs::write(&ca, "CA").unwrap();
    let cfg_path = dir.join("node.toml");
    fs::write(
        &cfg_path,
        format!(
            r#"
board_url = "https://control.example.net:3443"
ca_certificate = "ca.crt"
state_dir = "{}"
obsolete_option = 42

[core_management]
enabled = "not-a-bool"
download_mirror = "ftp://bad-mirror"
extra_flag = true

[binaries]
xray = "/usr/local/bin/xray"
unknown_core = "/bin/true"
"#,
            dir.join("state").display()
        ),
    )
    .unwrap();

    let settings = Settings::load(&cfg_path).unwrap();
    assert_eq!(settings.board_url.as_str(), "https://control.example.net:3443/");
    // Falls back to safe default true for core_management.enabled
    assert!(settings.core_management.enabled);
    // Bad mirror dropped safely
    assert!(settings.core_management.download_mirror.is_none());
    // Valid binary preserved, unknown core ignored
    assert_eq!(settings.binaries.len(), 1);
    assert!(settings.config_warnings.len() >= 4);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn boots_in_degraded_mode_when_tail_of_toml_has_syntax_error() {
    let dir = temp_dir("degraded");
    let ca = dir.join("ca.crt");
    fs::write(&ca, "CA").unwrap();
    let cfg_path = dir.join("node.toml");
    fs::write(
        &cfg_path,
        format!(
            r#"
# Connection info at top is valid
board_url = "https://control.example.net:3443"
ca_certificate = "{}"
state_dir = "{}"

[binaries
xray = "broken unclosed quote
"#,
            ca.display(),
            dir.join("state").display()
        ),
    )
    .unwrap();

    let settings = Settings::load(&cfg_path).unwrap();
    assert_eq!(settings.board_url.as_str(), "https://control.example.net:3443/");
    assert!(settings.core_management.enabled);
    assert!(settings.binaries.is_empty());
    assert_eq!(settings.config_warnings.len(), 1);
    assert!(settings.config_warnings[0].contains("degraded mode"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn fails_when_connection_fields_are_missing() {
    let dir = temp_dir("missing");
    let cfg_path = dir.join("node.toml");
    fs::write(&cfg_path, "state_dir = \"/tmp/state\"\n").unwrap();
    assert!(Settings::load(&cfg_path).is_err());
    let _ = fs::remove_dir_all(&dir);
}
