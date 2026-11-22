use axum::http::{HeaderName, HeaderValue};
use yuzuki_core_config::{
    Core, cores::RenderOptions, protocols::NativeEndpoint, routing::Policy,
};

use crate::infra::error::Result;

pub struct Document {
    pub content_type: HeaderValue,
    pub headers: Vec<(HeaderName, HeaderValue)>,
    pub body: Vec<u8>,
}

pub trait SubscriptionRenderer: Send + Sync {
    fn render(
        &self,
        core: Core,
        endpoints: &[NativeEndpoint],
        policy: &Policy,
        options: &RenderOptions,
    ) -> Result<Document>;
}
