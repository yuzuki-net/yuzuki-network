use std::io::{self, Cursor};

use serde::{Serialize, de::DeserializeOwned};

pub const MAX_FRAME_SIZE: usize = 2 * 1024 * 1024;

pub fn encode<T: Serialize>(message: &T) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    ciborium::into_writer(message, &mut bytes).map_err(io::Error::other)?;
    if bytes.len() > MAX_FRAME_SIZE {
        return Err(io::Error::other("control frame exceeds the allowed size"));
    }
    Ok(bytes)
}

pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> io::Result<T> {
    if bytes.len() > MAX_FRAME_SIZE {
        return Err(io::Error::other("control frame exceeds the allowed size"));
    }
    let mut input = Cursor::new(bytes);
    let message =
        ciborium::de::from_reader_with_recursion_limit(&mut input, 64).map_err(io::Error::other)?;
    if input.position() != bytes.len() as u64 {
        return Err(io::Error::other("unexpected data after control message"));
    }
    Ok(message)
}
