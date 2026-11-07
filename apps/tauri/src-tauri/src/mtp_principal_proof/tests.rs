use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use iota_identity::{PrincipalDescriptor, SignedPrincipalDescriptor};
use mtp::crypto::Keyring;
use serde_json::{json, Value};

pub(crate) fn signed_proof(
    revision: i64,
    authority: &Keyring,
    home: &Keyring,
    user: &Keyring,
) -> (Principal, String, String) {
    let authority_id = AuthorityId::for_omega(&authority.public_key_bundle()).unwrap();
    let principal = Principal::new(authority_id.as_str().to_owned(), 42).unwrap();
    let descriptor = PrincipalDescriptor {
        principal: PrincipalId::try_from(principal.clone()).unwrap(),
        authority_kind: AuthorityKind::Omega,
        username: Some("alice".into()),
        display_name: Some("Alice 雪".into()),
        public_keys: vec![user.public_key_bundle()],
        home: PrincipalHome::Iota(IotaNodeId::from_public_keys(&home.public_key_bundle()).unwrap()),
        revision,
        valid_until: Some(500),
        issued_at: 100,
    };
    let proof = PrincipalProofV1 {
        descriptor: SignedPrincipalDescriptor::sign(descriptor, authority)
            .unwrap()
            .to_wire_v1()
            .unwrap(),
        authority_public_key: authority.public_key_bundle().try_to_base64().unwrap(),
    };
    (
        principal,
        serde_json::to_string(&proof).unwrap(),
        home.public_key_bundle().try_to_base64().unwrap(),
    )
}

#[test]
fn verifies_the_same_original_rust_fixture_as_the_browser_at_the_i64_boundary() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../packages/crypto/src/fixtures/principal-proof-rust.json"
    ))
    .unwrap();
    let principal: Principal =
        serde_json::from_value(fixture["proof"]["descriptor"]["principal"].clone()).unwrap();
    assert_eq!(principal.user_id, i64::MAX as u64);
    let home = fixture["home_public_key"].as_str().unwrap();
    let proof = fixture["proof"].to_string();
    let (revision, keys) = verify(&proof, &principal, home, Some(4), 200).unwrap();
    assert_eq!(revision, 4);
    assert_eq!(keys.len(), 2);
    for (minimum, now) in [(Some(5), 200), (None, 99), (None, 500)] {
        assert!(verify(&proof, &principal, home, minimum, now).is_err());
    }
}

#[test]
fn rejects_untrusted_authorities_home_substitutions_and_both_damaged_signature_halves() {
    let authority = Keyring::generate();
    let home = Keyring::generate();
    let user = Keyring::generate();
    let (principal, proof, home_key) = signed_proof(2, &authority, &home, &user);
    assert!(verify(
        &proof,
        &principal,
        &authority.public_key_bundle().try_to_base64().unwrap(),
        None,
        200
    )
    .is_err());
    let mut other = principal.clone();
    other.user_id += 1;
    assert!(verify(&proof, &other, &home_key, None, 200).is_err());
    let mut forged: Value = serde_json::from_str(&proof).unwrap();
    forged["authority_public_key"] = json!(user.public_key_bundle().try_to_base64().unwrap());
    assert!(verify(&forged.to_string(), &principal, &home_key, None, 200).is_err());
    let original: Value = serde_json::from_str(&proof).unwrap();
    let signature = STANDARD
        .decode(
            original["descriptor"]["authority_signature"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    for offset in [0, 64] {
        let mut damaged = signature.clone();
        damaged[offset] ^= 1;
        let mut changed = original.clone();
        changed["descriptor"]["authority_signature"] = json!(STANDARD.encode(damaged));
        assert!(verify(&changed.to_string(), &principal, &home_key, None, 200).is_err());
    }
    let mut changed = original;
    changed["descriptor"]["display_name"] = json!("Mallory");
    assert!(verify(&changed.to_string(), &principal, &home_key, None, 200).is_err());
}

#[test]
fn iota_authority_must_be_the_home_signer_and_omega_proofs_must_expire() {
    let authority = Keyring::generate();
    let home = Keyring::generate();
    let user = Keyring::generate();
    let (_, proof, _) = signed_proof(1, &authority, &home, &user);
    let mut proof: PrincipalProofV1 = serde_json::from_str(&proof).unwrap();
    let mut descriptor = proof.descriptor.parse().unwrap().descriptor;
    let node = IotaNodeId::from_public_keys(&authority.public_key_bundle()).unwrap();
    let principal = Principal::new(AuthorityId::for_iota(&node).as_str().to_owned(), 42).unwrap();
    descriptor.principal = PrincipalId::try_from(principal.clone()).unwrap();
    descriptor.authority_kind = AuthorityKind::Iota;
    descriptor.home = PrincipalHome::Iota(node);
    descriptor.valid_until = None;
    proof.descriptor = SignedPrincipalDescriptor::sign(descriptor.clone(), &authority)
        .unwrap()
        .to_wire_v1()
        .unwrap();
    let home_key = authority.public_key_bundle().try_to_base64().unwrap();
    verify(
        &serde_json::to_string(&proof).unwrap(),
        &principal,
        &home_key,
        None,
        200,
    )
    .unwrap();
    descriptor.home =
        PrincipalHome::Iota(IotaNodeId::from_public_keys(&home.public_key_bundle()).unwrap());
    proof.descriptor = SignedPrincipalDescriptor::sign(descriptor, &authority)
        .unwrap()
        .to_wire_v1()
        .unwrap();
    assert!(verify(
        &serde_json::to_string(&proof).unwrap(),
        &principal,
        &home.public_key_bundle().try_to_base64().unwrap(),
        None,
        200
    )
    .is_err());
    let (principal, json, home_key) = signed_proof(1, &authority, &home, &user);
    let mut proof: PrincipalProofV1 = serde_json::from_str(&json).unwrap();
    let mut descriptor = proof.descriptor.parse().unwrap().descriptor;
    descriptor.valid_until = None;
    proof.descriptor = SignedPrincipalDescriptor::sign(descriptor, &authority)
        .unwrap()
        .to_wire_v1()
        .unwrap();
    assert!(verify(
        &serde_json::to_string(&proof).unwrap(),
        &principal,
        &home_key,
        None,
        200
    )
    .is_err());
}

#[test]
fn refuses_oversized_or_unrecognized_documents_without_echoing_protocol_payloads() {
    let principal = Principal::new(format!("omega-key:{}", "a".repeat(64)), 7).unwrap();
    assert!(verify(&" ".repeat(256 * 1024 + 1), &principal, "", None, 200).is_err());
    let error = verify(
        "{\"secret-protocol-field\":\"private-profile\"}",
        &principal,
        "",
        None,
        200,
    )
    .unwrap_err();
    assert!(!error.contains("secret-protocol-field"));
    assert!(!error.contains("private-profile"));
}
