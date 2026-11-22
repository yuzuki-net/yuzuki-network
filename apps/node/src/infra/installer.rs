use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use flate2::read::{DeflateDecoder, GzDecoder};
use reqwest::{Client, Url};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{Capability, CoreActionStage, CoreSource, HostInfo},
};

use crate::{
    infra::{config::Settings, filesystem, process::ProcessCore},
    services::runtime::ports::CoreRuntime,
};

const MAX_DOWNLOAD_BYTES: usize = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

pub struct ExtractedPackage {
    pub binary: Vec<u8>,
    pub extras: Vec<(String, Vec<u8>)>,
}

pub fn host_info(core_management: bool) -> HostInfo {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "arm" => "armv7",
        "x86" => "386",
        other => other,
    };
    HostInfo {
        os: os.to_string(),
        arch: arch.to_string(),
        core_management,
    }
}

pub fn binary_filename(core: Core) -> &'static str {
    if cfg!(windows) {
        match core {
            Core::Xray => "xray.exe",
            Core::SingBox => "sing-box.exe",
            Core::Mihomo => "mihomo.exe",
        }
    } else {
        core.id()
    }
}

pub fn managed_core_dir(settings: &Settings, core: Core) -> PathBuf {
    settings.cores_dir().join(core.id())
}

pub fn managed_binary_path(settings: &Settings, core: Core) -> PathBuf {
    managed_core_dir(settings, core).join(binary_filename(core))
}

pub fn sanitize_version(raw: &str) -> Result<String> {
    let trimmed = raw.trim().trim_start_matches('v');
    ensure!(
        !trimmed.is_empty()
            && trimmed.len() <= 64
            && trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')),
        "invalid core version string"
    );
    Ok(trimmed.to_string())
}

pub fn default_download_url(
    core: Core,
    version: &str,
    os: &str,
    arch: &str,
    mirror: Option<&str>,
) -> Result<String> {
    let ver = sanitize_version(version)?;
    let upstream = match core {
        Core::Xray => {
            let xray_os = match os {
                "linux" => "linux",
                "darwin" => "macos",
                "windows" => "windows",
                _ => bail!("unsupported OS for xray-core: {os}"),
            };
            let xray_arch = match arch {
                "amd64" => "64",
                "arm64" => "arm64-v8a",
                "armv7" => "arm32-v7a",
                "386" => "32",
                _ => bail!("unsupported architecture for xray-core: {arch}"),
            };
            format!(
                "https://github.com/XTLS/Xray-core/releases/download/v{ver}/Xray-{xray_os}-{xray_arch}.zip"
            )
        }
        Core::SingBox => {
            let sb_os = match os {
                "linux" => "linux",
                "darwin" => "darwin",
                "windows" => "windows",
                _ => bail!("unsupported OS for sing-box: {os}"),
            };
            let sb_arch = match arch {
                "amd64" | "arm64" | "armv7" | "386" => arch,
                _ => bail!("unsupported architecture for sing-box: {arch}"),
            };
            let ext = if os == "windows" { "zip" } else { "tar.gz" };
            format!(
                "https://github.com/SagerNet/sing-box/releases/download/v{ver}/sing-box-{ver}-{sb_os}-{sb_arch}.{ext}"
            )
        }
        Core::Mihomo => {
            let mh_os = match os {
                "linux" => "linux",
                "darwin" => "darwin",
                "windows" => "windows",
                _ => bail!("unsupported OS for mihomo: {os}"),
            };
            let mh_arch = match (os, arch) {
                ("linux", "amd64") => "amd64-compatible",
                (_, "amd64") => "amd64",
                (_, "arm64") => "arm64",
                (_, "armv7") => "armv7",
                (_, "386") => "386",
                _ => bail!("unsupported architecture for mihomo: {arch}"),
            };
            let ext = if os == "windows" { "zip" } else { "gz" };
            format!(
                "https://github.com/MetaCubeX/mihomo/releases/download/v{ver}/mihomo-{mh_os}-{mh_arch}-v{ver}.{ext}"
            )
        }
    };

    if let Some(prefix) = mirror.map(str::trim).filter(|s| !s.is_empty()) {
        let joined = if prefix.ends_with('/') {
            format!("{prefix}{upstream}")
        } else {
            format!("{prefix}/{upstream}")
        };
        return Ok(joined);
    }
    Ok(upstream)
}

pub async fn install_core(
    settings: &Settings,
    core: Core,
    version: &str,
    download_url: Option<&str>,
    expected_sha256: Option<&str>,
    progress: impl Fn(CoreActionStage, String) + Send + Sync,
) -> Result<Capability> {
    ensure!(
        settings.core_management.enabled,
        "remote core management is disabled on this node"
    );

    let host = host_info(true);
    let url_str = match download_url.map(str::trim).filter(|s| !s.is_empty()) {
        Some(custom) => custom.to_string(),
        None => default_download_url(
            core,
            version,
            &host.os,
            &host.arch,
            settings.core_management.download_mirror.as_deref(),
        )?,
    };
    let parsed = Url::parse(&url_str).context("parse core download URL")?;
    ensure!(
        parsed.scheme() == "https"
            || (settings.core_management.allow_http_downloads && parsed.scheme() == "http"),
        "core download URL must use https"
    );

    let expected_hash = expected_sha256
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let lower = s.to_ascii_lowercase();
            ensure!(
                lower.len() == 64 && lower.chars().all(|c| c.is_ascii_hexdigit()),
                "sha256 must be a 64-character hex string"
            );
            Ok::<_, anyhow::Error>(lower)
        })
        .transpose()?;

    progress(
        CoreActionStage::Downloading,
        format!("Downloading {core} from {}", parsed.host_str().unwrap_or("remote")),
    );

    let client = Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("yuzuki-node/0.1")
        .build()
        .context("build download HTTP client")?;

    let mut response = client
        .get(parsed)
        .send()
        .await
        .with_context(|| format!("download {core} package"))?;
    ensure!(
        response.status().is_success(),
        "download server returned HTTP {}",
        response.status()
    );

    let mut payload = Vec::new();
    let mut hasher = Sha256::new();
    while let Some(chunk) = response.chunk().await.context("read download stream")? {
        ensure!(
            payload.len() + chunk.len() <= MAX_DOWNLOAD_BYTES,
            "downloaded archive exceeds maximum allowed size"
        );
        hasher.update(&chunk);
        payload.extend_from_slice(&chunk);
    }
    ensure!(!payload.is_empty(), "downloaded archive is empty");

    let actual_hash = hex::encode(hasher.finalize());
    if let Some(expected) = expected_hash {
        progress(CoreActionStage::Verifying, "Verifying SHA-256 checksum".into());
        ensure!(
            actual_hash == expected,
            "SHA-256 checksum mismatch (expected {expected}, got {actual_hash})"
        );
    }

    progress(CoreActionStage::Extracting, format!("Extracting {core} binary"));
    let extracted = tokio::task::spawn_blocking(move || extract_package(core, &payload))
        .await
        .context("extract task failed")??;

    let tmp_root = settings.state_dir.join("tmp");
    filesystem::directory(&tmp_root)?;
    let staging_dir = tmp_root.join(format!("install-{}", Uuid::new_v4()));
    filesystem::directory(&staging_dir)?;

    let install_result = async {
        let bin_name = binary_filename(core);
        let staged_bin = staging_dir.join(bin_name);
        filesystem::atomic_write(&staged_bin, &extracted.binary)?;
        set_executable(&staged_bin)?;

        for (extra_name, extra_bytes) in &extracted.extras {
            let extra_path = staging_dir.join(extra_name);
            filesystem::atomic_write(&extra_path, extra_bytes)?;
        }

        progress(CoreActionStage::Testing, format!("Verifying {core} executable"));
        let probe = ProcessCore::new(core, staged_bin.clone(), CoreSource::Managed);
        let mut cap = probe
            .capability()
            .await
            .with_context(|| format!("downloaded {core} binary failed self-check"))?;

        progress(CoreActionStage::Installing, format!("Installing {core} into managed directory"));
        filesystem::directory(&settings.cores_dir())?;
        let target_dir = managed_core_dir(settings, core);
        filesystem::directory(&target_dir)?;

        let target_bin = target_dir.join(bin_name);
        let staged_swap = target_dir.join(format!(".{bin_name}.{}.new", Uuid::new_v4()));
        fs::rename(&staged_bin, &staged_swap)
            .or_else(|_| fs::copy(&staged_bin, &staged_swap).map(|_| ()))?;
        set_executable(&staged_swap)?;
        fs::rename(&staged_swap, &target_bin)?;

        for (extra_name, _) in &extracted.extras {
            let src = staging_dir.join(extra_name);
            let dst = target_dir.join(extra_name);
            let swap = target_dir.join(format!(".{extra_name}.{}.new", Uuid::new_v4()));
            fs::rename(&src, &swap).or_else(|_| fs::copy(&src, &swap).map(|_| ()))?;
            fs::rename(&swap, &dst)?;
        }

        cap.path = Some(target_bin.display().to_string());
        cap.source = CoreSource::Managed;
        Ok::<_, anyhow::Error>(cap)
    }
    .await;

    let _ = fs::remove_dir_all(&staging_dir);
    install_result
}

pub fn remove_core(settings: &Settings, core: Core) -> Result<()> {
    ensure!(
        settings.core_management.enabled,
        "remote core management is disabled on this node"
    );
    let target_dir = managed_core_dir(settings, core);
    ensure!(
        target_dir.exists(),
        "{core} does not have a panel-managed binary installed"
    );
    fs::remove_dir_all(&target_dir)
        .with_context(|| format!("remove managed {core} directory"))?;
    Ok(())
}

fn set_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

pub fn extract_package(core: Core, bytes: &[u8]) -> Result<ExtractedPackage> {
    if bytes.starts_with(b"PK\x03\x04") {
        return extract_zip(core, bytes);
    }
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = GzDecoder::new(Cursor::new(bytes)).take(MAX_UNCOMPRESSED_BYTES + 1);
        let mut decompressed = Vec::new();
        decoder
            .read_to_end(&mut decompressed)
            .context("decompress gzip archive")?;
        ensure!(
            (decompressed.len() as u64) <= MAX_UNCOMPRESSED_BYTES,
            "decompressed archive exceeds size limit"
        );
        if is_tar(&decompressed) {
            return extract_tar(core, &decompressed);
        }
        ensure!(!decompressed.is_empty(), "gzip stream was empty");
        return Ok(ExtractedPackage {
            binary: decompressed,
            extras: Vec::new(),
        });
    }
    ensure!(!bytes.is_empty(), "empty binary payload");
    Ok(ExtractedPackage {
        binary: bytes.to_vec(),
        extras: Vec::new(),
    })
}

fn is_tar(bytes: &[u8]) -> bool {
    bytes.len() >= 512 && (&bytes[257..262] == b"ustar" || &bytes[257..263] == b"ustar\0")
}

fn matches_core_binary(core: Core, entry_name: &str) -> bool {
    let Some(base) = safe_basename(entry_name) else {
        return false;
    };
    let lower = base.to_ascii_lowercase();
    match core {
        Core::Xray => lower == "xray" || lower == "xray.exe",
        Core::SingBox => lower == "sing-box" || lower == "sing-box.exe",
        Core::Mihomo => {
            lower == "mihomo"
                || lower == "mihomo.exe"
                || (lower.starts_with("mihomo-") && !lower.ends_with(".txt") && !lower.ends_with(".md"))
        }
    }
}

fn matches_extra_asset(core: Core, entry_name: &str) -> Option<&'static str> {
    if core != Core::Xray {
        return None;
    }
    let base = safe_basename(entry_name)?;
    match base.to_ascii_lowercase().as_str() {
        "geoip.dat" => Some("geoip.dat"),
        "geosite.dat" => Some("geosite.dat"),
        _ => None,
    }
}

fn safe_basename(entry_name: &str) -> Option<&str> {
    let trimmed = entry_name.trim_matches('\0');
    if trimmed.is_empty() || trimmed.ends_with('/') || trimmed.ends_with('\\') {
        return None;
    }
    let parts: Vec<&str> = trimmed.split(['/', '\\']).collect();
    if parts.iter().any(|part| *part == "..") {
        return None;
    }
    let base = *parts.last()?;
    if base.is_empty() || base == "." || base == ".." {
        return None;
    }
    Some(base)
}

fn extract_tar(core: Core, bytes: &[u8]) -> Result<ExtractedPackage> {
    let mut pos = 0usize;
    let mut long_name: Option<String> = None;
    let mut binary: Option<Vec<u8>> = None;
    let mut extras = Vec::new();

    while pos + 512 <= bytes.len() {
        let header = &bytes[pos..pos + 512];
        if header.iter().all(|&b| b == 0) {
            break;
        }
        let size = parse_tar_size(&header[124..136])?;
        let typeflag = header[156];
        let data_start = pos + 512;
        let data_end = data_start
            .checked_add(size)
            .filter(|&end| end <= bytes.len())
            .context("tar entry extends past archive end")?;
        let data = &bytes[data_start..data_end];
        let padded = size.div_ceil(512) * 512;
        pos = data_start
            .checked_add(padded)
            .context("tar archive offset overflow")?;

        if typeflag == b'L' {
            long_name = Some(
                String::from_utf8_lossy(data)
                    .trim_end_matches('\0')
                    .to_string(),
            );
            continue;
        }
        if typeflag == b'x' || typeflag == b'g' {
            if let Some(path) = parse_pax_path(data) {
                long_name = Some(path);
            }
            continue;
        }

        let name = if let Some(override_name) = long_name.take() {
            override_name
        } else {
            let raw_name = tar_str(&header[0..100]);
            let prefix = tar_str(&header[345..500]);
            if prefix.is_empty() {
                raw_name
            } else {
                format!("{prefix}/{raw_name}")
            }
        };

        if typeflag == 0 || typeflag == b'0' {
            if binary.is_none() && matches_core_binary(core, &name) {
                binary = Some(data.to_vec());
            } else if let Some(extra) = matches_extra_asset(core, &name) {
                extras.push((extra.to_string(), data.to_vec()));
            }
        }
    }

    let binary = binary.with_context(|| format!("could not find {core} binary inside tar archive"))?;
    Ok(ExtractedPackage { binary, extras })
}

fn tar_str(slice: &[u8]) -> String {
    let end = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
    String::from_utf8_lossy(&slice[..end]).to_string()
}

fn parse_tar_size(slice: &[u8]) -> Result<usize> {
    if slice[0] & 0x80 != 0 {
        let mut value = 0u64;
        for &byte in &slice[1..] {
            value = (value << 8) | u64::from(byte);
        }
        return usize::try_from(value).context("tar entry size overflow");
    }
    let text = tar_str(slice);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    usize::from_str_radix(trimmed, 8).context("invalid octal size in tar header")
}

fn parse_pax_path(data: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(data).ok()?;
    for line in text.lines() {
        if let Some((_, rest)) = line.split_once(' ')
            && let Some(path) = rest.strip_prefix("path=")
        {
            return Some(path.to_string());
        }
    }
    None
}

fn extract_zip(core: Core, bytes: &[u8]) -> Result<ExtractedPackage> {
    ensure!(bytes.len() >= 22, "zip archive is truncated");
    let min_eocd = bytes.len().saturating_sub(65_557);
    let mut eocd_pos = None;
    for pos in (min_eocd..=bytes.len() - 22).rev() {
        if &bytes[pos..pos + 4] == b"PK\x05\x06" {
            eocd_pos = Some(pos);
            break;
        }
    }
    let eocd = eocd_pos.context("missing zip end-of-central-directory record")?;
    let entry_count = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]) as usize;
    let cd_size = u32::from_le_bytes([
        bytes[eocd + 12],
        bytes[eocd + 13],
        bytes[eocd + 14],
        bytes[eocd + 15],
    ]) as usize;
    let cd_offset = u32::from_le_bytes([
        bytes[eocd + 16],
        bytes[eocd + 17],
        bytes[eocd + 18],
        bytes[eocd + 19],
    ]) as usize;
    let cd_end = cd_offset
        .checked_add(cd_size)
        .filter(|&end| end <= bytes.len())
        .context("zip central directory out of bounds")?;

    let mut pos = cd_offset;
    let mut binary: Option<Vec<u8>> = None;
    let mut extras = Vec::new();

    for _ in 0..entry_count {
        ensure!(pos + 46 <= cd_end, "truncated zip central directory entry");
        ensure!(
            &bytes[pos..pos + 4] == b"PK\x01\x02",
            "invalid zip central directory signature"
        );
        let method = u16::from_le_bytes([bytes[pos + 10], bytes[pos + 11]]);
        let compressed_size = u32::from_le_bytes([
            bytes[pos + 20],
            bytes[pos + 21],
            bytes[pos + 22],
            bytes[pos + 23],
        ]) as usize;
        let uncompressed_size = u32::from_le_bytes([
            bytes[pos + 24],
            bytes[pos + 25],
            bytes[pos + 26],
            bytes[pos + 27],
        ]) as u64;
        let name_len = u16::from_le_bytes([bytes[pos + 28], bytes[pos + 29]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[pos + 30], bytes[pos + 31]]) as usize;
        let comment_len = u16::from_le_bytes([bytes[pos + 32], bytes[pos + 33]]) as usize;
        let local_offset = u32::from_le_bytes([
            bytes[pos + 42],
            bytes[pos + 43],
            bytes[pos + 44],
            bytes[pos + 45],
        ]) as usize;

        let name_start = pos + 46;
        let name_end = name_start + name_len;
        ensure!(name_end <= cd_end, "zip entry name out of bounds");
        let name = String::from_utf8_lossy(&bytes[name_start..name_end]).to_string();
        pos = name_end + extra_len + comment_len;

        let is_binary = binary.is_none() && matches_core_binary(core, &name);
        let extra_target = if !is_binary {
            matches_extra_asset(core, &name)
        } else {
            None
        };
        if !is_binary && extra_target.is_none() {
            continue;
        }

        ensure!(
            uncompressed_size <= MAX_UNCOMPRESSED_BYTES,
            "zip entry {name} exceeds size limit"
        );
        ensure!(
            local_offset + 30 <= bytes.len() && &bytes[local_offset..local_offset + 4] == b"PK\x03\x04",
            "invalid zip local file header"
        );
        let local_name_len = u16::from_le_bytes([bytes[local_offset + 26], bytes[local_offset + 27]]) as usize;
        let local_extra_len = u16::from_le_bytes([bytes[local_offset + 28], bytes[local_offset + 29]]) as usize;
        let data_start = local_offset + 30 + local_name_len + local_extra_len;
        let data_end = data_start
            .checked_add(compressed_size)
            .filter(|&end| end <= bytes.len())
            .context("zip entry payload out of bounds")?;
        let compressed = &bytes[data_start..data_end];

        let content = match method {
            0 => compressed.to_vec(),
            8 => {
                let mut decoder =
                    DeflateDecoder::new(Cursor::new(compressed)).take(MAX_UNCOMPRESSED_BYTES + 1);
                let mut out = Vec::new();
                decoder
                    .read_to_end(&mut out)
                    .with_context(|| format!("inflate zip entry {name}"))?;
                ensure!(
                    (out.len() as u64) <= MAX_UNCOMPRESSED_BYTES,
                    "inflated zip entry exceeds size limit"
                );
                out
            }
            other => bail!("unsupported zip compression method {other} for {name}"),
        };

        if is_binary {
            binary = Some(content);
        } else if let Some(extra) = extra_target {
            extras.push((extra.to_string(), content));
        }
    }

    let binary = binary.with_context(|| format!("could not find {core} binary inside zip archive"))?;
    Ok(ExtractedPackage { binary, extras })
}
