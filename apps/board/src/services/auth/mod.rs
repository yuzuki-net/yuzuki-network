use std::sync::Arc;

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::http::{HeaderMap, HeaderValue, header};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, Utc};
use sea_orm::{
    AccessMode, ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    IsolationLevel, QueryFilter, QuerySelect, Set, TransactionTrait,
};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use uuid::Uuid;

pub mod profile;
pub mod sessions;

use crate::{
    infra::error::{Error, Result, problem},
    infra::postgres::entities::{account, session},
    services::{access, accounts},
};

const SESSION_SECONDS: i64 = 12 * 60 * 60;

pub struct IssuedToken {
    pub value: String,
    pub digest: String,
}

pub fn issue_token() -> IssuedToken {
    let value = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let digest = format!("{:x}", Sha256::digest(value.as_bytes()));
    IssuedToken { value, digest }
}

pub fn token_hash(value: &str) -> Option<String> {
    valid_token(value).then(|| format!("{:x}", Sha256::digest(value.as_bytes())))
}

pub(crate) fn valid_token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

pub fn bearer_hash(headers: &HeaderMap) -> Option<String> {
    let (scheme, token) = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return None;
    }
    token_hash(token)
}

pub struct Auth {
    secure: bool,
    dummy_hash: String,
    workers: Arc<Semaphore>,
}

pub struct SignedIn {
    pub cookie: HeaderValue,
    pub admin_workspace: bool,
}

#[derive(Clone)]
pub struct Session {
    pub account: account::Model,
    pub access: access::Access,
    token_hash: String,
    pub id: Uuid,
}

impl Auth {
    pub async fn new(secure: bool) -> Result<Self> {
        let mut auth = Self {
            secure,
            dummy_hash: String::new(),
            workers: Arc::new(Semaphore::new(4)),
        };
        auth.dummy_hash = auth.hash_password(issue_token().value).await?;
        Ok(auth)
    }

    pub async fn hash_password(&self, password: String) -> Result<String> {
        if !(12..=256).contains(&password.len()) {
            return Err(Error::BadRequest(problem::PASSWORD_LENGTH));
        }
        self.password_work(move || {
            let salt = SaltString::encode_b64(&rand::random::<[u8; 16]>())?;
            Ok(Argon2::default()
                .hash_password(password.as_bytes(), &salt)?
                .to_string())
        })
        .await
    }

    pub async fn verify_password(&self, hash: String, password: String) -> Result<bool> {
        if password.len() > 256 {
            return Ok(false);
        }
        self.password_work(move || {
            let parsed = PasswordHash::new(&hash)?;
            Ok(Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok())
        })
        .await
    }

    pub async fn sign_in(
        &self,
        db: &DatabaseConnection,
        email: String,
        password: String,
        user_agent: Option<&str>,
    ) -> Result<SignedIn> {
        if password.len() > 256 {
            return Err(Error::Unauthorized);
        }
        let account = match accounts::normalize_email(&email) {
            Ok(email) => accounts::by_email(db, &email).await?,
            Err(_) => None,
        };
        let hash = account
            .as_ref()
            .map_or(&self.dummy_hash, |row| &row.password_hash)
            .clone();
        let verified = self.verify_password(hash, password).await?;
        let row = account
            .filter(|row| verified && row.active)
            .ok_or(Error::Unauthorized)?;

        // Serialize session issuance with account suspension.
        let tx = db.begin().await?;
        let locked = account::Entity::find_by_id(row.id)
            .lock_exclusive()
            .one(&tx)
            .await?
            .filter(|current| current.active && current.password_hash == row.password_hash)
            .ok_or(Error::Unauthorized)?;
        let admin_workspace = access::permissions_for(&tx, &locked)
            .await?
            .can_open_admin();
        let token = issue_token();
        let now = Utc::now();
        session::ActiveModel {
            token_hash: Set(token.digest),
            id: Set(Uuid::new_v4()),
            account_id: Set(row.id),
            expires_at: Set(now + Duration::seconds(SESSION_SECONDS)),
            created_at: Set(now),
            last_seen_at: Set(now),
            user_agent: Set(user_agent
                .unwrap_or_default()
                .chars()
                .filter(|ch| !ch.is_control())
                .take(240)
                .collect()),
        }
        .insert(&tx)
        .await?;
        tx.commit().await?;
        Ok(SignedIn {
            cookie: self.cookie(&token.value, SESSION_SECONDS),
            admin_workspace,
        })
    }

    pub async fn session(&self, db: &DatabaseConnection, headers: &HeaderMap) -> Result<Session> {
        let token_hash = self.cookie_digest(headers).ok_or(Error::NotFound)?;
        let tx = db
            .begin_with_config(
                Some(IsolationLevel::RepeatableRead),
                Some(AccessMode::ReadOnly),
            )
            .await?;
        let now = Utc::now();
        let (row, account) = active_session(&tx, &token_hash, now)
            .await?
            .ok_or(Error::NotFound)?;
        let access = access::permissions_for(&tx, &account).await?;
        tx.commit().await?;
        let cutoff = now - Duration::minutes(1);
        if row.last_seen_at < cutoff
            && let Err(error) = sessions::touch(db, row.id, now, cutoff).await
        {
            tracing::warn!(?error, "Could not record console session activity");
        }
        Ok(Session {
            account,
            access,
            token_hash,
            id: row.id,
        })
    }

    pub async fn sign_out(&self, db: &DatabaseConnection, session: Session) -> Result<HeaderValue> {
        session::Entity::delete_by_id(session.token_hash)
            .exec(db)
            .await?;
        Ok(self.cookie("", 0))
    }

    pub async fn purge_sessions(db: &DatabaseConnection) -> Result<()> {
        session::Entity::delete_many()
            .filter(session::Column::ExpiresAt.lte(Utc::now()))
            .exec(db)
            .await?;
        Ok(())
    }

    fn cookie_digest(&self, headers: &HeaderMap) -> Option<String> {
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|header| header.to_str().ok())
            .flat_map(|header| header.split(';'))
            .filter_map(|part| part.trim().split_once('='))
            .find(|(name, _)| *name == self.cookie_name())
            .and_then(|(_, token)| token_hash(token))
    }

    fn cookie_name(&self) -> &str {
        if self.secure {
            "__Host-site_session"
        } else {
            "site_session"
        }
    }

    fn cookie(&self, value: &str, max_age: i64) -> HeaderValue {
        let secure = if self.secure { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}",
            self.cookie_name()
        ))
        .expect("issued cookie uses ASCII-only characters")
    }

    async fn password_work<T, F>(&self, task: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T> + Send + 'static,
    {
        let permit = self
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            task()
        })
        .await
        .map_err(|error| Error::Internal(error.into()))?
    }
}

async fn active_session(
    db: &impl ConnectionTrait,
    digest: &str,
    now: chrono::DateTime<Utc>,
) -> Result<Option<(session::Model, account::Model)>> {
    Ok(session::Entity::find_by_id(digest)
        .filter(session::Column::ExpiresAt.gt(now))
        .find_also_related(account::Entity)
        .filter(account::Column::Active.eq(true))
        .one(db)
        .await?
        .and_then(|(session, account)| account.map(|account| (session, account))))
}

impl From<argon2::password_hash::Error> for Error {
    fn from(error: argon2::password_hash::Error) -> Self {
        Self::Internal(error.into())
    }
}
