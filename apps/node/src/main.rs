use anyhow::Result;
use clap::Parser;
use node::{
    app,
    infra::config::{Args, Command, Settings},
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args = Args::parse();
    app::run(
        Settings::load(&args.config)?,
        args.command.unwrap_or(Command::Run),
    )
    .await
}
