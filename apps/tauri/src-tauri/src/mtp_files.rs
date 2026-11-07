use mtp::codec::{CommunicationType, CommunicationValue, DataType, DataValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tau_relay_protocol::{files::*, sync::Scope, Principal};
use tauri_plugin_mtp::Session;

#[cfg(test)]
pub(crate) mod tests;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Checkpoint {
    pub after: i64,
    pub upper: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FileEvent {
    pub sequence: i64,
    pub kind: String,
    pub payload: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    events: Vec<FileEvent>,
    next: i64,
    upper: i64,
    more: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    manifest: FileManifest,
    metadata_revision: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeletedFile {
    origin: Principal,
    file_id: String,
}

pub(crate) enum Grant {
    Offer(ShareOffer),
    Revoke(ShareRevoke),
}

impl Grant {
    pub fn key(&self) -> &FileKey {
        match self {
            Self::Offer(offer) => &offer.manifest.key,
            Self::Revoke(revoke) => &revoke.key,
        }
    }
    pub fn recipient(&self) -> &Principal {
        match self {
            Self::Offer(offer) => &offer.manifest.envelope.recipient,
            Self::Revoke(revoke) => &revoke.recipient,
        }
    }
    pub fn revision(&self) -> i64 {
        match self {
            Self::Offer(offer) => offer.grant_revision,
            Self::Revoke(revoke) => revoke.grant_revision,
        }
    }
    fn signer_key(&self) -> &str {
        match self {
            Self::Offer(offer) => &offer.signing_public_key,
            Self::Revoke(revoke) => &revoke.signing_public_key,
        }
    }
    fn chat_id(&self) -> &str {
        match self {
            Self::Offer(offer) => &offer.chat_id,
            Self::Revoke(revoke) => &revoke.chat_id,
        }
    }

    fn validate(&self, account: &Principal) -> Result<(), String> {
        self.key()
            .validate()
            .map_err(|_| "Invalid file grant key")?;
        self.recipient()
            .validate()
            .map_err(|_| "Invalid file grant recipient")?;
        if self.revision() < 1
            || self.chat_id()
                != tau_relay_protocol::canonical_chat_id(&self.key().origin, self.recipient())
            || self.key().origin == *self.recipient()
            || self.key().origin != *account && self.recipient() != account
        {
            return Err("File grant is outside this account or conversation".into());
        }
        if let Self::Offer(offer) = self {
            offer
                .manifest
                .validate()
                .map_err(|_| "Invalid offered file manifest")?;
            // Historical replay authenticates expired offers. Access checks
            // separately enforce expiry and the latest revocation fence.
            if offer.expires_at < 1 {
                return Err("Invalid file grant expiry".into());
            }
        }
        Ok(())
    }

    fn verify(&self, proof: &iota_identity::FileSigningKeyProofV1) -> Result<(), String> {
        let claimed = mtp::crypto::PublicKeyBundle::from_base64(self.signer_key())
            .map_err(|_| "Invalid file grant signer")?;
        let key_id = iota_identity::file_signing_key_id(&claimed)
            .map_err(|_| "Invalid file grant signer")?;
        let principal = iota_identity::PrincipalId::try_from(self.key().origin.clone())
            .map_err(|_| "Invalid file grant author")?;
        let key = proof
            .verify_file_key(&principal, &key_id)
            .map_err(|_| "File grant authority proof failed")?;
        if key
            .try_to_base64()
            .map_err(|_| "Invalid file grant signer")?
            != self.signer_key()
        {
            return Err("File grant signer differs from its historical proof".into());
        }
        let (bytes, signature) = match self {
            Self::Offer(offer) => (offer.signing_bytes(), &offer.signature),
            Self::Revoke(revoke) => (revoke.signing_bytes(), &revoke.signature),
        };
        iota_identity::verify_dual_signature(&key, &bytes, signature)
            .map_err(|_| "File grant signature failed".into())
    }
}

fn payload<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|_| "Invalid file journal payload".into())
}

impl FileEvent {
    pub fn grant(&self) -> Result<Option<Grant>, String> {
        match self.kind.as_str() {
            "share_offered" => payload(&self.payload).map(Grant::Offer).map(Some),
            "share_revoked" => payload(&self.payload).map(Grant::Revoke).map(Some),
            _ => Ok(None),
        }
    }

    pub fn resource(&self, account: &Principal) -> Result<String, String> {
        if self.sequence < 1 {
            return Err("Invalid file journal sequence".into());
        }
        let resource = if let Some(grant) = self.grant()? {
            grant.validate(account)?;
            json!(["grant", grant.key(), grant.recipient(), grant.chat_id()])
        } else {
            match self.kind.as_str() {
                "folder" => {
                    let folder: Folder = payload(&self.payload)?;
                    if !valid_id(&folder.folder_id)
                        || !valid_id(&folder.parent_folder_id)
                        || folder.revision < 1
                        || folder.encrypted_name.len() > MAX_METADATA_BYTES
                    {
                        return Err("Invalid file folder".into());
                    }
                    json!(["folder", folder.folder_id])
                }
                "folder_deleted" | "placement_deleted" => {
                    let deleted: DeleteEntry = payload(&self.payload)?;
                    if !valid_id(&deleted.id) || deleted.expected_revision < 1 {
                        return Err("Invalid deleted file entry".into());
                    }
                    json!([
                        if self.kind == "folder_deleted" {
                            "folder"
                        } else {
                            "placement"
                        },
                        deleted.id
                    ])
                }
                "placement" => {
                    let placement: Placement = payload(&self.payload)?;
                    placement
                        .origin
                        .validate()
                        .map_err(|_| "Invalid file placement author")?;
                    let chat = placement
                        .folder_id
                        .strip_prefix("chat:principal:")
                        .is_some_and(|id| {
                            !id.is_empty()
                                && id.len() <= 1000
                                && id.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
                                })
                        });
                    if !valid_id(&placement.placement_id)
                        || !valid_id(&placement.file_id)
                        || placement.revision < 1
                        || !valid_id(&placement.folder_id) && !chat
                        || placement.encrypted_metadata.len() > MAX_METADATA_BYTES
                    {
                        return Err("Invalid file placement".into());
                    }
                    json!(["placement", placement.placement_id])
                }
                "version" | "key_envelope" => {
                    let manifest: FileManifest = payload(&self.payload)?;
                    manifest
                        .validate()
                        .map_err(|_| "Invalid file journal manifest")?;
                    if manifest.envelope.recipient != *account {
                        return Err("File manifest belongs to another account".into());
                    }
                    json!(["version", manifest.key])
                }
                "metadata" => {
                    let metadata: Metadata = payload(&self.payload)?;
                    metadata
                        .manifest
                        .validate()
                        .map_err(|_| "Invalid file metadata manifest")?;
                    if metadata.metadata_revision < 1
                        || metadata.manifest.envelope.recipient != *account
                    {
                        return Err("Invalid file metadata scope".into());
                    }
                    json!(["version", metadata.manifest.key])
                }
                "file_deleted" => {
                    let deleted: DeletedFile = payload(&self.payload)?;
                    deleted
                        .origin
                        .validate()
                        .map_err(|_| "Invalid deleted file author")?;
                    if !valid_id(&deleted.file_id) {
                        return Err("Invalid deleted file ID".into());
                    }
                    json!(["deleted", deleted.origin, deleted.file_id])
                }
                "replica_transferring"
                | "replica_cancelled"
                | "replica_ready"
                | "replica_failed"
                | "replica_expired" => {
                    let key: FileKey = payload(&self.payload)?;
                    key.validate().map_err(|_| "Invalid file replica key")?;
                    json!(["replica", key])
                }
                _ => return Err("Unsupported file journal event".into()),
            }
        };
        serde_json::to_string(&resource).map_err(|_| "Invalid file resource identity".into())
    }
}

async fn file_request(
    session: &Session,
    kind: CommunicationType,
    request: Value,
) -> Result<String, String> {
    let text = serde_json::to_string(&request).map_err(|_| "Invalid file request")?;
    if text.len() > MAX_CONTROL_BYTES {
        return Err("File request exceeds the control budget".into());
    }
    let map = session.connection().codec.type_map();
    let frame = CommunicationValue::new_with_type_map(kind, map)
        .add_typed_default(DataType::Json, DataValue::Str(text));
    let response = session
        .request(frame, None, crate::mtp_backend::INITIAL_SYNC_TIMEOUT)
        .await
        .map_err(|_| "File journal request failed")?;
    if response.type_map() != Some(map) || !response.is_type(kind) {
        return Err("File journal response dictionary or operation mismatch".into());
    }
    let Some([(id, DataValue::Str(text))]) = response.payload().container_entries() else {
        return Err("Invalid file journal response payload".into());
    };
    if Some(*id) != DataType::Json.try_to_id(map) || text.len() > MAX_CONTROL_BYTES {
        return Err("File journal response exceeds the control budget".into());
    }
    Ok(text.clone())
}

async fn verify_grant(session: &Session, grant: &Grant) -> Result<(), String> {
    let key = mtp::crypto::PublicKeyBundle::from_base64(grant.signer_key())
        .map_err(|_| "Invalid file grant signer")?;
    let key_id =
        iota_identity::file_signing_key_id(&key).map_err(|_| "Invalid file grant signer")?;
    let map = session.connection().codec.type_map();
    let frame = CommunicationValue::new_with_type_map(CommunicationType::UserResolve, map)
        .add_typed_default(
            DataType::UserAddress,
            DataValue::Str(
                serde_json::to_string(&grant.key().origin)
                    .map_err(|_| "Invalid file grant author")?,
            ),
        )
        .add_typed_default(
            DataType::Json,
            DataValue::Str(json!({"file_signing_key":key_id}).to_string()),
        );
    let response = session
        .request(frame, None, crate::mtp_backend::INITIAL_SYNC_TIMEOUT)
        .await
        .map_err(|_| "Historical file key lookup failed")?;
    if !response.is_type(CommunicationType::UserResolved) || response.type_map() != Some(map) {
        return Err("Historical file key evidence is unavailable".into());
    }
    let json = response
        .get_str(DataType::Json)
        .ok_or("Historical file key proof is missing")?;
    if json.len() > 256 * 1024 {
        return Err("Historical file key proof exceeds its byte limit".into());
    }
    let proof: iota_identity::FileSigningKeyProofV1 =
        serde_json::from_str(json).map_err(|_| "Invalid historical file key proof")?;
    grant.verify(&proof)
}

pub(crate) async fn synchronize(
    session: &Session,
    scope: &Scope,
    journal: &mut crate::mtp_sync_cache::AccountSyncJournal,
) -> Result<(), String> {
    static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _sync = SYNC_LOCK.lock().await;
    let mut checkpoint = journal.file_checkpoint(scope)?;
    loop {
        let text = file_request(
            session,
            CommunicationType::FileChangesGet,
            json!({"after":checkpoint.after,"upper":checkpoint.upper}),
        )
        .await?;
        let page: Page = serde_json::from_str(&text).map_err(|_| "Invalid file journal page")?;
        if page.events.len() > PAGE_SIZE
            || page.upper < checkpoint.after
            || checkpoint.upper.is_some_and(|upper| upper != page.upper)
        {
            return Err("File journal boundary changed".into());
        }
        let mut sequence = checkpoint.after;
        for event in &page.events {
            if event.sequence <= sequence || event.sequence > page.upper {
                return Err("File journal is out of order".into());
            }
            event.resource(&scope.principal)?;
            if let Some(grant) = event.grant()? {
                verify_grant(session, &grant).await?;
            }
            sequence = event.sequence;
        }
        if page.next < sequence
            || page.next > page.upper
            || page.more && (page.events.is_empty() || page.next != sequence)
            || !page.more && page.next != page.upper
        {
            return Err("File journal cursor does not match its page".into());
        }
        let next = Checkpoint {
            after: page.next,
            upper: page.more.then_some(page.upper),
        };
        journal.commit_file_page(scope, &checkpoint, &next, &page.events)?;
        checkpoint = next;
        if !page.more {
            return Ok(());
        }
    }
}

pub(crate) async fn require_committed_grant(
    session: &Session,
    scope: &Scope,
    journal: &mut crate::mtp_sync_cache::AccountSyncJournal,
    signer: &Principal,
    kind: CommunicationType,
    content: &DataValue,
) -> Result<(), String> {
    let text = crate::mtp_backend::container_value_by_name(content, "Json")
        .and_then(DataValue::as_str)
        .ok_or("File relay omitted its signed operation")?;
    if text.len() > MAX_CONTROL_BYTES {
        return Err("File relay exceeds its control budget".into());
    }
    let event = FileEvent {
        sequence: 1,
        kind: if kind == CommunicationType::FileShareOffered {
            "share_offered"
        } else {
            "share_revoked"
        }
        .into(),
        payload: serde_json::from_str(text).map_err(|_| "Invalid file relay payload")?,
    };
    event.resource(&scope.principal)?;
    let grant = event.grant()?.ok_or("File relay has no signed grant")?;
    if grant.recipient() != &scope.principal || &grant.key().origin != signer {
        return Err("File relay differs from its authenticated participants".into());
    }
    verify_grant(session, &grant).await?;
    let stored = journal
        .file_event(scope, &event.resource(&scope.principal)?)?
        .ok_or("File relay has not reached the durable journal")?;
    let committed = stored.grant()?.ok_or("Invalid committed file grant")?;
    if committed.revision() < grant.revision() {
        return Err("File relay is ahead of its durable journal".into());
    }
    if committed.revision() == grant.revision()
        && (stored.kind != event.kind || stored.payload != event.payload)
    {
        return Err("File relay conflicts with its durable signed grant".into());
    }
    Ok(())
}
