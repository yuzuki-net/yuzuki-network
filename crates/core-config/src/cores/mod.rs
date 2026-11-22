mod mihomo;
mod sing_box;
pub mod universal;
mod xray;

use std::collections::{BTreeMap, HashSet};

use anyhow::{Result, ensure};
use serde_json::Value;

use crate::{
    Core,
    protocols::NativeEndpoint,
    routing::{Policy, overlay, ports::RoutingCompiler},
};

const DEFAULT_INFO_GROUP_NAME: &str = "📊 Subscription info";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InfoNodePlacement {
    #[default]
    PrependToGroup,
    AppendToGroup,
    DedicatedGroup,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RenderOptions {
    pub info_nodes: Vec<String>,
    pub info_group_name: String,
    pub placement: InfoNodePlacement,
}

impl RenderOptions {
    pub(crate) fn unique_info_labels(&self, existing: impl IntoIterator<Item = String>) -> Vec<String> {
        let mut used: HashSet<String> = existing.into_iter().collect();
        for reserved in ["direct", "block", "local", "group", "DIRECT", "REJECT"] {
            used.insert(reserved.to_owned());
        }
        let mut labels = Vec::with_capacity(self.info_nodes.len());
        for raw in &self.info_nodes {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mut candidate = trimmed.to_owned();
            let mut suffix = 2usize;
            while used.contains(&candidate) {
                candidate = format!("{trimmed} #{suffix}");
                suffix += 1;
            }
            used.insert(candidate.clone());
            labels.push(candidate);
        }
        labels
    }

    pub(crate) fn group_label(&self) -> &str {
        let trimmed = self.info_group_name.trim();
        if trimmed.is_empty() {
            DEFAULT_INFO_GROUP_NAME
        } else {
            trimmed
        }
    }
}

pub struct Registry(BTreeMap<Core, Box<dyn RoutingCompiler>>);

impl Registry {
    pub fn builtins() -> Self {
        let mut registry = Self(BTreeMap::new());
        registry.register(xray::Xray).unwrap();
        registry.register(sing_box::SingBox).unwrap();
        registry.register(mihomo::Mihomo).unwrap();
        registry
    }

    pub fn register(&mut self, compiler: impl RoutingCompiler + 'static) -> Result<()> {
        let core = compiler.core();
        ensure!(
            !self.0.contains_key(&core),
            "duplicate routing compiler for {core}"
        );
        self.0.insert(core, Box::new(compiler));
        Ok(())
    }

    pub fn render(
        &self,
        core: Core,
        endpoints: &[NativeEndpoint],
        policy: &Policy,
    ) -> Result<Value> {
        self.render_with_options(core, endpoints, policy, &RenderOptions::default())
    }

    pub fn render_with_options(
        &self,
        core: Core,
        endpoints: &[NativeEndpoint],
        policy: &Policy,
        options: &RenderOptions,
    ) -> Result<Value> {
        let mut result = self
            .0
            .get(&core)
            .ok_or_else(|| anyhow::anyhow!("no compiler for {core}"))?
            .compile_with_options(endpoints, policy, options)?;
        if let Some(native) = policy.native.get(&core) {
            // These arrays are owned by the endpoint catalog. Operators may add native rules
            // and groups, but subscription entries are always sourced from the account's nodes.
            for key in ["outbounds", "endpoints", "proxies"] {
                ensure!(
                    native.get(key).is_none(),
                    "configure native {key} in the endpoint catalog"
                );
            }
            overlay(&mut result, native);
        }
        Ok(result)
    }
}
