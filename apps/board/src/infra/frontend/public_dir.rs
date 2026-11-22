use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

use crate::infra::error::{Error, Result};

pub struct PublicDir(Option<PathBuf>);

impl PublicDir {
    pub async fn resolve(configured: Option<&Path>) -> Result<Self> {
        let path = configured.unwrap_or(Path::new("public"));
        let root = match tokio::fs::canonicalize(path).await {
            Ok(path)
                if tokio::fs::metadata(&path)
                    .await
                    .is_ok_and(|meta| meta.is_dir()) =>
            {
                Some(path)
            }
            Ok(_) => {
                return Err(Error::Internal(anyhow::anyhow!(
                    "public path is not a directory"
                )));
            }
            Err(error) if configured.is_none() && error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(Error::Internal(error.into())),
        };
        Ok(Self(root))
    }

    pub async fn read(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let Some(root) = &self.0 else { return Ok(None) };
        let path = match tokio::fs::canonicalize(root.join(name)).await {
            Ok(path) => path,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(Error::Internal(error.into())),
        };
        if !path.starts_with(root) {
            return Err(Error::NotFound);
        }
        let meta = tokio::fs::metadata(&path)
            .await
            .map_err(|e| Error::Internal(e.into()))?;
        if !meta.is_file() {
            return Ok(None);
        }
        tokio::fs::read(path)
            .await
            .map(Some)
            .map_err(|e| Error::Internal(e.into()))
    }
}
