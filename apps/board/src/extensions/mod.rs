use axum::http::HeaderValue;
use yuzuki_core_config::{
    Core,
    cores::{Registry, RenderOptions},
    protocols::NativeEndpoint,
    routing::Policy,
};

use crate::{
    infra::error::{Error, Result},
    services::subscriptions::ports::{Document, SubscriptionRenderer},
};

pub struct NativeRenderer(pub Registry);

impl SubscriptionRenderer for NativeRenderer {
    fn render(
        &self,
        core: Core,
        endpoints: &[NativeEndpoint],
        policy: &Policy,
        options: &RenderOptions,
    ) -> Result<Document> {
        let value = self
            .0
            .render_with_options(core, endpoints, policy, options)
            .map_err(|error| Error::Invalid(error.to_string()))?;
        let (content_type, body) = match core {
            Core::Mihomo => (
                "application/yaml",
                serde_yaml_ng::to_string(&value)
                    .map_err(|error| Error::Internal(error.into()))?
                    .into_bytes(),
            ),
            _ => (
                "application/json",
                serde_json::to_vec_pretty(&value).map_err(|error| Error::Internal(error.into()))?,
            ),
        };
        Ok(Document {
            content_type: HeaderValue::from_static(content_type),
            headers: Vec::new(),
            body,
        })
    }
}
