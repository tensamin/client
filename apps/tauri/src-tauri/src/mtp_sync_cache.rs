use std::{io::Read, path::PathBuf};

use mtp::crypto::{derive_encryption_key, sha256, AeadDecrypt, AeadEncrypt, ChaCha20Poly1305};
use serde::{Deserialize, Serialize};
use tau_relay_protocol::sync::{Record, Scope};
use zeroize::Zeroizing;

use crate::mtp_backend::MtpConfig;
mod journal;
pub(crate) use journal::AccountSyncJournal;
pub(crate) const DEVICE_ID_FILE: &str = "sync-device-id";

const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub scope: Scope,
    pub head: i64,
    pub records: Vec<Record>,
}

pub(crate) struct AccountSyncCache {
    path: PathBuf,
    cipher: ChaCha20Poly1305,
    binding: Vec<u8>,
    user_id: u64,
    device_id: String,
}

impl AccountSyncCache {
    pub fn new(directory: PathBuf, config: &MtpConfig, device_id: String) -> Result<Self, String> {
        let credential =
            Zeroizing::new(crate::mtp_backend::decode_browser_base64(&config.keyring)?);
        let credential_hash = sha256(&credential);
        let binding = serde_json::to_vec(&(
            "tensamin-account-sync-cache:v1",
            config.user_id,
            &config.omega_url,
            &device_id,
            credential_hash,
        ))
        .map_err(|error| error.to_string())?;
        let key = derive_encryption_key(&credential, b"tensamin-account-sync-cache:v1", &binding);
        let cipher = ChaCha20Poly1305::new(key.map_err(|error| error.to_string())?);
        let name = sha256(&binding)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(Self {
            path: directory.join(format!("account-sync-v2-{name}.bin")),
            cipher,
            binding,
            user_id: config.user_id,
            device_id,
        })
    }

    fn matches(&self, snapshot: &Snapshot) -> bool {
        snapshot.scope.validate()
            && snapshot.head >= 0
            && snapshot.scope.principal.user_id == self.user_id
            && snapshot.scope.device_id == self.device_id
            && snapshot.records.len() <= 100_000
    }

    pub fn load(&self) -> Result<Option<Snapshot>, String> {
        let file = match std::fs::File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let mut encrypted = Vec::new();
        file.take((MAX_SNAPSHOT_BYTES + 65) as u64)
            .read_to_end(&mut encrypted)
            .map_err(|error| error.to_string())?;
        if encrypted.len() > MAX_SNAPSHOT_BYTES + 64 {
            return Err("Account snapshot exceeds capacity".into());
        }
        let plaintext = Zeroizing::new(
            self.cipher
                .decrypt(&encrypted, &self.binding)
                .map_err(|error| error.to_string())?,
        );
        let snapshot =
            serde_json::from_slice::<Snapshot>(&plaintext).map_err(|error| error.to_string())?;
        if !self.matches(&snapshot) {
            return Err("Account snapshot does not match the active credential".into());
        }
        Ok(Some(snapshot))
    }
}
