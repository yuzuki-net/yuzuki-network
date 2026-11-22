use axum::Json;
use serde::Deserialize;
use yuzuki_core_config::routing::{Action, Decision, Policy, RouteGroup, Rule, RuleSet};

use crate::infra::error::{Error, Result, problem};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preview {
    destination: String,
    #[serde(default)]
    port: Option<u16>,
    default_action: Action,
    #[serde(default)]
    default_group_id: Option<String>,
    #[serde(default)]
    groups: Vec<RouteGroup>,
    #[serde(default)]
    rule_sets: Vec<RuleSet>,
    rules: Vec<Rule>,
}

pub async fn preview(Json(input): Json<Preview>) -> Result<Json<Decision>> {
    let mut policy = Policy {
        default_action: input.default_action,
        default_group_id: input.default_group_id,
        groups: input.groups,
        rule_sets: input.rule_sets,
        rules: input.rules,
        ..Policy::default()
    };
    policy
        .normalize()
        .map_err(|_| Error::BadRequest(problem::ROUTING_RULES))?;
    let decision = policy
        .evaluate_with_port(&input.destination, input.port)
        .map_err(|_| Error::BadRequest(problem::ROUTING_DESTINATION))?;
    Ok(Json(decision))
}
