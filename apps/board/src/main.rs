use anyhow::{Context, Result};
use board::{
    app,
    infra::{
        config::{Cli, Command, Settings},
        migration, postgres,
    },
    services::{accounts, auth::Auth, dashboard},
};
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cli = Cli::parse();
    let settings = Settings::load(&cli)?;
    let url = settings
        .database_url
        .as_deref()
        .context("set YUZUKI_DATABASE_URL or database_url")?;
    let db = postgres::connect(url).await?;
    migration::run(&db).await?;
    match cli.command.unwrap_or(Command::Serve) {
        Command::Migrate => {}
        Command::CreateAdmin { email } => {
            let auth = Auth::new(settings.secure_cookies)
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
            let password =
                std::env::var("YUZUKI_ADMIN_PASSWORD").context("set YUZUKI_ADMIN_PASSWORD")?;
            accounts::create(&db, &auth, email, password, true, true)
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        }
        Command::GrantAdmin { email } => {
            accounts::set_admin(&db, &email, true)
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        }
        Command::RevokeAdmin { email } => {
            accounts::set_admin(&db, &email, false)
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        }
        Command::Serve => {
            let listener = tokio::net::TcpListener::bind(settings.bind).await?;
            eprintln!("Board listening on {}", listener.local_addr()?);
            let state = app::State::new(db, settings)
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
            tokio::spawn(board::services::messages::worker(state.db.clone()));
            let cleanup = state.db.clone();
            tokio::spawn(async move {
                let mut timer = tokio::time::interval(std::time::Duration::from_secs(3600));
                loop {
                    timer.tick().await;
                    if let Err(error) = Auth::purge_sessions(&cleanup).await {
                        tracing::warn!(?error, "session cleanup failed");
                    }
                    if let Err(error) =
                        board::services::subscriptions::devices::purge(&cleanup).await
                    {
                        tracing::warn!(?error, "subscription device cleanup failed");
                    }
                    if let Err(error) = dashboard::prune_history(&cleanup).await {
                        tracing::warn!(?error, "dashboard history cleanup failed");
                    }
                }
            });
            let gateway = match state.settings.control.as_ref() {
                Some(settings) => {
                    Some(board::infra::transport::Gateway::bind(settings, state.clone()).await?)
                }
                None => None,
            };
            let control = async {
                match gateway {
                    Some(gateway) => gateway.run().await,
                    None => std::future::pending().await,
                }
            };
            let public = axum::serve(
                listener,
                app::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            });
            tokio::select! { result = public => result?, result = control => result? }
        }
    }
    Ok(())
}
