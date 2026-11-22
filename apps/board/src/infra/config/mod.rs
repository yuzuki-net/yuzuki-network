use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use serde::Deserialize;

#[derive(Parser)]
pub struct Cli {
    #[arg(long, env = "YUZUKI_CONFIG", value_name = "FILE")]
    config: Option<PathBuf>,
    #[arg(long, env = "YUZUKI_BIND", global = true)]
    bind: Option<SocketAddr>,
    #[arg(long, env = "YUZUKI_PUBLIC_DIR", global = true, value_name = "DIR")]
    public_dir: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand)]
pub enum Command {
    Serve,
    Migrate,
    CreateAdmin {
        #[arg(long)]
        email: String,
    },
    GrantAdmin {
        #[arg(long)]
        email: String,
    },
    RevokeAdmin {
        #[arg(long)]
        email: String,
    },
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub bind: SocketAddr,
    pub database_url: Option<String>,
    pub public_dir: Option<PathBuf>,
    pub subscription_route: String,
    pub allow_registration: bool,
    pub secure_cookies: bool,
    pub trusted_proxies: Vec<IpAddr>,
    pub control: Option<crate::infra::transport::ControlSettings>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 3000)),
            database_url: None,
            public_dir: None,
            subscription_route: "documents".into(),
            allow_registration: false,
            secure_cookies: true,
            trusted_proxies: Vec::new(),
            control: None,
        }
    }
}

impl Settings {
    pub fn load(cli: &Cli) -> Result<Self> {
        let mut settings: Self = match cli.config.as_deref() {
            Some(path) => {
                let content = std::fs::read_to_string(path)
                    .with_context(|| format!("read {}", path.display()))?;
                toml::from_str(&content).context("parse Board configuration")?
            }
            None => Self::default(),
        };
        if let Some(bind) = cli.bind {
            settings.bind = bind;
        }
        if let Some(path) = &cli.public_dir {
            settings.public_dir = Some(path.clone());
        }
        if let Ok(url) = std::env::var("YUZUKI_DATABASE_URL") {
            settings.database_url = Some(url);
        }
        if let Ok(route) = std::env::var("YUZUKI_SUBSCRIPTION_ROUTE") {
            settings.subscription_route = route;
        }
        ensure!(
            valid_route(&settings.subscription_route),
            "subscription_route must be a single lowercase ASCII segment and cannot use a reserved path"
        );
        Ok(settings)
    }
}

fn valid_route(route: &str) -> bool {
    (1..=48).contains(&route.len())
        && route.as_bytes()[0].is_ascii_lowercase()
        && route
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && !matches!(
            route,
            "admin" | "login" | "register" | "assets" | "workspace" | "auth" | "api"
        )
}
