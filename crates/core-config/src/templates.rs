//! Expand only explicit placeholders. Credentials never undergo textual interpolation.

use anyhow::{Result, ensure};
use serde_json::{Map, Value};

use crate::protocols::{ShadowsocksCipher, shadowsocks};

const ACCESS_ID: &str = "$yuzuki_access_id";
const USERS: &str = "$yuzuki_users";
const USER_MAP: &str = "$yuzuki_user_map";
const SINGLE_USER: &str = "$yuzuki_single_user";
const SHADOWSOCKS_KEY: &str = "$yuzuki_ss2022_user_key";
const MANAGED_LISTENER: &str = "$yuzuki_listener";

pub fn client(value: &Value, id: &str) -> Result<Value> {
    substitute(value, Some(id), None)
}

pub fn server(value: &Value, accounts: &[String]) -> Result<Value> {
    ensure!(value.is_object(), "server template must be an object");
    if let Some(listener) = value.get(MANAGED_LISTENER) {
        ensure!(
            value.as_object().is_some_and(|object| object.len() == 1),
            "the managed listener envelope must be the only root field"
        );
        ensure!(
            listener["version"].as_u64() == Some(1),
            "unsupported managed listener schema"
        );
        let config = &listener["config"];
        ensure!(
            config.is_object(),
            "managed listener must contain a native configuration object"
        );
        return substitute(config, None, Some(accounts));
    }
    substitute(value, None, Some(accounts))
}

pub fn has_managed_credentials(value: &Value) -> bool {
    match value {
        Value::Object(fields) => {
            (fields.len() == 1
                && [USERS, USER_MAP, SINGLE_USER]
                    .iter()
                    .any(|&key| fields.contains_key(key)))
                || fields.values().any(has_managed_credentials)
        }
        Value::Array(values) => values.iter().any(has_managed_credentials),
        _ => false,
    }
}

fn substitute(value: &Value, id: Option<&str>, accounts: Option<&[String]>) -> Result<Value> {
    match value {
        Value::String(text) if text == ACCESS_ID => Ok(Value::String(
            id.ok_or_else(|| anyhow::anyhow!("credential outside a user template"))?
                .into(),
        )),
        Value::Object(fields) if fields.len() == 1 && fields.contains_key(USERS) => {
            let accounts =
                accounts.ok_or_else(|| anyhow::anyhow!("user template outside a server config"))?;
            accounts
                .iter()
                .map(|id| substitute(&fields[USERS], Some(id), None))
                .collect()
        }
        Value::Object(fields) if fields.len() == 1 && fields.contains_key(USER_MAP) => {
            let accounts =
                accounts.ok_or_else(|| anyhow::anyhow!("user map outside a server config"))?;
            let users = accounts
                .iter()
                .map(|id| Ok((id.clone(), substitute(&fields[USER_MAP], Some(id), None)?)))
                .collect::<Result<Map<String, Value>>>()?;
            Ok(Value::Object(users))
        }
        Value::Object(fields) if fields.len() == 1 && fields.contains_key(SHADOWSOCKS_KEY) => {
            let id =
                id.ok_or_else(|| anyhow::anyhow!("Shadowsocks key outside a user template"))?;
            let cipher: ShadowsocksCipher =
                serde_json::from_value(fields[SHADOWSOCKS_KEY].clone())?;
            Ok(Value::String(shadowsocks::user_key(cipher, id)?))
        }
        Value::Object(fields) if fields.len() == 1 && fields.contains_key(SINGLE_USER) => {
            let accounts = accounts
                .ok_or_else(|| anyhow::anyhow!("single user template outside a server config"))?;
            ensure!(
                accounts.len() == 1,
                "single user template requires exactly one entitled account"
            );
            substitute(&fields[SINGLE_USER], Some(&accounts[0]), None)
        }
        Value::Object(fields) => {
            let mapped = fields
                .iter()
                .map(|(name, value)| Ok((name.clone(), substitute(value, id, accounts)?)))
                .collect::<Result<Map<String, Value>>>()?;
            Ok(Value::Object(mapped))
        }
        Value::Array(values) => Ok(Value::Array(
            values
                .iter()
                .map(|value| substitute(value, id, accounts))
                .collect::<Result<_>>()?,
        )),
        _ => Ok(value.clone()),
    }
}
