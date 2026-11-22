use chrono::{DateTime, Utc};
use rcgen::{
    CertificateParams, CertificateSigningRequestParams, DnType, ExtendedKeyUsagePurpose, Issuer,
    KeyPair, KeyUsagePurpose,
};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;
use yuzuki_protocol::v1::SignedIdentity;

use crate::{
    infra::error::{Error, Result, problem},
    services::nodes::sessions::Identity,
};

pub struct Signer(Issuer<'static, KeyPair>);

impl Signer {
    pub fn new(certificate: &str, key: &str) -> anyhow::Result<Self> {
        Ok(Self(Issuer::from_ca_cert_pem(
            certificate,
            KeyPair::from_pem(key)?,
        )?))
    }

    pub fn issue(&self, request: &str) -> Result<(Identity, SignedIdentity)> {
        let mut csr = CertificateSigningRequestParams::from_pem(request)
            .map_err(|_| Error::BadRequest(problem::NODE_CERT_REQUEST))?;
        let now = OffsetDateTime::now_utc();
        let expires = now + Duration::hours(24);
        let serial = Uuid::new_v4();
        let mut params = CertificateParams::default();
        params
            .distinguished_name
            .push(DnType::CommonName, format!("yuzuki-node-{serial}"));
        params.not_before = now - Duration::minutes(1);
        params.not_after = expires;
        params.serial_number = Some(serial.as_bytes().to_vec().into());
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        csr.params = params;
        let cert = csr
            .signed_by(&self.0)
            .map_err(|error| Error::Internal(error.into()))?;
        let fingerprint = format!("{:x}", Sha256::digest(cert.der().as_ref()));
        let expires_unix = expires.unix_timestamp();
        let expires_at = DateTime::<Utc>::from_timestamp(expires_unix, 0)
            .ok_or_else(|| Error::Internal(anyhow::anyhow!("invalid certificate expiry")))?;
        Ok((
            Identity {
                fingerprint,
                expires_at,
            },
            SignedIdentity {
                certificate_pem: cert.pem(),
                expires_unix,
            },
        ))
    }
}
