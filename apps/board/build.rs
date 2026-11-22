use std::{env, ffi::OsStr, path::Path, process::Command};

fn main() {
    let frontend = Path::new("frontend");
    for file in [
        "package.json",
        "bun.lock",
        "vite.config.ts",
        "tsconfig.json",
        "index.html",
        "login.html",
        "register.html",
        "workspace.html",
        "admin.html",
        "src",
    ] {
        println!("cargo:rerun-if-changed=frontend/{file}");
    }
    println!("cargo:rerun-if-env-changed=BUN");

    let output = env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR");
    let bun = env::var_os("BUN").unwrap_or_else(|| "bun".into());
    run(&bun, frontend, &["install", "--frozen-lockfile"], &output);
    run(&bun, frontend, &["--bun", "run", "build"], &output);
}

fn run(bun: &OsStr, frontend: &Path, args: &[&str], output: &OsStr) {
    let status = Command::new(bun)
        .current_dir(frontend)
        .args(args)
        .env("YUZUKI_FRONTEND_OUT", output)
        .status()
        .unwrap_or_else(|error| panic!("failed to start Bun; install Bun or set BUN: {error}"));
    assert!(
        status.success(),
        "Bun command {args:?} exited with {status}"
    );
}
