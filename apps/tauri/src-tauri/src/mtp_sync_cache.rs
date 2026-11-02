use std::{io::Read, path::PathBuf};

use mtp::crypto::{derive_encryption_key, sha256, AeadDecrypt, AeadEncrypt, ChaCha20Poly1305};
use serde::{Deserialize, Serialize};
use tau_relay_protocol::sync::{Record, Scope};
use zeroize::Zeroizing;

use crate::mtp_backend::MtpConfig;

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

    pub fn persist(&self, snapshot: &Snapshot) -> Result<(), String> {
        if !self.matches(snapshot) {
            return Err("Account snapshot does not match the active credential".into());
        }
        let plaintext =
            Zeroizing::new(serde_json::to_vec(snapshot).map_err(|error| error.to_string())?);
        if plaintext.len() > MAX_SNAPSHOT_BYTES {
            return Err("Account snapshot exceeds capacity".into());
        }
        let encrypted = self
            .cipher
            .encrypt(&plaintext, &self.binding)
            .map_err(|error| error.to_string())?;
        crate::native_storage::write_private_atomic(&self.path, &encrypted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn fixture() -> (PathBuf, MtpConfig, Snapshot) {
        let directory =
            std::env::temp_dir().join(format!("native-sync-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let config = MtpConfig {
            user_id: 7,
            keyring: base64::engine::general_purpose::STANDARD
                .encode(mtp::crypto::Keyring::generate().try_to_bytes().unwrap()),
            omega_url: "https://omega.invalid/".into(),
            forced_omikron_url: None,
            forced_omikron_public_key: None,
        };
        let snapshot = Snapshot {
            scope: serde_json::from_value(serde_json::json!({
                "principal": { "authority": format!("omega-key:{}", "a".repeat(64)), "user_id": 7 },
                "device_id": "device-one", "authorization_generation": 3,
                "schema": "tensamin-account-sync:v1", "dictionary": tau_relay_protocol::dictionary_fingerprint("1.1").unwrap(),
            })).unwrap(),
            head: 17,
            records: vec![Record { entity: tau_relay_protocol::sync::Entity::Setting, key: "1".into(), value: serde_json::json!({"name":"cache-private-profile"}) }],
        };
        (directory, config, snapshot)
    }

    #[test]
    fn fresh_cache_restores_one_encrypted_records_and_checkpoint_commit() {
        let (directory, config, snapshot) = fixture();
        let cache = AccountSyncCache::new(directory.clone(), &config, "device-one".into()).unwrap();
        cache.persist(&snapshot).unwrap();
        let bytes = std::fs::read(&cache.path).unwrap();
        assert!(!bytes
            .windows(b"cache-private-profile".len())
            .any(|window| window == b"cache-private-profile"));
        drop(cache);
        let restored = AccountSyncCache::new(directory.clone(), &config, "device-one".into())
            .unwrap()
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(restored.head, 17);
        assert_eq!(restored.scope, snapshot.scope);
        assert_eq!(restored.records[0].value, snapshot.records[0].value);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn identical_numeric_ids_cannot_select_another_credentials_checkpoint() {
        let (directory, config, snapshot) = fixture();
        let original =
            AccountSyncCache::new(directory.clone(), &config, "device-one".into()).unwrap();
        original.persist(&snapshot).unwrap();
        let replacement = MtpConfig {
            keyring: base64::engine::general_purpose::STANDARD
                .encode(mtp::crypto::Keyring::generate().try_to_bytes().unwrap()),
            ..config.clone()
        };
        let other =
            AccountSyncCache::new(directory.clone(), &replacement, "device-one".into()).unwrap();
        assert!(other.load().unwrap().is_none());
        std::fs::copy(&original.path, &other.path).unwrap();
        assert!(other.load().is_err());
        for (changed, device) in [
            (
                MtpConfig {
                    user_id: 8,
                    ..config.clone()
                },
                "device-one",
            ),
            (
                MtpConfig {
                    omega_url: "https://other-omega.invalid/".into(),
                    ..config.clone()
                },
                "device-one",
            ),
            (config.clone(), "device-two"),
        ] {
            let cache = AccountSyncCache::new(directory.clone(), &changed, device.into()).unwrap();
            assert!(cache.load().unwrap().is_none());
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn damaged_ciphertext_is_retained_without_publishing_a_snapshot() {
        let (directory, config, snapshot) = fixture();
        let cache = AccountSyncCache::new(directory.clone(), &config, "device-one".into()).unwrap();
        cache.persist(&snapshot).unwrap();
        let mut bytes = std::fs::read(&cache.path).unwrap();
        bytes[20] ^= 1;
        std::fs::write(&cache.path, &bytes).unwrap();
        assert!(cache.load().is_err());
        assert_eq!(std::fs::read(&cache.path).unwrap(), bytes);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_different_scope_cannot_replace_the_credential_bound_snapshot() {
        let (directory, config, mut snapshot) = fixture();
        let cache = AccountSyncCache::new(directory.clone(), &config, "device-one".into()).unwrap();
        cache.persist(&snapshot).unwrap();
        let committed = std::fs::read(&cache.path).unwrap();
        snapshot.scope.principal.user_id = 8;
        assert!(cache.persist(&snapshot).is_err());
        assert_eq!(std::fs::read(&cache.path).unwrap(), committed);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_keeps_the_previous_checkpoint_and_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (directory, config, mut snapshot) = fixture();
        let cache = AccountSyncCache::new(directory.clone(), &config, "device-one".into()).unwrap();
        cache.persist(&snapshot).unwrap();
        assert_eq!(
            std::fs::metadata(&cache.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o500)).unwrap();
        snapshot.head = 18;
        assert!(cache.persist(&snapshot).is_err());
        assert_eq!(cache.load().unwrap().unwrap().head, 17);
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
