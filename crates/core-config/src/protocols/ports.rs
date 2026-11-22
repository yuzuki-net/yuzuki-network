use anyhow::Result;

use crate::{Core, protocols::NativeEndpoint};

pub trait EndpointCodec: Send + Sync {
    fn encode(&self, core: Core, tag: &str, access_id: &str) -> Result<NativeEndpoint>;
}
