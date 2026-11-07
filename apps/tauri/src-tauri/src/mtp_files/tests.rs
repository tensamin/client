use super::*;
use mtp::crypto::{DualSigner, Keyring, SignatureScheme};

pub(crate) fn grant_fixture(
    account: &Principal,
) -> (FileEvent, FileEvent, iota_identity::FileSigningKeyProofV1) {
    let authority = Keyring::generate();
    let signer = Keyring::generate();
    let author = Principal::new(
        iota_identity::AuthorityId::for_omega(&authority.public_key_bundle())
            .unwrap()
            .as_str()
            .to_owned(),
        9,
    )
    .unwrap();
    let key = FileKey {
        origin: author.clone(),
        file_id: "file-one".into(),
        version: 1,
    };
    let signing_public_key = signer.public_key_bundle().try_to_base64().unwrap();
    let dual = DualSigner::new(
        &signer.sig_cl_secret_key,
        &signer.sig_pq_secret_key,
        &signer.sig_pq_public_key,
    )
    .unwrap();
    let mut offer = ShareOffer {
        manifest: FileManifest {
            key: key.clone(),
            ciphertext_sha256: vec![0; 32],
            ciphertext_size: 65576,
            crypto_format: "tensamin-file-chunks-v1".into(),
            manifest_ciphertext: vec![0; 41],
            envelope: KeyEnvelope {
                recipient: account.clone(),
                key_id: "recipient-key".into(),
                wrapping_scheme: "tensamin-file-dek-kem-v1".into(),
                kem_ciphertext: vec![1],
                encrypted_dek: vec![0; 72],
            },
        },
        chat_id: tau_relay_protocol::canonical_chat_id(&author, account),
        grant_revision: 1,
        expires_at: 1,
        signing_public_key: signing_public_key.clone(),
        signature: vec![],
    };
    offer.signature = dual.sign(&offer.signing_bytes()).unwrap();
    let mut revoke = ShareRevoke {
        key,
        recipient: account.clone(),
        chat_id: offer.chat_id.clone(),
        grant_revision: 2,
        signing_public_key,
        signature: vec![],
    };
    revoke.signature = dual.sign(&revoke.signing_bytes()).unwrap();
    let proof = iota_identity::FileSigningKeyProofV1::sign(
        iota_identity::PrincipalId::try_from(author).unwrap(),
        iota_identity::AuthorityKind::Omega,
        &signer.public_key_bundle(),
        &authority,
    )
    .unwrap();
    (
        FileEvent {
            sequence: 1,
            kind: "share_offered".into(),
            payload: serde_json::to_value(offer).unwrap(),
        },
        FileEvent {
            sequence: 2,
            kind: "share_revoked".into(),
            payload: serde_json::to_value(revoke).unwrap(),
        },
        proof,
    )
}

#[test]
fn replay_authenticates_historical_grants_and_both_signature_halves_without_current_key_fallback() {
    let account = Principal::new(format!("omega-key:{}", "a".repeat(64)), 7).unwrap();
    let (offer, revoke, proof) = grant_fixture(&account);
    for event in [&offer, &revoke] {
        let grant = event.grant().unwrap().unwrap();
        grant.validate(&account).unwrap();
        grant.verify(&proof).unwrap();
    }
    let original: ShareOffer = payload(&offer.payload).unwrap();
    for offset in [0, 64] {
        let mut damaged = original.clone();
        damaged.signature[offset] ^= 1;
        assert!(Grant::Offer(damaged).verify(&proof).is_err());
    }
    let mut changed = original.clone();
    changed.manifest.key.version = 2;
    assert!(Grant::Offer(changed).verify(&proof).is_err());
    let mut changed = proof.clone();
    changed.principal.user_id += 1;
    assert!(Grant::Offer(original).verify(&changed).is_err());
    let another = Principal::new(account.authority.clone(), 8).unwrap();
    assert!(offer.resource(&another).is_err());
    let mut substituted = revoke;
    substituted.payload["chat_id"] = json!("wrong-conversation");
    assert!(substituted.resource(&account).is_err());
}

#[test]
fn file_events_reject_unknown_or_malformed_resources_and_cross_account_manifests() {
    let account = Principal::new(format!("omega-key:{}", "a".repeat(64)), 7).unwrap();
    let mut event = FileEvent {
        sequence: 1,
        kind: "folder".into(),
        payload: json!({"folder_id":"private-one","parent_folder_id":"private","encrypted_name":[1,2,3],"revision":1}),
    };
    assert!(event.resource(&account).is_ok());
    event.payload["unexpected"] = json!("untrusted");
    assert!(event.resource(&account).is_err());
    event.kind = "unknown".into();
    assert!(event.resource(&account).is_err());
    let (offer, _, _) = grant_fixture(&account);
    let manifest: ShareOffer = payload(&offer.payload).unwrap();
    let mut event = FileEvent {
        sequence: 1,
        kind: "version".into(),
        payload: serde_json::to_value(manifest.manifest).unwrap(),
    };
    event.resource(&account).unwrap();
    event.payload["envelope"]["recipient"]["user_id"] = json!(8);
    assert!(event.resource(&account).is_err());
    let invalid = FileEvent {
        sequence: 1,
        kind: "placement".into(),
        payload: json!({"placement_id":"p","origin":account,"file_id":"f","folder_id":"chat:principal:!","hidden":true,"revision":1,"encrypted_metadata":[]}),
    };
    assert!(invalid.resource(&account).is_err());
}
