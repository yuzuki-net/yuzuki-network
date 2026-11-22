use std::net::IpAddr;

use anyhow::{Result, ensure};
use ipnet::IpNet;
use serde::Serialize;

use super::{Action, Match, Policy, Rule, parse_port_spec};
use crate::protocols::valid_host;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Decision {
    pub action: Action,
    pub rule_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped_dynamic_rules: Vec<usize>,
}

impl Policy {
    pub fn evaluate(&self, destination: &str) -> Result<Decision> {
        self.evaluate_with_port(destination, None)
    }

    pub fn evaluate_with_port(&self, destination: &str, port: Option<u16>) -> Result<Decision> {
        let destination = destination.trim().to_ascii_lowercase();
        let (host, ip) = match destination.parse::<IpAddr>() {
            Ok(ip) => (destination.as_str(), Some(ip)),
            Err(_) => (destination.strip_suffix('.').unwrap_or(&destination), None),
        };
        ensure!(valid_host(host), "Enter a domain or IP address.");
        let mut skipped = Vec::new();
        for (index, rule) in self.rules.iter().enumerate() {
            match match_rule(rule, host, ip, port)? {
                MatchOutcome::Matched => {
                    let group_name = rule
                        .group_id
                        .as_deref()
                        .and_then(|id| self.find_group(id))
                        .map(|g| g.name.clone());
                    return Ok(Decision {
                        action: rule.action,
                        rule_index: Some(index),
                        group_id: rule.group_id.clone(),
                        group_name,
                        skipped_dynamic_rules: skipped,
                    });
                }
                MatchOutcome::DynamicSkipped => skipped.push(index),
                MatchOutcome::NoMatch => {}
            }
        }
        let default_group_name = self
            .default_group_id
            .as_deref()
            .and_then(|id| self.find_group(id))
            .map(|g| g.name.clone());
        Ok(Decision {
            action: self.default_action,
            rule_index: None,
            group_id: self.default_group_id.clone(),
            group_name: default_group_name,
            skipped_dynamic_rules: skipped,
        })
    }
}

enum MatchOutcome {
    Matched,
    NoMatch,
    DynamicSkipped,
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0b1100_0000) == 64)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

fn match_rule(
    rule: &Rule,
    host: &str,
    ip: Option<IpAddr>,
    port: Option<u16>,
) -> Result<MatchOutcome> {
    Ok(match (rule.kind, ip) {
        (Match::IpCidr, Some(ip)) => {
            if rule.value.parse::<IpNet>()?.contains(&ip) {
                MatchOutcome::Matched
            } else {
                MatchOutcome::NoMatch
            }
        }
        (Match::Domain, None) => {
            if host == rule.value {
                MatchOutcome::Matched
            } else {
                MatchOutcome::NoMatch
            }
        }
        (Match::DomainSuffix, None) => {
            if host == rule.value
                || host
                    .strip_suffix(&rule.value)
                    .is_some_and(|prefix| prefix.ends_with('.'))
            {
                MatchOutcome::Matched
            } else {
                MatchOutcome::NoMatch
            }
        }
        (Match::DomainKeyword, None) => {
            if host.contains(&rule.value) {
                MatchOutcome::Matched
            } else {
                MatchOutcome::NoMatch
            }
        }
        (Match::GeoIp, Some(ip)) if rule.value == "private" => {
            if is_private_ip(ip) {
                MatchOutcome::Matched
            } else {
                MatchOutcome::NoMatch
            }
        }
        (Match::GeoIp | Match::GeoSite | Match::RuleSet | Match::Protocol | Match::ProcessName, _) => {
            MatchOutcome::DynamicSkipped
        }
        (Match::Port, _) => match port {
            Some(p) => {
                let ranges = parse_port_spec(&rule.value)?;
                if ranges.iter().any(|(start, end)| p >= *start && p <= *end) {
                    MatchOutcome::Matched
                } else {
                    MatchOutcome::NoMatch
                }
            }
            None => MatchOutcome::DynamicSkipped,
        },
        _ => MatchOutcome::NoMatch,
    })
}
