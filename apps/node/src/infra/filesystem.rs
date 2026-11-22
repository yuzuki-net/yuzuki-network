use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

use anyhow::{Result, ensure};
use uuid::Uuid;

pub fn directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    let metadata = path.symlink_metadata()?;
    ensure!(metadata.is_dir(), "state path must be a directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Node state directory must be private (0700)"
        );
    }
    Ok(())
}

pub fn atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path.parent().expect("expected path within state directory");
    let staging = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&staging)?;
        file.write_all(content)?;
        file.sync_all()?;
        fs::rename(&staging, path)?;
        #[cfg(unix)]
        fs::File::open(parent)?.sync_all()?;
        anyhow::Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}
