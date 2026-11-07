use iota_identity::{
    AuthorityId, AuthorityKind, IotaNodeId, PrincipalHome, PrincipalId, PrincipalProofV1,
};
use mtp::crypto::PublicKeyBundle;
use tau_relay_protocol::Principal;

#[cfg(test)]
pub(crate) mod tests;

fn bundle(text: &str) -> Result<PublicKeyBundle, String> {
    let key =
        PublicKeyBundle::from_base64(text).map_err(|_| "Invalid identity public-key encoding")?;
    key.validate().map_err(|_| "Invalid identity public key")?;
    if key
        .try_to_base64()
        .map_err(|_| "Unsupported identity public key")?
        != text
    {
        return Err("Noncanonical identity public key".into());
    }
    Ok(key)
}

pub(crate) fn verify(
    json: &str,
    principal: &Principal,
    home_public_key: &str,
    minimum_revision: Option<i64>,
    now: i64,
) -> Result<(i64, Vec<PublicKeyBundle>), String> {
    if json.len() > 256 * 1024 {
        return Err("Identity proof exceeds its byte limit".into());
    }
    let proof: PrincipalProofV1 =
        serde_json::from_str(json).map_err(|_| "Invalid authority proof document")?;
    let authority_key = bundle(&proof.authority_public_key)?;
    let authority = match proof.descriptor.authority_kind {
        AuthorityKind::Omega => {
            AuthorityId::for_omega(&authority_key).map_err(|error| error.to_string())?
        }
        AuthorityKind::Iota => AuthorityId::for_iota(
            &IotaNodeId::from_public_keys(&authority_key).map_err(|error| error.to_string())?,
        ),
    };
    let expected =
        PrincipalId::try_from(principal.clone()).map_err(|_| "Invalid canonical principal")?;
    let descriptor = &proof.descriptor;
    if descriptor.principal != expected
        || expected.authority != authority
        || descriptor.revision < 1
        || descriptor.revision < minimum_revision.unwrap_or(1)
        || descriptor.issued_at < 0
        || descriptor.issued_at > now
        || descriptor
            .valid_until
            .is_some_and(|expiry| expiry <= now || expiry <= descriptor.issued_at)
        || descriptor.authority_kind == AuthorityKind::Omega && descriptor.valid_until.is_none()
    {
        return Err(
            "Identity proof does not match the trusted principal or freshness bounds".into(),
        );
    }
    for key in &descriptor.public_keys {
        bundle(key)?;
    }
    let home_key = bundle(home_public_key)?;
    let home = IotaNodeId::from_public_keys(&home_key).map_err(|error| error.to_string())?;
    if descriptor.home != PrincipalHome::Iota(home) {
        return Err("Identity proof does not bind the supplied home key".into());
    }
    let verified = proof
        .descriptor
        .parse()
        .map_err(|_| "Invalid principal descriptor encoding")?
        .verify(&authority, &authority_key, minimum_revision, now)
        .map_err(|_| "Principal authority verification failed")?;
    let descriptor = verified.into_descriptor();
    Ok((descriptor.revision, descriptor.public_keys))
}
