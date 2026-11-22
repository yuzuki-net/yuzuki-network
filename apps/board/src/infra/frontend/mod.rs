mod public_dir;

use axum::{
    http::{HeaderValue, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

use crate::infra::error::{Error, Result};
pub use public_dir::PublicDir;

#[derive(RustEmbed)]
#[folder = "$OUT_DIR/site"]
struct PublicAssets;

#[derive(RustEmbed)]
#[folder = "$OUT_DIR/private"]
struct WorkspaceAssets;

pub async fn public(directory: &PublicDir, name: &str) -> Result<Response> {
    if !valid(name) {
        return Err(Error::NotFound);
    }
    if let Some(file) = directory.read(name).await? {
        return Ok(response(name, file));
    }
    let file = PublicAssets::get(name).ok_or(Error::NotFound)?;
    Ok(response(name, file.data.into_owned()))
}

pub fn private(name: &str) -> Result<Response> {
    if !valid(name) {
        return Err(Error::NotFound);
    }
    let file = WorkspaceAssets::get(name).ok_or(Error::NotFound)?;
    Ok(response(name, file.data.into_owned()))
}

fn valid(name: &str) -> bool {
    !name.contains('\\')
        && name.split('/').all(|part| {
            !part.is_empty() && !part.starts_with('.') && !part.chars().any(char::is_control)
        })
}

fn response(name: &str, data: Vec<u8>) -> Response {
    let content_type = mime_guess::from_path(name).first_or_octet_stream();
    let header = HeaderValue::from_str(content_type.as_ref()).expect("MIME type must be ASCII");
    ([(CONTENT_TYPE, header)], data).into_response()
}
