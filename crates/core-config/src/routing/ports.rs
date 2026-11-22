use anyhow::Result;
use serde_json::Value;

use crate::{Core, cores::RenderOptions, protocols::NativeEndpoint, routing::Policy};

pub trait RoutingCompiler: Send + Sync {
    fn core(&self) -> Core;
    fn compile(&self, outbounds: &[NativeEndpoint], policy: &Policy) -> Result<Value>;

    fn compile_with_options(
        &self,
        outbounds: &[NativeEndpoint],
        policy: &Policy,
        _options: &RenderOptions,
    ) -> Result<Value> {
        self.compile(outbounds, policy)
    }
}
