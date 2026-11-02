use std::{io::Read, path::PathBuf};

use keyring_core::api::CredentialStoreApi;
use mtp::crypto::{AeadDecrypt, AeadEncrypt, ChaCha20Poly1305};
use serde::{Deserialize, Serialize};
use tauri_plugin_mtp::lifecycle::BackgroundConnection;
use zeroize::{Zeroize, Zeroizing};

use crate::mtp_backend::{validate_config, MtpConfig};

const MAX_CREDENTIAL_BYTES: usize = 512 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredCredentials {
    version: u8,
    pub config: MtpConfig,
    pub connection: Option<BackgroundConnection>,
}

impl StoredCredentials {
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 || validate_config(self.config.clone())? != self.config {
            return Err("Stored native credential configuration is invalid".into());
        }
        if let Some(connection) = &self.connection {
            let credentials = connection
                .options
                .credentials
                .as_ref()
                .ok_or("Stored native identity has no credentials")?;
            let expected = Zeroizing::new(crate::mtp_backend::decode_browser_base64(
                &self.config.keyring,
            )?);
            if connection.name != crate::mtp_plugin::CONNECTION_NAME
                || connection.options.fresh
                || credentials.client_id.as_deref()
                    != Some(self.config.user_id.to_string().as_str())
                || credentials.keyring.as_slice() != expected.as_slice()
                || connection
                    .options
                    .host_public_key
                    .as_ref()
                    .or(credentials.host_public_key.as_ref())
                    .is_none()
            {
                return Err("Stored native identity does not match its account".into());
            }
            let endpoint = reqwest::Url::parse(&connection.options.url)
                .map_err(|_| "Stored native endpoint is invalid")?;
            if endpoint.scheme() != "https"
                || endpoint.host_str().is_none()
                || !endpoint.username().is_empty()
                || endpoint.password().is_some()
            {
                return Err("Stored native endpoint is invalid".into());
            }
        }
        Ok(())
    }
}

fn wipe_connection(connection: &mut BackgroundConnection) {
    if let Some(credentials) = &mut connection.options.credentials {
        credentials.keyring.zeroize();
    }
}

impl Drop for StoredCredentials {
    fn drop(&mut self) {
        self.config.keyring.zeroize();
        if let Some(connection) = &mut self.connection {
            wipe_connection(connection);
        }
    }
}

struct CredentialStore {
    service: String,
    path: PathBuf,
    _lock: std::fs::File,
}

fn master_entry(service: &str) -> Result<keyring_core::Entry, String> {
    #[cfg(target_os = "macos")]
    let store = apple_native_keyring_store::keychain::Store::new();
    #[cfg(target_os = "ios")]
    let store = apple_native_keyring_store::protected::Store::new();
    #[cfg(windows)]
    let store = windows_native_keyring_store::Store::new();
    #[cfg(all(unix, not(any(target_os = "macos", target_os = "ios"))))]
    let store = zbus_secret_service_keyring_store::Store::new();
    store
        .map_err(|error| format!("OS credential store is unavailable: {error}"))?
        .build(service, "native-mtp-master:v1", None)
        .map_err(|error| error.to_string())
}

impl CredentialStore {
    fn open((service, directory): (String, PathBuf)) -> Result<Self, String> {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&directory)
            .map_err(|error| error.to_string())?;
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(directory.join("credentials.lock"))
            .map_err(|error| error.to_string())?;
        lock.lock().map_err(|error| error.to_string())?;
        Ok(Self {
            service,
            path: directory.join("mtp-credentials-v1.bin"),
            _lock: lock,
        })
    }

    fn cipher(&self, create: bool) -> Result<ChaCha20Poly1305, String> {
        let entry = master_entry(&self.service)?;
        let key = match entry.get_secret() {
            Ok(key) => Zeroizing::new(key),
            Err(keyring_core::Error::NoEntry)
                if create && !self.path.try_exists().map_err(|error| error.to_string())? =>
            {
                let mut key = Zeroizing::new(vec![0; 32]);
                getrandom::fill(&mut key).map_err(|error| error.to_string())?;
                entry.set_secret(&key).map_err(|error| error.to_string())?;
                key
            }
            Err(keyring_core::Error::NoEntry) => {
                return Err("Native credential encryption key is missing".into())
            }
            Err(error) => return Err(format!("OS credential store is unavailable: {error}")),
        };
        let key: [u8; 32] = key
            .as_slice()
            .try_into()
            .map_err(|_| "Native credential encryption key is invalid")?;
        let key = Zeroizing::new(key);
        Ok(ChaCha20Poly1305::new(*key))
    }

    fn load(&self) -> Result<Option<StoredCredentials>, String> {
        let file = match std::fs::File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let mut encrypted = Vec::new();
        file.take((MAX_CREDENTIAL_BYTES + 65) as u64)
            .read_to_end(&mut encrypted)
            .map_err(|error| error.to_string())?;
        if encrypted.len() > MAX_CREDENTIAL_BYTES + 64 {
            return Err("Native credential file exceeds capacity".into());
        }
        let plaintext = Zeroizing::new(
            self.cipher(false)?
                .decrypt(&encrypted, self.service.as_bytes())
                .map_err(|_| "Native credentials could not be opened")?,
        );
        let record: StoredCredentials = serde_json::from_slice(&plaintext)
            .map_err(|_| "Stored native credentials are invalid")?;
        record.validate()?;
        Ok(Some(record))
    }

    fn save(&self, record: &StoredCredentials) -> Result<(), String> {
        record.validate()?;
        let plaintext = Zeroizing::new(
            serde_json::to_vec(record).map_err(|_| "Native credentials could not be encoded")?,
        );
        if plaintext.len() > MAX_CREDENTIAL_BYTES {
            return Err("Native credential file exceeds capacity".into());
        }
        let encrypted = self
            .cipher(true)?
            .encrypt(&plaintext, self.service.as_bytes())
            .map_err(|error| error.to_string())?;
        crate::native_storage::write_private_atomic(&self.path, &encrypted)
    }

    fn clear(&self) -> Result<(), String> {
        match master_entry(&self.service)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        #[cfg(not(windows))]
        crate::native_storage::sync_directory(
            self.path
                .parent()
                .ok_or("Native credential directory is missing")?,
        )?;
        Ok(())
    }
}

pub(crate) fn load() -> Result<Option<StoredCredentials>, String> {
    let store = CredentialStore::open(crate::mtp_backend::native_credential_location()?)?;
    store.load()
}

pub(crate) fn store_config(serialized: &str) -> Result<(), String> {
    let config = validate_config(
        serde_json::from_str(serialized).map_err(|_| "Invalid native credential configuration")?,
    )?;
    let store = CredentialStore::open(crate::mtp_backend::native_credential_location()?)?;
    let connection = store.load()?.and_then(|mut record| {
        if record.config == config {
            record.connection.take()
        } else {
            None
        }
    });
    store.save(&StoredCredentials {
        version: 1,
        config,
        connection,
    })
}

pub(crate) fn persist_connections(connections: Vec<BackgroundConnection>) -> Result<(), String> {
    let store = CredentialStore::open(crate::mtp_backend::native_credential_location()?)?;
    let primary = connections
        .into_iter()
        .find(|connection| connection.name == crate::mtp_plugin::CONNECTION_NAME);
    let Some(mut record) = store.load()? else {
        return if primary.is_none() {
            Ok(())
        } else {
            Err("Native host configuration has not been persisted".into())
        };
    };
    let Some(primary) = primary else {
        // Temporary setup must not erase a pending host import. An identity
        // previously committed through this hook must not revive after clear.
        return if record.connection.is_some() {
            store.clear()
        } else {
            Ok(())
        };
    };
    if let Some(previous) = &mut record.connection {
        wipe_connection(previous);
    }
    record.connection = Some(primary);
    store.save(&record)
}

pub(crate) fn clear() -> Result<(), String> {
    let store = CredentialStore::open(crate::mtp_backend::native_credential_location()?)?;
    store.clear()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn record() -> StoredCredentials {
        let keyring = mtp::crypto::Keyring::generate().try_to_bytes().unwrap();
        let host = mtp::crypto::Keyring::generate()
            .public_key_bundle()
            .try_as_bytes()
            .unwrap();
        let config = MtpConfig {
            user_id: 7,
            keyring: base64::engine::general_purpose::STANDARD.encode(&keyring),
            omega_url: "https://omega.invalid/".into(),
            forced_omikron_url: None,
            forced_omikron_public_key: None,
        };
        let connection = serde_json::from_value(serde_json::json!({
            "name": crate::mtp_plugin::CONNECTION_NAME,
            "options": { "url": "https://relay.invalid/", "hostPublicKey": host,
                "credentials": { "clientId": "7", "keyring": keyring.as_slice() }, "fresh": false },
        }))
        .unwrap();
        StoredCredentials {
            version: 1,
            config,
            connection: Some(connection),
        }
    }

    fn directory() -> PathBuf {
        std::env::temp_dir().join(format!("native-credentials-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn persisted_identity_must_match_the_permanent_host_credential() {
        let mut record = record();
        assert!(record.validate().is_ok());
        record
            .connection
            .as_mut()
            .unwrap()
            .options
            .credentials
            .as_mut()
            .unwrap()
            .client_id = Some("8".into());
        assert!(record.validate().is_err());
        record
            .connection
            .as_mut()
            .unwrap()
            .options
            .credentials
            .as_mut()
            .unwrap()
            .client_id = Some("7".into());
        record.connection.as_mut().unwrap().options.fresh = true;
        assert!(record.validate().is_err());
    }

    #[cfg(all(unix, not(any(target_os = "macos", target_os = "ios"))))]
    #[test]
    fn unavailable_os_store_never_writes_a_plaintext_credential() {
        if let Ok(directory) = std::env::var("TENSAMIN_UNAVAILABLE_STORE_CHILD") {
            let store = CredentialStore::open((
                "tensamin-test-unavailable".into(),
                PathBuf::from(directory),
            ))
            .unwrap();
            assert!(store.save(&record()).is_err());
            assert!(!store.path.exists());
            return;
        }
        let directory = directory();
        std::fs::create_dir_all(&directory).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "mtp_credentials::tests::unavailable_os_store_never_writes_a_plaintext_credential",
                "--nocapture",
            ])
            .env("TENSAMIN_UNAVAILABLE_STORE_CHILD", &directory)
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}", directory.join("absent-bus").display()),
            )
            .status()
            .unwrap();
        assert!(status.success());
        assert!(!directory.join("mtp-credentials-v1.bin").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[ignore = "requires an isolated, unlocked OS credential store"]
    fn native_os_store_roundtrip_survives_a_fresh_process_and_rejects_key_loss() {
        if let Ok(directory) = std::env::var("TENSAMIN_OS_STORE_CHILD_DIRECTORY") {
            let service = std::env::var("TENSAMIN_OS_STORE_CHILD_SERVICE").unwrap();
            let store = CredentialStore::open((service, PathBuf::from(directory))).unwrap();
            let record = store.load().unwrap().unwrap();
            assert_eq!(record.config.user_id, 7);
            assert!(record.connection.is_some());
            return;
        }
        let directory = directory();
        let service = format!("tensamin-test-{}", uuid::Uuid::new_v4());
        let store = CredentialStore::open((service.clone(), directory.clone())).unwrap();
        let record = record();
        store.save(&record).unwrap();
        assert_eq!(
            master_entry(&service).unwrap().get_secret().unwrap().len(),
            32
        );
        let encrypted = std::fs::read(&store.path).unwrap();
        assert!(!encrypted
            .windows(record.config.keyring.len())
            .any(|window| window == record.config.keyring.as_bytes()));
        drop(store);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "mtp_credentials::tests::native_os_store_roundtrip_survives_a_fresh_process_and_rejects_key_loss", "--nocapture"])
            .env("TENSAMIN_OS_STORE_CHILD_DIRECTORY", &directory)
            .env("TENSAMIN_OS_STORE_CHILD_SERVICE", &service)
            .status().unwrap();
        assert!(status.success());
        let store = CredentialStore::open((service.clone(), directory.clone())).unwrap();
        master_entry(&service).unwrap().delete_credential().unwrap();
        assert!(store.load().is_err());
        assert!(store.save(&record).is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), encrypted);
        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
