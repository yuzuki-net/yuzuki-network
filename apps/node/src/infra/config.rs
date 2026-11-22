use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use reqwest::Url;
use yuzuki_protocol::Core;

#[derive(Parser)]
pub struct Args {
    #[arg(long, env = "YUZUKI_NODE_CONFIG", value_name = "FILE")]
    pub config: PathBuf,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand)]
pub enum Command {
    Enroll,
    Run,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreManagementSettings {
    pub enabled: bool,
    pub detect_system_binaries: bool,
    pub download_mirror: Option<String>,
    pub allow_http_downloads: bool,
}

impl Default for CoreManagementSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            detect_system_binaries: true,
            download_mirror: None,
            allow_http_downloads: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Settings {
    pub board_url: Url,
    pub ca_certificate: String,
    pub state_dir: PathBuf,
    pub binaries: BTreeMap<Core, PathBuf>,
    pub core_management: CoreManagementSettings,
    pub config_warnings: Vec<String>,
}

impl Settings {
    /// Resilient configuration loader.
    ///
    /// As long as the essential Board connection parameters (`board_url`,
    /// `ca_certificate`, `state_dir`) can be extracted and validated, `yuzuki-node`
    /// will still boot and connect to Board even if optional sections contain
    /// unknown keys, invalid values, or trailing TOML syntax errors. Any issues
    /// encountered are collected into `config_warnings` and reported to Board.
    pub fn load(path: &Path) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let config_dir = path.parent().filter(|p| !p.as_os_str().is_empty());
        let mut warnings = Vec::new();

        let (raw_board_url, raw_ca_path, raw_state_dir, binaries, core_management) =
            match toml::from_str::<toml::Table>(&text) {
                Ok(table) => parse_lenient_table(&table, &mut warnings)?,
                Err(parse_err) => {
                    tracing::warn!(
                        error = %parse_err,
                        path = %path.display(),
                        "node.toml failed full TOML parsing; attempting degraded connection-only recovery"
                    );
                    let recovered = extract_fallback_connection_fields(&text);
                    let (Some(url), Some(ca), Some(state)) = (
                        recovered.board_url,
                        recovered.ca_certificate,
                        recovered.state_dir,
                    ) else {
                        return Err(anyhow::anyhow!(
                            "parse {}: {parse_err} (and fallback recovery could not locate board_url, ca_certificate, and state_dir)",
                            path.display()
                        ));
                    };
                    warnings.push(format!(
                        "node.toml contains a syntax error ({}); started in degraded mode with default core_management",
                        compact_error(&parse_err.to_string())
                    ));
                    (
                        url,
                        PathBuf::from(ca),
                        PathBuf::from(state),
                        BTreeMap::new(),
                        CoreManagementSettings::default(),
                    )
                }
            };

        let board_url = normalize_board_url(&raw_board_url)?;
        let state_dir = env::current_dir()?.join(raw_state_dir);
        let ca_certificate = read_ca_certificate(&raw_ca_path, config_dir)?;

        for warning in &warnings {
            tracing::warn!(%warning, "node.toml warning");
        }

        Ok(Self {
            board_url,
            ca_certificate,
            state_dir,
            binaries,
            core_management,
            config_warnings: warnings,
        })
    }

    pub fn cores_dir(&self) -> PathBuf {
        self.state_dir.join("cores")
    }
}

fn parse_lenient_table(
    table: &toml::Table,
    warnings: &mut Vec<String>,
) -> Result<(
    String,
    PathBuf,
    PathBuf,
    BTreeMap<Core, PathBuf>,
    CoreManagementSettings,
)> {
    let board_url = table
        .get("board_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .context("missing or invalid required string field `board_url`")?
        .to_string();

    let ca_certificate = table
        .get("ca_certificate")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .context("missing or invalid required string field `ca_certificate`")?;

    let state_dir = table
        .get("state_dir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .context("missing or invalid required string field `state_dir`")?;

    for key in table.keys() {
        if !matches!(
            key.as_str(),
            "board_url" | "ca_certificate" | "state_dir" | "binaries" | "core_management"
        ) {
            warnings.push(format!("Ignored unknown top-level key `{key}` in node.toml"));
        }
    }

    let mut core_management = CoreManagementSettings::default();
    if let Some(section) = table.get("core_management") {
        if let Some(cm) = section.as_table() {
            for (k, v) in cm {
                match k.as_str() {
                    "enabled" => match v.as_bool() {
                        Some(b) => core_management.enabled = b,
                        None => warnings.push(
                            "Invalid `core_management.enabled` (expected boolean); defaulted to true"
                                .into(),
                        ),
                    },
                    "detect_system_binaries" => match v.as_bool() {
                        Some(b) => core_management.detect_system_binaries = b,
                        None => warnings.push(
                            "Invalid `core_management.detect_system_binaries` (expected boolean); defaulted to true"
                                .into(),
                        ),
                    },
                    "allow_http_downloads" => match v.as_bool() {
                        Some(b) => core_management.allow_http_downloads = b,
                        None => warnings.push(
                            "Invalid `core_management.allow_http_downloads` (expected boolean); defaulted to false"
                                .into(),
                        ),
                    },
                    "download_mirror" => match v.as_str() {
                        Some(s) if s.trim().is_empty() => core_management.download_mirror = None,
                        Some(s) => core_management.download_mirror = Some(s.trim().to_string()),
                        None => warnings.push(
                            "Invalid `core_management.download_mirror` (expected string); ignored"
                                .into(),
                        ),
                    },
                    other => warnings.push(format!(
                        "Ignored unknown key `core_management.{other}` in node.toml"
                    )),
                }
            }
        } else {
            warnings.push(
                "Invalid `[core_management]` section (expected table); using safe defaults".into(),
            );
        }
    }

    if let Some(mirror) = core_management.download_mirror.clone() {
        let valid = Url::parse(&mirror).ok().is_some_and(|parsed| {
            parsed.scheme() == "https"
                || (core_management.allow_http_downloads && parsed.scheme() == "http")
        });
        if !valid {
            warnings.push(format!(
                "Ignored invalid `core_management.download_mirror` ({mirror}); using official release URLs"
            ));
            core_management.download_mirror = None;
        }
    }

    let mut binaries = BTreeMap::new();
    if let Some(section) = table.get("binaries") {
        if let Some(bins) = section.as_table() {
            for (k, v) in bins {
                let Ok(core) = k.parse::<Core>() else {
                    warnings.push(format!(
                        "Ignored unknown core `{k}` in `[binaries]` section"
                    ));
                    continue;
                };
                match v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(bin_path) => {
                        binaries.insert(core, PathBuf::from(bin_path));
                    }
                    None => warnings.push(format!(
                        "Ignored invalid binary path for `{k}` in `[binaries]`"
                    )),
                }
            }
        } else {
            warnings.push("Invalid `[binaries]` section (expected table); ignored".into());
        }
    }

    Ok((
        board_url,
        PathBuf::from(ca_certificate),
        PathBuf::from(state_dir),
        binaries,
        core_management,
    ))
}

#[derive(Default)]
struct FallbackConnectionFields {
    board_url: Option<String>,
    ca_certificate: Option<String>,
    state_dir: Option<String>,
}

fn extract_fallback_connection_fields(text: &str) -> FallbackConnectionFields {
    let mut result = FallbackConnectionFields::default();
    let mut in_section = false;
    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') {
            in_section = true;
            continue;
        }
        if in_section {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !matches!(key, "board_url" | "ca_certificate" | "state_dir") {
            continue;
        }
        // Parse a single key=value line via toml so standard escaping/quoting is honored.
        if let Ok(parsed) = toml::from_str::<toml::Table>(trimmed)
            && let Some(val) = parsed.get(key).and_then(|v| v.as_str())
        {
            let val = val.trim().to_string();
            if !val.is_empty() {
                match key {
                    "board_url" => result.board_url = Some(val),
                    "ca_certificate" => result.ca_certificate = Some(val),
                    "state_dir" => result.state_dir = Some(val),
                    _ => {}
                }
            }
            continue;
        }
        // Fallback: unquote basic string manually if trailing garbage exists on the same line.
        if let Some(unquoted) = extract_quoted_string(value.trim()) {
            match key {
                "board_url" => result.board_url = Some(unquoted),
                "ca_certificate" => result.ca_certificate = Some(unquoted),
                "state_dir" => result.state_dir = Some(unquoted),
                _ => {}
            }
        }
    }
    result
}

fn extract_quoted_string(raw: &str) -> Option<String> {
    let quote = raw.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let mut out = String::new();
    let mut escaped = false;
    for ch in raw[1..].chars() {
        if quote == '"' && escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        if quote == '"' && ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            let trimmed = out.trim();
            return (!trimmed.is_empty()).then(|| trimmed.to_string());
        }
        out.push(ch);
    }
    None
}

fn normalize_board_url(raw: &str) -> Result<Url> {
    let trimmed = raw.trim().trim_end_matches('/');
    let mut board_url = Url::parse(trimmed).context("parse board_url")?;
    ensure!(
        board_url.scheme() == "https"
            && (board_url.path().is_empty() || board_url.path() == "/")
            && board_url.username().is_empty()
            && board_url.password().is_none()
            && board_url.query().is_none()
            && board_url.fragment().is_none(),
        "board_url must be an HTTPS origin"
    );
    board_url.set_path("/");
    Ok(board_url)
}

fn read_ca_certificate(ca_path: &Path, config_dir: Option<&Path>) -> Result<String> {
    match std::fs::read_to_string(ca_path) {
        Ok(pem) => Ok(pem),
        Err(first_err) => {
            if ca_path.is_relative()
                && let Some(dir) = config_dir
            {
                let alt = dir.join(ca_path);
                if let Ok(pem) = std::fs::read_to_string(&alt) {
                    return Ok(pem);
                }
            }
            Err(first_err).with_context(|| format!("read Board TLS CA ({})", ca_path.display()))
        }
    }
}

fn compact_error(raw: &str) -> String {
    raw.lines()
        .next()
        .unwrap_or("invalid syntax")
        .chars()
        .filter(|c| !c.is_control())
        .take(180)
        .collect()
}
