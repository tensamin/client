use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, OnceLock, RwLock,
};
use std::time::Duration;

use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine as _,
};
use mtp::client::{ClientConfig, MTPClient};
use mtp::codec::{
    CommunicationType, CommunicationValue, DataType, DataValue, SealedRelayBuilder, TypeMap,
};
use mtp::common::MessageId;
use mtp::crypto::{
    derive_encryption_key, AeadDecrypt, ChaCha20Poly1305, DualSigner, HybridKem, Keyring,
    PublicKeyBundle,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

const EVENT_NAME: &str = "tensamin://mtp";
static CREDENTIALS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub fn sync_directory() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        android::files_directory().map(|path| path.join("account-sync"))
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri::Manager;
        let app = manager().app.read().map_err(|_| "app lock unavailable")?;
        app.as_ref()
            .ok_or("application directory unavailable")?
            .path()
            .app_local_data_dir()
            .map(|path| path.join("account-sync"))
            .map_err(|error| error.to_string())
    }
}
const DISCONNECTED: u8 = 0;
const CONNECTED: u8 = 2;
const CHAT_SECRET_SALT: &[u8] = b"tensamin-chat-secret-v1";
const CHAT_MESSAGE_SALT: &[u8] = b"tensamin-chat-message-v1";
const CHAT_SECRET_SCHEME: &str = "mtp-chat-secret-kem-chacha20poly1305-hkdf-sha256-v1";
pub(crate) const INITIAL_SYNC_TIMEOUT: Duration = Duration::from_secs(30);
const NOTIFICATION_QUEUE_CAPACITY: usize = 32;
const ROUTE_TARGET_ID_MASK: u64 = (1_u64 << 48) - 1;
const USER_ROUTE_TARGET_KIND: u64 = 0x4000_0000_0000_0000;
const IOTA_ROUTE_TARGET_KIND: u64 = 0x8000_0000_0000_0000;
#[cfg(target_os = "android")]
const ROOT_YE_PEM: &[u8] = b"-----BEGIN CERTIFICATE-----\n\
MIIB2TCCAWCgAwIBAgIRAKQCa6LvbHwg1AR+XmWmk4AwCgYIKoZIzj0EAwMwLjEL\n\
MAkGA1UEBhMCVVMxDTALBgNVBAoTBElTUkcxEDAOBgNVBAMTB1Jvb3QgWUUwHhcN\n\
MjUwOTAzMDAwMDAwWhcNNDUwOTAyMjM1OTU5WjAuMQswCQYDVQQGEwJVUzENMAsG\n\
A1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZRTB2MBAGByqGSM49AgEGBSuBBAAi\n\
A2IABDwS/6vhrcVqcbBo+wgdI3fwn9x7DNJJOY/lTOti0vkwuRN87RhEhTH17E7X\n\
yFjWsPYhIPt/wzOqxTd2b+4ZJNy9ID04YywF9U5zasDVyGSNErVNtz8uSGh5izW8\n\
7j77GaNCMEAwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0O\n\
BBYEFKPIJlqOoUzQNWP8myPIOq5W809WMAoGCCqGSM49BAMDA2cAMGQCMHhMr8N9\n\
LdL1VQKs9BdV81r76eXRB6mtjuNjzk6/lBsPNToWLTDzGYgtQKO1jl63uAIwGV7m\n\
onyF377c+MM1oqVNs17sgu7F9YKZwgLmVbeOMDbKAXHtKMDLbiGllCcs8f47\n\
-----END CERTIFICATE-----\n";
#[cfg(target_os = "android")]
const YE1_PEM: &[u8] = b"-----BEGIN CERTIFICATE-----\n\
MIICizCCAhGgAwIBAgIQXd1w3TH4AchcGGp6BLgK/jAKBggqhkjOPQQDAzAuMQsw\n\
CQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZRTAeFw0y\n\
NTA5MDMwMDAwMDBaFw0yODA5MDIyMzU5NTlaMDMxCzAJBgNVBAYTAlVTMRYwFAYD\n\
VQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQDEwNZRTEwdjAQBgcqhkjOPQIBBgUr\n\
gQQAIgNiAAQHZVB1/mimla2hfSurylScjPMZaOJXLz/NnAc2sylm8WDyhU9Ccp+z\n\
ASQi5vSwGGJjSGklkD9fdPR8GpyDIOIjCEfrnbt/v+ZSEPLLEGbaM6EccDbN7p9x\n\
teIm2Avf+ryjge4wgeswDgYDVR0PAQH/BAQDAgGGMBMGA1UdJQQMMAoGCCsGAQUF\n\
BwMBMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFLsgykcL/tflnPmPCSqj\n\
jDdFsbzYMB8GA1UdIwQYMBaAFKPIJlqOoUzQNWP8myPIOq5W809WMDIGCCsGAQUF\n\
BwEBBCYwJDAiBggrBgEFBQcwAoYWaHR0cDovL3llLmkubGVuY3Iub3JnLzATBgNV\n\
HSAEDDAKMAgGBmeBDAECATAnBgNVHR8EIDAeMBygGqAYhhZodHRwOi8veWUuYy5s\n\
ZW5jci5vcmcvMAoGCCqGSM49BAMDA2gAMGUCMQDgjUEahFT/h3DRakqiPZpLvPgf\n\
Zwkt6K2EOMmh1nvEzl83eMLYcod4GCl3b0J1Nn0CMBNYmEQJb4CEG5WoOe7aRn/L\n\
VKu6saHmHEynI7ysIPd8zQsK1HdmhlHKlw9Z5GpGvA==\n\
-----END CERTIFICATE-----\n";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MtpConfig {
    pub user_id: u64,
    pub keyring: String,
    pub omega_url: String,
    pub forced_omikron_url: Option<String>,
    pub forced_omikron_public_key: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MtpSnapshot {
    pub generation: u64,
    pub ready_state: u8,
    pub identified: bool,
    pub state: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncodedKeyMaterial {
    value: String,
    encoding: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum RelayTargetDto {
    User { id: u64 },
    Iota { id: u64 },
}

impl RelayTargetDto {
    fn wire_id(self) -> Result<u64, String> {
        let (kind, id) = match self {
            Self::User { id } => (USER_ROUTE_TARGET_KIND, id),
            Self::Iota { id } => (IOTA_ROUTE_TARGET_KIND, id),
        };
        if id == 0 || id > ROUTE_TARGET_ID_MASK {
            return Err("relay target ID must be a non-zero 48-bit integer".into());
        }
        Ok(kind | id)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedRelayRequest {
    type_name: String,
    data: Value,
    next_hop: RelayTargetDto,
    final_recipient_id: u64,
    metadata_recipients: Vec<EncodedKeyMaterial>,
    content_recipients: Vec<EncodedKeyMaterial>,
    metadata: Option<Vec<u8>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum MtpEvent {
    State {
        snapshot: MtpSnapshot,
    },
    Log {
        level: u8,
        message: String,
        details: Option<Value>,
    },
}

pub struct MtpManager {
    runtime: tokio::runtime::Runtime,
    config: RwLock<Option<MtpConfig>>,
    snapshot: RwLock<MtpSnapshot>,
    generation: AtomicU64,
    enabled: AtomicBool,
    pub(crate) ui_visible: AtomicBool,
    app: RwLock<Option<AppHandle>>,
}

static MANAGER: OnceLock<MtpManager> = OnceLock::new();
type PluginNotification = (
    u64,
    Arc<Keyring>,
    Arc<tauri_plugin_mtp::Session>,
    CommunicationValue,
);
static PLUGIN_NOTIFICATIONS: OnceLock<mpsc::Sender<PluginNotification>> = OnceLock::new();

pub fn manager() -> &'static MtpManager {
    MANAGER.get_or_init(|| MtpManager {
        runtime: tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("tensamin-mtp")
            .build()
            .expect("failed to create MTP runtime"),
        config: RwLock::new(None),
        snapshot: RwLock::new(MtpSnapshot {
            ready_state: DISCONNECTED,
            ..MtpSnapshot::default()
        }),
        generation: AtomicU64::new(0),
        enabled: AtomicBool::new(false),
        ui_visible: AtomicBool::new(false),
        app: RwLock::new(None),
    })
}

impl MtpManager {
    pub fn attach_app(&self, app: AppHandle) {
        *self.app.write().expect("app lock poisoned") = Some(app);
    }

    pub fn stop(&self) {
        self.enabled.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.set_snapshot(MtpSnapshot {
            generation: self.generation.load(Ordering::SeqCst),
            ready_state: DISCONNECTED,
            identified: false,
            state: None,
            error: None,
        });
    }

    pub fn set_ui_visible(&self, visible: bool) {
        self.ui_visible.store(visible, Ordering::SeqCst);
    }

    #[cfg(target_os = "android")]
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn snapshot(&self) -> MtpSnapshot {
        self.snapshot
            .read()
            .expect("snapshot lock poisoned")
            .clone()
    }

    fn set_snapshot(&self, snapshot: MtpSnapshot) {
        if let Some(error) = snapshot.error.as_ref() {
            eprintln!("android: MTP connection failed: {error}");
        }
        let mut current = self.snapshot.write().expect("snapshot lock poisoned");
        if snapshot.generation < current.generation {
            return;
        }
        if snapshot.generation == current.generation {
            if let (Some(previous), Some(next)) = (&current.state, &snapshot.state) {
                if previous.get("scope") == next.get("scope")
                    && previous.get("head").and_then(Value::as_i64)
                        > next.get("head").and_then(Value::as_i64)
                {
                    return;
                }
            }
        }
        *current = snapshot.clone();
        self.emit(MtpEvent::State { snapshot });
    }

    pub(crate) fn publish_relay_state(&self, generation: u64, state: Value) -> Result<(), String> {
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err("Native session changed during relay application".into());
        }
        self.set_snapshot(MtpSnapshot {
            generation,
            ready_state: CONNECTED,
            identified: true,
            state: Some(state),
            error: None,
        });
        Ok(())
    }

    fn emit(&self, event: MtpEvent) {
        if let Some(app) = self.app.read().expect("app lock poisoned").as_ref() {
            let _ = app.emit(EVENT_NAME, event);
        }
    }

    fn log(&self, level: u8, message: impl Into<String>, details: Option<Value>) {
        let message = message.into();
        eprintln!(
            "android: {message}{}",
            details
                .as_ref()
                .map(|value| format!(": {value}"))
                .unwrap_or_default()
        );
        self.emit(MtpEvent::Log {
            level,
            message,
            details,
        });
    }
}

pub(crate) fn current_config() -> Result<MtpConfig, String> {
    let config = manager()
        .config
        .read()
        .map_err(|_| "config lock unavailable")?
        .clone();
    #[cfg(target_os = "android")]
    let config = match config {
        Some(config) => Some(config),
        None => load_native_config()?
            .map(|serialized| serde_json::from_str(&serialized).map_err(|error| error.to_string()))
            .transpose()?
            .map(validate_config)
            .transpose()?,
    };
    #[cfg(not(target_os = "android"))]
    let config = match config {
        Some(config) => Some(config),
        None => crate::mtp_credentials::load()?.map(|record| record.config.clone()),
    };
    config.ok_or_else(|| "discovery configuration unavailable".into())
}

#[cfg(not(target_os = "android"))]
pub(crate) fn native_credential_location() -> Result<(String, std::path::PathBuf), String> {
    use tauri::Manager;
    let app = manager()
        .app
        .read()
        .map_err(|_| "application lock unavailable")?;
    let app = app.as_ref().ok_or("application directory unavailable")?;
    Ok((
        app.config().identifier.clone(),
        app.path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("credentials"),
    ))
}

fn restore_cached_state() -> Result<(), String> {
    let generation = manager().generation.load(Ordering::SeqCst);
    let config = current_config()?;
    let directory = sync_directory()?;
    let device_id = match std::fs::read_to_string(directory.join("sync-device-id")) {
        Ok(device_id) => device_id,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let journal = crate::mtp_sync_cache::AccountSyncJournal::new(
        directory.clone(),
        &config,
        device_id.clone(),
    )?;
    let snapshot = match journal.projection()? {
        Some(snapshot) => Some(snapshot),
        None => {
            crate::mtp_sync_cache::AccountSyncCache::new(directory, &config, device_id)?.load()?
        }
    };
    let Some(snapshot) = snapshot else {
        return Ok(());
    };
    if manager().generation.load(Ordering::SeqCst) != generation || current_config()? != config {
        return Err("Account changed during offline restoration".into());
    }
    if manager().snapshot().identified {
        return Ok(());
    }
    manager().set_snapshot(MtpSnapshot {
        generation,
        ready_state: DISCONNECTED,
        identified: false,
        state: Some(serde_json::to_value(snapshot).map_err(|error| error.to_string())?),
        error: None,
    });
    Ok(())
}

async fn initialize_plugin_connection() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let roots = std::env::temp_dir().join("tensamin-android-ca-certificates.pem");
        std::fs::write(&roots, android_root_certificates()?).map_err(|error| error.to_string())?;
        std::env::set_var("SSL_CERT_FILE", roots);
    }
    let config = current_config()?;
    let (url, public_key) = resolve_endpoint(&config).await?;
    let options = tauri_plugin_mtp::identities::InitializeOptions {
        url,
        descriptor: Some("client".into()),
        host_public_key: Some(decode_sdk_bytes(&public_key)?),
        credentials: Some(tauri_plugin_mtp::identities::ImportedCredentials {
            client_id: Some(config.user_id.to_string()),
            keyring: decode_browser_base64(&config.keyring)?,
            host_public_key: Some(decode_sdk_bytes(&public_key)?),
        }),
        fresh: false,
        server_certificate_hashes: None,
        max_message_size: Some(16 * 1024 * 1024),
        auth_timeout_ms: Some(30_000),
        require_pq: Some(true),
        pings: Some(Value::Bool(true)),
        receive_limits: None,
    };
    let lifecycle = tauri_plugin_mtp::mobile::lifecycle().ok_or("plugin lifecycle unavailable")?;
    lifecycle
        .start(vec![tauri_plugin_mtp::lifecycle::BackgroundConnection {
            name: crate::mtp_plugin::CONNECTION_NAME.into(),
            options,
        }])
        .await
}

pub async fn resolve_plugin_endpoint(name: &str) -> Result<tauri_plugin_mtp::Endpoint, String> {
    if name != crate::mtp_plugin::CONNECTION_NAME {
        return Err("temporary connections must supply pinned options".into());
    }
    let config = current_config()?;
    let (url, public_key) = resolve_endpoint(&config).await?;
    let host_key =
        PublicKeyBundle::from_bytes(&decode_sdk_bytes(&public_key)?).map_err(|e| e.to_string())?;
    host_key.validate().map_err(|e| e.to_string())?;
    let client = ClientConfig::new(url)
        .with_client_id(config.user_id)
        .with_description("client");
    #[cfg(target_os = "android")]
    let client = client.with_pinned_pem(android_root_certificates()?);
    Ok(tauri_plugin_mtp::Endpoint {
        config: client,
        host_key,
    })
}

pub fn spawn_plugin_observer(plugin: Arc<tauri_plugin_mtp::Manager>) {
    manager().runtime.spawn(async move {
        let mut sessions = plugin
            .registry
            .watch(crate::mtp_plugin::CONNECTION_NAME)
            .await;
        loop {
            let session = sessions.borrow_and_update().clone();
            let generation = manager().generation.fetch_add(1, Ordering::SeqCst) + 1;
            manager().set_snapshot(MtpSnapshot {
                generation,
                state: manager().snapshot().state,
                ..MtpSnapshot::default()
            });
            if let Some(session) = session {
                let synchronized = tokio::select! {
                    result = crate::mtp_plugin::synchronize(&session) => result,
                    changed = sessions.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        continue;
                    }
                };
                match synchronized {
                    Ok(state) => {
                        manager().enabled.store(true, Ordering::SeqCst);
                        manager().set_snapshot(MtpSnapshot {
                            generation,
                            ready_state: CONNECTED,
                            identified: true,
                            state: Some(state),
                            error: None,
                        });
                    }
                    Err(error) => {
                        manager().log(
                            0,
                            "Native account synchronization failed",
                            Some(Value::String(error)),
                        );
                        session.close().await;
                    }
                }
            }
            if sessions.changed().await.is_err() {
                break;
            }
        }
    });
}

pub async fn handle_plugin_message(
    session: Arc<tauri_plugin_mtp::Session>,
    frame: CommunicationValue,
) {
    if frame.is_type(CommunicationType::SessionActivitySet) {
        if let Some(id) = frame.id() {
            let response = CommunicationValue::new(CommunicationType::SessionActivitySet)
                .with_id(id)
                .add_typed_default(
                    DataType::Foreground,
                    DataValue::Bool(manager().ui_visible.load(Ordering::SeqCst)),
                );
            let _ = session.send(&response).await;
        }
        return;
    }
    if frame.is_type(CommunicationType::Relay) {
        let identity = {
            let lifecycle = tauri_plugin_mtp::mobile::lifecycle().expect("installed lifecycle");
            let entries = lifecycle.identities.entries.lock().await;
            entries
                .get(crate::mtp_plugin::CONNECTION_NAME)
                .and_then(|identity| identity.client_id.map(|id| (id, identity.keys.clone())))
        };
        if let Some((user_id, keyring)) = identity {
            if let Err(error) =
                crate::mtp_relay::handle_plugin_relay(session, frame, user_id, keyring).await
            {
                manager().log(
                    1,
                    "Authenticated relay handling failed",
                    Some(Value::String(error)),
                );
            }
        }
        return;
    }
    if frame.is_type(CommunicationType::MessageState)
        && frame.get_str(DataType::MessageState) == Some("read")
    {
        if let Some(id) = frame
            .get_data(DataType::ChatPartnerId)
            .and_then(DataValue::as_number)
            .and_then(|v| u64::try_from(v).ok())
        {
            let _ = android_cancel_notification(id);
        }
    }
    if frame.is_type(CommunicationType::MessageLive)
        && !manager().ui_visible.load(Ordering::SeqCst)
        && !frame
            .get_data(DataType::SuppressNotification)
            .and_then(DataValue::as_bool)
            .unwrap_or(false)
    {
        let lifecycle = tauri_plugin_mtp::mobile::lifecycle().expect("installed lifecycle");
        let identity = {
            let entries = lifecycle.identities.entries.lock().await;
            entries
                .get(crate::mtp_plugin::CONNECTION_NAME)
                .and_then(|identity| identity.client_id.map(|id| (id, identity.keys.clone())))
        };
        if let Some((user_id, keyring)) = identity {
            let queue = PLUGIN_NOTIFICATIONS.get_or_init(|| {
                let (sender, mut receiver) =
                    mpsc::channel::<PluginNotification>(NOTIFICATION_QUEUE_CAPACITY);
                manager().runtime.spawn(async move {
                    while let Some((id, keys, session, frame)) = receiver.recv().await {
                        if let Err(error) = notify_plugin_message(id, &keys, session, &frame).await
                        {
                            manager().log(
                                1,
                                "Background notification failed",
                                Some(Value::String(error)),
                            );
                        }
                    }
                });
                sender
            });
            if queue.try_send((user_id, keyring, session, frame)).is_err() {
                manager().log(1, "Background notification queue is full", None);
            }
        }
    }
}

pub(crate) fn validate_config(config: MtpConfig) -> Result<MtpConfig, String> {
    if config.user_id == 0 {
        return Err("MTP user ID must be positive".into());
    }
    let keyring_bytes = zeroize::Zeroizing::new(
        decode_browser_base64(&config.keyring)
            .map_err(|error| format!("invalid MTP keyring: {error}"))?,
    );
    Keyring::from_bytes(&keyring_bytes).map_err(|error| format!("invalid MTP keyring: {error}"))?;
    let omega_url = normalize_https_url(&config.omega_url, "Omega URL")?;
    let forced_omikron_url = config
        .forced_omikron_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| normalize_https_url(value, "Forced Omikron URL"))
        .transpose()?;
    let forced_omikron_public_key = config
        .forced_omikron_public_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if forced_omikron_url.is_some() != forced_omikron_public_key.is_some() {
        return Err("Forced Omikron URL and public key must both be set or both be empty".into());
    }
    if let Some(public_key) = forced_omikron_public_key.as_ref() {
        let bytes = decode_sdk_bytes(public_key)
            .map_err(|error| format!("invalid Omikron public key: {error}"))?;
        let key = PublicKeyBundle::from_bytes(&bytes)
            .map_err(|error| format!("invalid Omikron public key: {error}"))?;
        key.validate()
            .map_err(|error| format!("invalid Omikron public key: {error}"))?;
    }
    Ok(MtpConfig {
        omega_url,
        forced_omikron_url,
        forced_omikron_public_key,
        ..config
    })
}

fn normalize_https_url(value: &str, label: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|error| format!("{label} is invalid: {error}"))?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(format!("{label} must be a valid HTTPS URL"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{label} must not contain credentials"));
    }
    Ok(url.to_string())
}

async fn resolve_endpoint(config: &MtpConfig) -> Result<(String, String), String> {
    if let (Some(url), Some(key)) = (
        config.forced_omikron_url.as_ref(),
        config.forced_omikron_public_key.as_ref(),
    ) {
        return Ok((url.clone(), key.clone()));
    }
    lookup_omikron(config, None).await
}

#[derive(Deserialize)]
struct OmikronDiscovery {
    id: u64,
    ip_address: String,
    port: u16,
    public_key: String,
}

impl OmikronDiscovery {
    fn endpoint(self, owner: Option<u64>) -> Result<(String, String), String> {
        if self.id == 0 || self.id > i64::MAX as u64 || owner.is_some_and(|owner| owner != self.id)
        {
            return Err("Omikron discovery returned a different or invalid owner".into());
        }
        if self.port == 0
            || self.ip_address.trim() != self.ip_address
            || self.ip_address.contains(['/', '?', '#', '@', '\\'])
        {
            return Err("Omikron discovery returned an invalid endpoint".into());
        }
        let mut url = reqwest::Url::parse("https://localhost").expect("static HTTPS URL");
        if let Ok(ip) = self.ip_address.parse::<std::net::IpAddr>() {
            url.set_ip_host(ip)
                .map_err(|_| "invalid Omikron IP address")?;
        } else {
            url.set_host(Some(&self.ip_address))
                .map_err(|_| "invalid Omikron hostname")?;
        }
        url.set_port(Some(self.port))
            .map_err(|_| "invalid Omikron port")?;
        let key = PublicKeyBundle::from_bytes(&decode_browser_base64(&self.public_key)?)
            .map_err(|error| format!("invalid Omikron public key: {error}"))?;
        key.validate()
            .map_err(|error| format!("invalid Omikron public key: {error}"))?;
        Ok((url.to_string(), self.public_key))
    }
}

async fn lookup_omikron(
    config: &MtpConfig,
    owner: Option<u64>,
) -> Result<(String, String), String> {
    let root = config.omega_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20));
    #[cfg(target_os = "android")]
    let client = {
        let roots = android_root_certificates()?;
        client.tls_certs_only(
            reqwest::Certificate::from_pem_bundle(&roots)
                .map_err(|error| format!("invalid Android root certificates: {error}"))?,
        )
    };
    let path = match owner {
        Some(owner) => format!("{root}/api/get/omikron/{owner}"),
        None => format!("{root}/api/get/user/{}/omikron", config.user_id),
    };
    let mut response = client
        .build()
        .map_err(|error| error.to_string())?
        .get(path)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Omikron lookup failed: {}", response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > 192 * 1024 {
            return Err("Omikron discovery exceeds the JSON control budget".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<OmikronDiscovery>(&bytes)
        .map_err(|error| error.to_string())?
        .endpoint(owner)
}

fn call_control_frame(bytes: &[u8], map: &TypeMap) -> Result<CommunicationValue, String> {
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Call control frame exceeds the message budget".into());
    }
    let frame =
        CommunicationValue::from_bytes_with(bytes, map).map_err(|error| error.to_string())?;
    if ![
        CommunicationType::CallReserve,
        CommunicationType::CallActivate,
        CommunicationType::CallToken,
        CommunicationType::CallData,
        CommunicationType::CallInvite,
        CommunicationType::CallDisconnectUser,
        CommunicationType::CallTimeoutUser,
        CommunicationType::CallSetAnonymousJoining,
        CommunicationType::EndCall,
    ]
    .iter()
    .any(|kind| frame.is_type(*kind))
    {
        return Err("Call control requires a call request".into());
    }
    Ok(frame)
}

fn require_call_generation(generation: u64) -> Result<(), String> {
    let snapshot = manager().snapshot();
    if snapshot.generation != generation
        || !snapshot.identified
        || snapshot.ready_state != CONNECTED
    {
        return Err("Native call control is not authenticated for this generation".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn mtp_send_call_control(
    owner_omikron_id: u64,
    generation: u64,
    dictionary_fingerprint: String,
    frame: Vec<u8>,
    timeout_ms: u64,
    response_type: Option<String>,
) -> Result<Vec<u8>, String> {
    if owner_omikron_id == 0 || owner_omikron_id > i64::MAX as u64 || timeout_ms == 0 {
        return Err("Call owner and request timeout must be positive".into());
    }
    require_call_generation(generation)?;
    let plugin = crate::mtp_plugin::manager();
    let (config, keyring, mut primary_changes, primary) = {
        let _credentials = CREDENTIALS_LOCK.lock().await;
        require_call_generation(generation)?;
        let config = current_config()?;
        let mut changes = plugin
            .registry
            .watch(crate::mtp_plugin::CONNECTION_NAME)
            .await;
        let primary = changes
            .borrow_and_update()
            .clone()
            .ok_or("MTP is not connected")?;
        let lifecycle =
            tauri_plugin_mtp::mobile::lifecycle().ok_or("plugin lifecycle unavailable")?;
        let entries = lifecycle.identities.entries.lock().await;
        let identity = entries
            .get(crate::mtp_plugin::CONNECTION_NAME)
            .ok_or("MTP credentials are unavailable")?;
        if identity.client_id != Some(config.user_id)
            || primary.connection().client_id != config.user_id
        {
            return Err("Native call identity does not match the current session".into());
        }
        (config, identity.keys.clone(), changes, primary)
    };
    let map = primary.connection().codec.type_map();
    if map.fingerprint_hex().as_deref() != Some(dictionary_fingerprint.as_str()) {
        return Err("Call control dictionary does not match the native session".into());
    }
    let frame = call_control_frame(&frame, map)?;
    let expected = response_type
        .map(|name| communication_type(&name))
        .transpose()?;
    let connect = async {
        let (url, pin) = lookup_omikron(&config, Some(owner_omikron_id)).await?;
        require_call_generation(generation)?;
        let host = PublicKeyBundle::from_bytes(&decode_browser_base64(&pin)?)
            .map_err(|error| error.to_string())?;
        let options = ClientConfig::new(url)
            .with_client_id(config.user_id)
            .with_description("client-call-control")
            .with_require_pq(true)
            .with_auth_timeout(INITIAL_SYNC_TIMEOUT);
        #[cfg(target_os = "android")]
        let options = options.with_pinned_pem(android_root_certificates()?);
        let connection = tokio::time::timeout(
            INITIAL_SYNC_TIMEOUT,
            MTPClient::auth_connect(options, &keyring, &host),
        )
        .await
        .map_err(|_| "Call owner authentication timed out")?
        .map_err(|error| error.to_string())?;
        Ok::<_, String>(tauri_plugin_mtp::Session::new(connection).await)
    };
    let owner = tokio::select! {
        biased;
        _ = primary_changes.changed() => return Err("Native session changed during call owner discovery".into()),
        result = connect => result?,
    };
    // Owner sessions are request-scoped, never persisted as another credential
    // identity or retained after logout, cancellation or a failed request.
    let result = async {
        require_call_generation(generation)?;
        if owner.connection().codec.type_map().fingerprint_hex().as_deref() != Some(dictionary_fingerprint.as_str()) {
            return Err("Call owner uses a different protocol dictionary".into());
        }
        tokio::select! {
            biased;
            _ = primary_changes.changed() => Err("Native session changed during call control".into()),
            result = owner.request(frame, expected, Duration::from_millis(timeout_ms)) => result.map_err(|error| error.to_string()),
        }
    }.await;
    owner.close().await;
    require_call_generation(generation)?;
    if primary_changes.has_changed().unwrap_or(true) {
        return Err("Native session changed during call control".into());
    }
    result?.to_bytes().map_err(|error| error.to_string())
}

fn decode_key_material(value: EncodedKeyMaterial) -> Result<PublicKeyBundle, String> {
    let bytes = match value.encoding.as_str() {
        "base64" => decode_browser_base64(&value.value)?,
        "hex" => decode_sdk_bytes(&value.value)?,
        encoding => return Err(format!("unsupported key material encoding: {encoding}")),
    };
    let key = PublicKeyBundle::from_bytes(&bytes)
        .map_err(|error| format!("invalid relay recipient public key: {error}"))?;
    key.validate()
        .map_err(|error| format!("invalid relay recipient public key: {error}"))?;
    Ok(key)
}

async fn prepare_sealed_relay(
    request: SealedRelayRequest,
    connection: &tauri_plugin_mtp::Session,
) -> Result<CommunicationValue, String> {
    if request.metadata_recipients.is_empty() || request.content_recipients.is_empty() {
        return Err("sealed relay requires metadata and content recipients".into());
    }
    if request.final_recipient_id == 0 {
        return Err("sealed relay final recipient ID must be non-zero".into());
    }
    let lifecycle = tauri_plugin_mtp::mobile::lifecycle().ok_or("plugin lifecycle unavailable")?;
    let (user_id, keyring) = {
        let identities = lifecycle.identities.entries.lock().await;
        let identity = identities
            .get(crate::mtp_plugin::CONNECTION_NAME)
            .ok_or("MTP credentials are unavailable")?;
        (
            identity.client_id.ok_or("MTP client ID is unavailable")?,
            identity.keys.clone(),
        )
    };
    let signer = DualSigner::new(
        &keyring.sig_cl_secret_key,
        &keyring.sig_pq_secret_key,
        &keyring.sig_pq_public_key,
    )
    .map_err(|error| format!("invalid MTP signing key: {error}"))?;
    let next_hop_id = request.next_hop.wire_id()?;
    let type_map = connection.connection().codec.type_map().clone();
    let message_type = communication_type(&request.type_name)?;
    let content = json_to_frame(&request.type_name, request.data, 1, &type_map)?.into_payload();
    let metadata_recipients = request
        .metadata_recipients
        .into_iter()
        .map(decode_key_material)
        .collect::<Result<Vec<_>, _>>()?;
    let content_recipients = request
        .content_recipients
        .into_iter()
        .map(decode_key_material)
        .collect::<Result<Vec<_>, _>>()?;
    let created_at = mtp::common::unix_time_millis()
        .map_err(|error| format!("failed to get relay timestamp: {error}"))?;
    let frame = {
        let mut builder = SealedRelayBuilder::new(
            message_type,
            content,
            user_id,
            request.final_recipient_id,
            next_hop_id,
            &signer,
        )
        .message_id(MessageId::random())
        .created_at(created_at)
        .metadata_recipients(metadata_recipients)
        .content_recipients(content_recipients)
        .type_map(&type_map);
        if let Some(metadata) = request.metadata {
            builder = builder.metadata(DataValue::Bytes(metadata));
        }
        builder
            .build()
            .map_err(|error| format!("failed to build sealed relay: {error}"))?
    };
    Ok(frame)
}

pub(crate) async fn notify_plugin_message(
    user_id: u64,
    keyring: &Keyring,
    connection: Arc<tauri_plugin_mtp::Session>,
    frame: &CommunicationValue,
) -> Result<(), String> {
    let sender_id = frame
        .get_data(DataType::SenderId)
        .and_then(DataValue::as_number)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or("MessageLive omitted SenderId")?;
    let message = frame
        .get_data(DataType::Message)
        .ok_or("MessageLive omitted Message")?;
    let content = container_value_by_name(message, "Content")
        .and_then(DataValue::as_str)
        .ok_or("MessageLive omitted Content")?;
    let message_version = container_value_by_name(message, "VersionNumber")
        .and_then(DataValue::as_number)
        .map(u128::try_from)
        .transpose()
        .map_err(|_| "MessageLive VersionNumber must be nonnegative")?
        .unwrap_or(1);
    let state = manager()
        .snapshot()
        .state
        .ok_or("Account identity is unavailable")?;
    let scope: tau_relay_protocol::sync::Scope =
        serde_json::from_value(state["scope"].clone()).map_err(|error| error.to_string())?;
    if scope.principal.user_id != user_id {
        return Err("Account identity changed".into());
    }
    let sender_json = container_value_by_name(message, "Principal")
        .and_then(DataValue::as_str)
        .ok_or("Message omitted canonical sender")?;
    let sender: tau_relay_protocol::Principal =
        serde_json::from_str(sender_json).map_err(|error| error.to_string())?;
    if serde_json::to_string(&sender).map_err(|error| error.to_string())? != sender_json {
        return Err("Noncanonical message sender".into());
    }
    let owner_json = serde_json::to_string(&scope.principal).map_err(|error| error.to_string())?;
    let chat_id = tau_relay_protocol::ConversationPair::new(scope.principal, sender.clone())
        .and_then(|pair| pair.chat_id())
        .map_err(|error| error.to_string())?;
    let secret_id = tau_relay_protocol::chat_secret_id(&chat_id);
    let map = connection.connection().codec.type_map();
    let secret_request =
        CommunicationValue::new_with_type_map(CommunicationType::GetChatSecret, map)
            .add_typed_default(DataType::UserId, DataValue::Str(owner_json.clone()))
            .add_typed_default(DataType::ChatId, DataValue::Str(chat_id.clone()))
            .add_typed_default(DataType::SecretId, DataValue::Str(secret_id.clone()))
            .add_typed_default(
                DataType::VersionNumber,
                DataValue::UnsignedNumber(message_version),
            );
    let secret = connection
        .request(
            secret_request,
            Some(CommunicationType::ChatSecretResponse),
            INITIAL_SYNC_TIMEOUT,
        )
        .await
        .map_err(|error| error.to_string())?;
    if !secret.is_type(CommunicationType::ChatSecretResponse) {
        return Err(format!("GetChatSecret failed: {secret}"));
    }
    if secret.type_map() != Some(map)
        || secret.get_str(DataType::UserId) != Some(owner_json.as_str())
        || secret.get_str(DataType::ChatId) != Some(chat_id.as_str())
        || secret.get_str(DataType::SecretId) != Some(secret_id.as_str())
        || secret.get_str(DataType::WrappingScheme) != Some(CHAT_SECRET_SCHEME)
        || secret
            .get_data(DataType::VersionNumber)
            .and_then(DataValue::as_number)
            != i128::try_from(message_version).ok()
    {
        return Err("Chat secret response does not match the requested scope".into());
    }
    let version = secret
        .get_data(DataType::VersionNumber)
        .and_then(DataValue::as_number)
        .ok_or("missing secret version")?;
    let encrypted_secret = secret
        .get_bytes(DataType::EncryptedSecret)
        .ok_or("missing encrypted secret")?;
    let kem_ciphertext = secret
        .get_bytes(DataType::KemCiphertext)
        .ok_or("missing KEM ciphertext")?;
    let shared = HybridKem::decapsulate(&keyring.kem_secret_key, kem_ciphertext)
        .map_err(|error| error.to_string())?;
    let wrapping_key = derive_encryption_key(
        &shared,
        CHAT_SECRET_SALT,
        format!("{chat_id}:{secret_id}:{version}").as_bytes(),
    )
    .map_err(|error| error.to_string())?;
    let chat_secret = ChaCha20Poly1305::new(wrapping_key)
        .decrypt(encrypted_secret, b"")
        .map_err(|error| error.to_string())?;
    let message_key_info = if version == 1 {
        "message-content".to_string()
    } else {
        format!("message-content:{version}")
    };
    let message_key =
        derive_encryption_key(&chat_secret, CHAT_MESSAGE_SALT, message_key_info.as_bytes())
            .map_err(|error| error.to_string())?;
    let ciphertext = STANDARD
        .decode(content)
        .map_err(|error| error.to_string())?;
    let plaintext = ChaCha20Poly1305::new(message_key)
        .decrypt(&ciphertext, b"")
        .map_err(|error| error.to_string())?;

    let user_request = CommunicationValue::new_with_type_map(CommunicationType::UserResolve, map)
        .add_typed_default(
            DataType::UserAddress,
            DataValue::Str(sender_json.to_owned()),
        );
    let user = connection
        .request(
            user_request,
            Some(CommunicationType::UserResolved),
            INITIAL_SYNC_TIMEOUT,
        )
        .await
        .map_err(|error| error.to_string())?;
    if !user.is_type(CommunicationType::UserResolved)
        || user.get_str(DataType::Principal) != Some(sender_json)
        || user.get_str(DataType::AuthorityId) != Some(sender.authority.as_str())
        || user
            .get_data(DataType::UserId)
            .and_then(DataValue::as_number)
            != Some(sender.user_id.into())
    {
        return Err("Notification identity does not match the message principal".into());
    }
    let sender = user
        .get_str(DataType::Display)
        .or_else(|| user.get_str(DataType::Username))
        .map(str::to_owned)
        .unwrap_or_else(|| sender_json.to_owned());
    android_notify(
        sender_id,
        &sender,
        &String::from_utf8_lossy(&plaintext),
        None,
    )?;
    Ok(())
}

pub(crate) fn decode_browser_base64(value: &str) -> Result<Vec<u8>, String> {
    let normalized: String = value
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect();
    if normalized.is_empty() {
        return Err("value is empty".into());
    }
    STANDARD
        .decode(&normalized)
        .or_else(|_| STANDARD_NO_PAD.decode(&normalized))
        .map_err(|_| "invalid base64 encoding".into())
}

fn decode_sdk_bytes(value: &str) -> Result<Vec<u8>, String> {
    let trimmed = value.trim();
    let hex: String = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed)
        .chars()
        .filter(|character| !matches!(character, ' ' | '\t' | '\r' | '\n' | ':' | '_' | '-'))
        .collect();
    if !hex.is_empty() && hex.chars().all(|character| character.is_ascii_hexdigit()) {
        if !hex.len().is_multiple_of(2) {
            return Err("hex string has an odd length".into());
        }
        return (0..hex.len())
            .step_by(2)
            .map(|offset| {
                u8::from_str_radix(&hex[offset..offset + 2], 16)
                    .map_err(|_| "invalid hex encoding".to_string())
            })
            .collect();
    }
    decode_browser_base64(trimmed)
}

#[cfg(target_os = "android")]
fn android_root_certificates() -> Result<Vec<u8>, String> {
    let mut pem = android::root_certificates()?;
    pem.extend_from_slice(ROOT_YE_PEM);
    pem.extend_from_slice(YE1_PEM);
    Ok(pem)
}

fn container_value(value: &DataValue, field: DataType) -> Option<&DataValue> {
    let id = field.try_to_id(&TypeMap::latest())?;
    value.get_field(id)
}

pub(crate) fn container_value_by_name<'a>(
    value: &'a DataValue,
    field: &str,
) -> Option<&'a DataValue> {
    container_value(value, DataType::from_name(field)?)
}

fn communication_type(name: &str) -> Result<CommunicationType, String> {
    CommunicationType::from_name(name).ok_or_else(|| format!("unknown communication type: {name}"))
}

fn json_to_frame(
    type_name: &str,
    data: Value,
    id: u32,
    map: &TypeMap,
) -> Result<CommunicationValue, String> {
    let comm_type = communication_type(type_name)?;
    let mut frame = CommunicationValue::new_with_type_map(comm_type, map).with_id(id);
    let Value::Object(fields) = data else {
        return Err("MTP request data must be an object".into());
    };
    for (name, value) in fields {
        let data_type =
            DataType::from_name(&name).ok_or_else(|| format!("unknown data type: {name}"))?;
        frame = frame.add_typed_default(data_type, json_to_data(&name, value, map)?);
    }
    Ok(frame)
}

fn json_to_data(field: &str, value: Value, map: &TypeMap) -> Result<DataValue, String> {
    Ok(match value {
        Value::Null => DataValue::Null,
        Value::Bool(value) => DataValue::from(value),
        Value::Number(value) => {
            if let Some(integer) = value.as_u64() {
                DataValue::UnsignedNumber(integer as u128)
            } else if let Some(integer) = value.as_i64() {
                DataValue::SignedNumber(integer as i128)
            } else {
                DataValue::Float(value.as_f64().ok_or("invalid number")?)
            }
        }
        Value::String(value) => DataValue::Str(value),
        Value::Array(values) if is_bytes_field(field) => DataValue::Bytes(
            values
                .into_iter()
                .map(|value| {
                    value
                        .as_u64()
                        .and_then(|n| u8::try_from(n).ok())
                        .ok_or("invalid byte")
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Value::Array(values) => DataValue::Array(
            values
                .into_iter()
                .map(|value| json_to_data(field, value, map))
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(fields) => {
            let mut entries = Vec::with_capacity(fields.len());
            for (name, value) in fields {
                let data_type = DataType::from_name(&name)
                    .ok_or_else(|| format!("unknown nested data type: {name}"))?;
                let id = data_type
                    .try_to_id(map)
                    .ok_or_else(|| format!("unmapped data type: {name}"))?;
                entries.push((id, json_to_data(&name, value, map)?));
            }
            DataValue::Container(entries)
        }
    })
}

fn is_bytes_field(field: &str) -> bool {
    matches!(
        field,
        "Blob" | "EncryptedSecret" | "KemCiphertext" | "Payload" | "PublicKeys"
    )
}

#[cfg(test)]
mod tests {
    use mtp::codec::{CommunicationType, CommunicationValue, DataType, DataValue, TypeMap};
    use serde_json::json;

    use super::{
        container_value_by_name, decode_browser_base64, decode_sdk_bytes, json_to_frame,
        RelayTargetDto,
    };

    #[test]
    fn discovered_call_owner_must_match_and_have_a_valid_pinned_endpoint() {
        let key = mtp::crypto::Keyring::generate()
            .public_key_bundle()
            .try_to_base64()
            .unwrap();
        let endpoint = |id, host: &str, port| super::OmikronDiscovery {
            id,
            ip_address: host.into(),
            port,
            public_key: key.clone(),
        };
        assert_eq!(
            endpoint(42, "::1", 4433).endpoint(Some(42)).unwrap(),
            ("https://[::1]:4433/".into(), key.clone())
        );
        assert_eq!(
            endpoint(42, "owner.example.org", 4433)
                .endpoint(Some(42))
                .unwrap()
                .0,
            "https://owner.example.org:4433/"
        );
        assert!(endpoint(41, "owner.example.org", 4433)
            .endpoint(Some(42))
            .is_err());
        assert!(endpoint(0, "owner.example.org", 4433)
            .endpoint(None)
            .is_err());
        assert!(endpoint(42, "owner.example.org", 0)
            .endpoint(Some(42))
            .is_err());
        for host in [
            "",
            "user@owner.example.org",
            "owner.example.org/path",
            "owner.example.org?other",
            " owner.example.org",
        ] {
            assert!(
                endpoint(42, host, 4433).endpoint(Some(42)).is_err(),
                "accepted {host:?}"
            );
        }
        let mut invalid_key = endpoint(42, "owner.example.org", 4433);
        invalid_key.public_key = "AQID".into();
        assert!(invalid_key.endpoint(Some(42)).is_err());
    }

    #[test]
    fn call_control_preserves_binary_envelopes_and_refuses_other_protocol_operations() {
        let map = TypeMap::latest();
        let frame = CommunicationValue::new(CommunicationType::CallToken)
            .add_typed_default(DataType::CallId, DataValue::Str("call-fixture".into()))
            .add_typed_default(
                DataType::CallSecret,
                DataValue::Container(vec![
                    (
                        DataType::EncryptedSecret.try_to_id(&map).unwrap(),
                        DataValue::Bytes(vec![0, 255, 1]),
                    ),
                    (
                        DataType::KemCiphertext.try_to_id(&map).unwrap(),
                        DataValue::Bytes(vec![255, 0]),
                    ),
                ]),
            );
        let bytes = frame.to_bytes().unwrap();
        assert_eq!(
            super::call_control_frame(&bytes, &map)
                .unwrap()
                .to_bytes()
                .unwrap(),
            bytes
        );
        for kind in [
            CommunicationType::Relay,
            CommunicationType::MessageSend,
            CommunicationType::Disconnect,
        ] {
            let bytes = CommunicationValue::new(kind).to_bytes().unwrap();
            assert!(super::call_control_frame(&bytes, &map).is_err());
        }
        assert!(super::call_control_frame(&[255], &map).is_err());
    }

    #[tokio::test]
    async fn owner_routing_cannot_start_without_a_current_authenticated_generation() {
        let error = super::mtp_send_call_control(42, 0, "0".repeat(64), vec![], 30_000, None)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "Native call control is not authenticated for this generation"
        );
    }

    #[test]
    fn call_control_decodes_the_application_wasm_golden_frame() {
        // Encoded by the built application's protocol 1.1 WASM codec.
        let bytes = decode_sdk_bytes("0000006b005c01000000110900020040060000000c63616c6c2d6669787475726500420900050086060000000e7365637265742d66697874757265008704000000000000000000000000000000010088070000000300ff01008c0700000002ff000089060000000766697874757265").unwrap();
        let frame = super::call_control_frame(&bytes, &TypeMap::latest()).unwrap();
        assert!(frame.is_type(CommunicationType::CallToken));
        assert_eq!(frame.id(), Some(17));
        assert_eq!(
            frame.get_data(DataType::CallId).and_then(DataValue::as_str),
            Some("call-fixture")
        );
        let secret = frame.get_data(DataType::CallSecret).unwrap();
        assert_eq!(
            super::container_value(secret, DataType::SecretId).and_then(DataValue::as_str),
            Some("secret-fixture")
        );
        assert_eq!(
            super::container_value(secret, DataType::EncryptedSecret),
            Some(&DataValue::Bytes(vec![0, 255, 1]))
        );
        assert_eq!(
            super::container_value(secret, DataType::KemCiphertext),
            Some(&DataValue::Bytes(vec![255, 0]))
        );
        assert_eq!(frame.to_bytes().unwrap(), bytes);
    }

    #[test]
    fn browser_base64_accepts_file_whitespace_and_missing_padding() {
        assert_eq!(decode_browser_base64(" AQID\r\n").unwrap(), [1, 2, 3]);
        assert_eq!(decode_browser_base64("AQI").unwrap(), [1, 2]);
    }

    #[test]
    fn sdk_bytes_accept_hex_and_base64() {
        assert_eq!(decode_sdk_bytes("0x01:02-ff").unwrap(), [1, 2, 255]);
        assert_eq!(decode_sdk_bytes("AQI=").unwrap(), [1, 2]);
    }

    #[test]
    fn iota_relay_target_encodes_its_namespace() {
        assert_eq!(
            RelayTargetDto::Iota { id: 42 }.wire_id().unwrap(),
            0x8000_0000_0000_002a
        );
    }

    #[test]
    fn relay_target_rejects_raw_or_out_of_range_ids() {
        assert!(RelayTargetDto::Iota { id: 0 }.wire_id().is_err());
        assert!(RelayTargetDto::User { id: 1_u64 << 48 }.wire_id().is_err());
    }

    #[test]
    fn json_content_uses_content_wire_type() {
        let frame = json_to_frame(
            "MessageEdit",
            json!({
                "Content": "ciphertext",
                "ChatPartnerId": 42,
                "SendTime": 10,
            }),
            1,
            &TypeMap::latest(),
        )
        .unwrap();

        assert_eq!(
            frame
                .get_data(DataType::Content)
                .and_then(DataValue::as_str),
            Some("ciphertext")
        );
    }

    #[test]
    fn nested_json_content_uses_content_wire_type() {
        let frame = json_to_frame(
            "MessageEdit",
            json!({
                "Message": { "Content": "ciphertext" },
            }),
            1,
            &TypeMap::latest(),
        )
        .unwrap();
        let message = frame.get_data(DataType::Message).unwrap();

        assert_eq!(
            container_value_by_name(message, "Content").and_then(DataValue::as_str),
            Some("ciphertext")
        );
    }

    #[tokio::test]
    async fn sealed_send_requires_an_authenticated_current_generation() {
        let request = serde_json::from_value(serde_json::json!({
            "typeName": "MessageSend", "data": {},
            "nextHop": { "kind": "iota", "id": 1 },
            "finalRecipientId": 7,
            "metadataRecipients": [], "contentRecipients": []
        }));
        let request = request.expect("valid sealed relay request fixture");
        assert_eq!(
            super::mtp_prepare_sealed_relay(request, 0, "0".repeat(64))
                .await
                .unwrap_err(),
            "MTP session is not authenticated for this generation"
        );
        assert_eq!(
            super::mtp_send_prepared_relay(vec![], 0, "0".repeat(64))
                .await
                .unwrap_err(),
            "MTP session is not authenticated for this generation"
        );
    }

    #[test]
    fn prepared_relay_keeps_its_encrypted_body_when_recorrelated_and_refuses_other_operations() {
        use mtp::{
            codec::SealedRelayBuilder,
            crypto::{DualSigner, Keyring},
        };
        let map = TypeMap::latest();
        let sender = Keyring::generate();
        let recipient = Keyring::generate();
        let signer = DualSigner::new(
            &sender.sig_cl_secret_key,
            &sender.sig_pq_secret_key,
            &sender.sig_pq_public_key,
        )
        .unwrap();
        let content = CommunicationValue::new_with_type_map(CommunicationType::MessageSend, &map)
            .add_typed_default(DataType::Content, DataValue::Str("YQ==".into()));
        let frame = SealedRelayBuilder::new(
            CommunicationType::MessageSend,
            content.into_payload(),
            7,
            9,
            12,
            &signer,
        )
        .type_map(&map)
        .message_id(99u128)
        .created_at(123)
        .metadata_recipients(vec![recipient.public_key_bundle()])
        .content_recipients(vec![recipient.public_key_bundle()])
        .build()
        .unwrap();
        let bytes = frame.to_bytes().unwrap();
        let restored = super::prepared_relay_frame(&bytes, &map).unwrap();
        assert_eq!(restored.to_bytes().unwrap(), bytes);
        let correlated = restored.with_id(77);
        assert_eq!(correlated.id(), Some(77));
        assert_eq!(correlated.payload(), frame.payload());
        for kind in [
            CommunicationType::MessageSend,
            CommunicationType::Disconnect,
            CommunicationType::Ping,
        ] {
            let bytes = CommunicationValue::new_with_type_map(kind, &map)
                .to_bytes()
                .unwrap();
            assert!(super::prepared_relay_frame(&bytes, &map).is_err());
        }
        assert!(super::prepared_relay_frame(&[255], &map).is_err());
    }
}

#[tauri::command]
pub async fn mtp_prepare_sealed_relay(
    request: SealedRelayRequest,
    generation: u64,
    dictionary_fingerprint: String,
) -> Result<Vec<u8>, String> {
    let _credentials = CREDENTIALS_LOCK.lock().await;
    let connection = relay_session(generation, &dictionary_fingerprint).await?;
    let frame = prepare_sealed_relay(request, &connection).await?;
    if !Arc::ptr_eq(
        &connection,
        &relay_session(generation, &dictionary_fingerprint).await?,
    ) {
        return Err("MTP session changed during relay preparation".into());
    }
    frame.to_bytes().map_err(|error| error.to_string())
}

async fn relay_session(
    generation: u64,
    dictionary: &str,
) -> Result<Arc<tauri_plugin_mtp::Session>, String> {
    let require_generation = || {
        let snapshot = manager().snapshot();
        if snapshot.generation != generation
            || !snapshot.identified
            || snapshot.ready_state != CONNECTED
        {
            return Err("MTP session is not authenticated for this generation".to_string());
        }
        Ok(())
    };
    require_generation()?;
    let connection = crate::mtp_plugin::manager()
        .registry
        .attach(crate::mtp_plugin::CONNECTION_NAME)
        .await
        .ok_or("MTP is not connected")?;
    require_generation()?;
    if connection
        .connection()
        .codec
        .type_map()
        .fingerprint_hex()
        .as_deref()
        != Some(dictionary)
    {
        return Err("MTP relay dictionary does not match the authenticated session".into());
    }
    Ok(connection)
}

fn prepared_relay_frame(bytes: &[u8], map: &TypeMap) -> Result<CommunicationValue, String> {
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Relay frame exceeds the message budget".into());
    }
    let frame =
        CommunicationValue::from_bytes_with(bytes, map).map_err(|error| error.to_string())?;
    if !frame.is_type(CommunicationType::Relay) {
        return Err("Prepared relay transmission requires a Relay frame".into());
    }
    Ok(frame)
}

#[tauri::command]
pub async fn mtp_send_prepared_relay(
    frame: Vec<u8>,
    generation: u64,
    dictionary_fingerprint: String,
) -> Result<Vec<u8>, String> {
    let _credentials = CREDENTIALS_LOCK.lock().await;
    let connection = relay_session(generation, &dictionary_fingerprint).await?;
    let frame = prepared_relay_frame(&frame, connection.connection().codec.type_map())?;
    // Session::request assigns a fresh outer correlation ID. The signed relay
    // message ID and encrypted body remain exactly those persisted by the UI.
    let response = connection
        .request(frame, None, INITIAL_SYNC_TIMEOUT)
        .await
        .map_err(|error| error.to_string())?;
    if !Arc::ptr_eq(
        &connection,
        &relay_session(generation, &dictionary_fingerprint).await?,
    ) {
        return Err("MTP session changed during prepared relay request".into());
    }
    response.to_bytes().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn mtp_refresh_state() -> Result<Value, String> {
    let before = manager().snapshot();
    if !before.identified || before.ready_state != CONNECTED {
        return Err("MTP session is not authenticated".into());
    }
    let session = crate::mtp_plugin::manager()
        .registry
        .attach(crate::mtp_plugin::CONNECTION_NAME)
        .await
        .ok_or("MTP is not connected")?;
    let state = crate::mtp_plugin::synchronize(&session).await?;
    let after = manager().snapshot();
    if before.generation != after.generation || !after.identified || after.ready_state != CONNECTED
    {
        return Err("MTP session changed during account refresh".into());
    }
    Ok(state)
}

#[tauri::command]
pub fn mtp_status() -> MtpSnapshot {
    manager().snapshot()
}

#[tauri::command]
pub async fn mtp_frontend_options() -> Result<Value, String> {
    let lifecycle = tauri_plugin_mtp::mobile::lifecycle().ok_or("native lifecycle unavailable")?;
    let identities = lifecycle.identities.entries.lock().await;
    let identity = identities
        .get(crate::mtp_plugin::CONNECTION_NAME)
        .ok_or("native identity unavailable")?;
    let mut options = identity.options.clone();
    // Reuse the exact restored configuration without exporting private keys.
    options.credentials = None;
    let mut options = serde_json::to_value(options).map_err(|error| error.to_string())?;
    // SDK credentials:null requests a fresh anonymous identity, not restoration.
    options
        .as_object_mut()
        .ok_or("invalid frontend options")?
        .retain(|key, value| key != "credentials" && !value.is_null());
    Ok(options)
}

#[tauri::command]
pub async fn mtp_store_credentials(config: MtpConfig) -> Result<(), String> {
    let _credentials = CREDENTIALS_LOCK.lock().await;
    let config = validate_config(config)?;
    let serialized = serde_json::to_string(&config).map_err(|error| error.to_string())?;
    manager().stop();
    if let Some(lifecycle) = tauri_plugin_mtp::mobile::lifecycle() {
        lifecycle.remove(crate::mtp_plugin::CONNECTION_NAME).await;
        lifecycle
            .identities
            .entries
            .lock()
            .await
            .remove(crate::mtp_plugin::CONNECTION_NAME);
    }
    store_native_config(&serialized)?;
    *manager().config.write().expect("config lock poisoned") = Some(config);
    manager().enabled.store(true, Ordering::SeqCst);
    initialize_plugin_connection().await?;
    Ok(())
}

#[tauri::command]
pub async fn mtp_clear_credentials() -> Result<(), String> {
    let _credentials = CREDENTIALS_LOCK.lock().await;
    manager().stop();
    if let Some(lifecycle) = tauri_plugin_mtp::mobile::lifecycle() {
        lifecycle.remove(crate::mtp_plugin::CONNECTION_NAME).await;
        lifecycle
            .identities
            .entries
            .lock()
            .await
            .remove(crate::mtp_plugin::CONNECTION_NAME);
    }
    *manager().config.write().expect("config lock poisoned") = None;
    clear_native_config()
}

#[tauri::command]
pub async fn mtp_has_credentials() -> Result<bool, String> {
    if let Some(lifecycle) = tauri_plugin_mtp::mobile::lifecycle() {
        if lifecycle
            .identities
            .entries
            .lock()
            .await
            .contains_key(crate::mtp_plugin::CONNECTION_NAME)
        {
            return Ok(true);
        }
    }
    has_native_config()
}

#[tauri::command]
pub async fn mtp_restore_credentials() -> Result<bool, String> {
    let _credentials = CREDENTIALS_LOCK.lock().await;
    let lifecycle = tauri_plugin_mtp::mobile::lifecycle().ok_or("lifecycle unavailable")?;
    if lifecycle
        .identities
        .entries
        .lock()
        .await
        .contains_key(crate::mtp_plugin::CONNECTION_NAME)
    {
        manager().enabled.store(true, Ordering::SeqCst);
        if restore_cached_state().is_err() {
            manager().log(1, "Saved account state is unavailable", None);
        }
        return Ok(true);
    }
    #[cfg(target_os = "android")]
    {
        let Some(serialized) = load_native_config()? else {
            return Ok(false);
        };
        let config = serde_json::from_str(serialized.as_str())
            .map_err(|error| format!("invalid stored MTP config: {error}"))?;
        let config = validate_config(config)?;
        *manager().config.write().expect("config lock poisoned") = Some(config);
        initialize_plugin_connection().await?;
        if restore_cached_state().is_err() {
            manager().log(1, "Saved account state is unavailable", None);
        }
        Ok(true)
    }
    #[cfg(not(target_os = "android"))]
    {
        let Some(mut stored) = crate::mtp_credentials::load()? else {
            return Ok(false);
        };
        *manager().config.write().expect("config lock poisoned") = Some(stored.config.clone());
        if let Some(connection) = stored.connection.take() {
            lifecycle.start(vec![connection]).await?;
        } else {
            initialize_plugin_connection().await?;
        }
        if restore_cached_state().is_err() {
            manager().log(1, "Saved account state is unavailable", None);
        }
        Ok(true)
    }
}

#[tauri::command]
pub fn mtp_is_ignoring_battery_optimizations() -> Result<bool, String> {
    android_is_ignoring_battery_optimizations()
}

#[tauri::command]
pub fn mtp_request_battery_exemption() -> Result<(), String> {
    android_request_battery_exemption()
}

#[tauri::command]
pub fn mtp_set_ui_visible(visible: bool) {
    manager().set_ui_visible(visible);
}

#[tauri::command]
pub fn mtp_post_message_notification(
    sender_id: u64,
    sender: String,
    body: String,
    avatar: Option<String>,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let avatar = avatar.as_deref().map(decode_browser_base64).transpose()?;
        android_notify(sender_id, &sender, &body, avatar.as_deref())?;
        Ok(true)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (sender_id, sender, body, avatar);
        Ok(false)
    }
}

#[cfg(not(target_os = "android"))]
fn store_native_config(serialized: &str) -> Result<(), String> {
    crate::mtp_credentials::store_config(serialized)
}
#[cfg(not(target_os = "android"))]
fn clear_native_config() -> Result<(), String> {
    crate::mtp_credentials::clear()
}
#[cfg(not(target_os = "android"))]
fn has_native_config() -> Result<bool, String> {
    if manager()
        .config
        .read()
        .expect("config lock poisoned")
        .is_some()
    {
        return Ok(true);
    }
    Ok(crate::mtp_credentials::load()?.is_some())
}
#[cfg(not(target_os = "android"))]
fn android_notify(_: u64, _: &str, _: &str, _: Option<&[u8]>) -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "android"))]
fn android_cancel_notification(_: u64) -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "android"))]
fn android_is_ignoring_battery_optimizations() -> Result<bool, String> {
    Ok(true)
}
#[cfg(not(target_os = "android"))]
fn android_request_battery_exemption() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "android")]
mod android {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    };

    use jni::{
        jni_sig, jni_str,
        objects::{Global, JClass, JObject, JString, JValue},
        Env, EnvUnowned, JavaVM,
    };
    use serde_json::Value;
    use tauri::Manager;

    pub struct Host {
        vm: JavaVM,
        context: Global<JObject<'static>>,
        bridge: Global<JObject<'static>>,
    }

    static HOST: OnceLock<Host> = OnceLock::new();
    static ACTIVITY_VISIBLE: AtomicBool = AtomicBool::new(false);

    pub fn attach(env: &mut Env, context: JObject) -> Result<(), String> {
        if HOST.get().is_some() {
            return Ok(());
        }
        let class = env
            .find_class(jni_str!("net/tensamin/client/NativeMtpBridge"))
            .map_err(|e| e.to_string())?;
        let bridge = env
            .get_static_field(
                class,
                jni_str!("INSTANCE"),
                jni_sig!("Lnet/tensamin/client/NativeMtpBridge;"),
            )
            .and_then(|value| value.l())
            .map_err(|e| e.to_string())?;
        HOST.set(Host {
            vm: env.get_java_vm().map_err(|e| e.to_string())?,
            context: env.new_global_ref(context).map_err(|e| e.to_string())?,
            bridge: env.new_global_ref(bridge).map_err(|e| e.to_string())?,
        })
        .map_err(|_| "Android MTP host is already attached".to_string())
    }

    fn with_env<T>(call: impl FnOnce(&mut Env, &Host) -> Result<T, String>) -> Result<T, String> {
        let host = HOST.get().ok_or("Android MTP host is not attached")?;
        host.vm
            .attach_current_thread(|env| Ok::<_, jni::errors::Error>(call(env, host)))
            .map_err(|e| e.to_string())?
    }

    pub fn store_config(config: &str) -> Result<(), String> {
        with_env(|env, host| {
            let value = env.new_string(config).map_err(|e| e.to_string())?;
            env.call_method(
                host.bridge.as_obj(),
                jni_str!("storeConfig"),
                jni_sig!("(Landroid/content/Context;Ljava/lang/String;)V"),
                &[
                    JValue::Object(host.context.as_obj()),
                    JValue::Object(&value),
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    pub fn files_directory() -> Result<std::path::PathBuf, String> {
        with_env(|env, host| {
            let file = env
                .call_method(
                    host.context.as_obj(),
                    jni_str!("getFilesDir"),
                    jni_sig!("()Ljava/io/File;"),
                    &[],
                )
                .and_then(|value| value.l())
                .map_err(|error| error.to_string())?;
            let path = env
                .call_method(
                    &file,
                    jni_str!("getAbsolutePath"),
                    jni_sig!("()Ljava/lang/String;"),
                    &[],
                )
                .and_then(|value| value.l())
                .map_err(|error| error.to_string())?;
            let path = env
                .cast_local::<JString>(path)
                .map_err(|error| error.to_string())?;
            path.mutf8_chars(env)
                .map(|value| std::path::PathBuf::from(value.to_str().as_ref()))
                .map_err(|error| error.to_string())
        })
    }

    pub fn clear_config() -> Result<(), String> {
        with_env(|env, host| {
            env.call_method(
                host.bridge.as_obj(),
                jni_str!("clearConfig"),
                jni_sig!("(Landroid/content/Context;)V"),
                &[JValue::Object(host.context.as_obj())],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    pub fn load_config() -> Result<Option<String>, String> {
        with_env(|env, host| {
            let value = env
                .call_method(
                    host.bridge.as_obj(),
                    jni_str!("loadConfig"),
                    jni_sig!("(Landroid/content/Context;)Ljava/lang/String;"),
                    &[JValue::Object(host.context.as_obj())],
                )
                .and_then(|value| value.l())
                .map_err(|e| e.to_string())?;
            if value.is_null() {
                return Ok(None);
            }
            let value = env
                .cast_local::<JString>(value)
                .map_err(|e| e.to_string())?;
            value
                .mutf8_chars(env)
                .map(|value| Some(value.to_str().into_owned()))
                .map_err(|e| e.to_string())
        })
    }

    pub fn root_certificates() -> Result<Vec<u8>, String> {
        with_env(|env, host| {
            let value = env
                .call_method(
                    host.bridge.as_obj(),
                    jni_str!("trustedCertificates"),
                    jni_sig!("()Ljava/lang/String;"),
                    &[],
                )
                .and_then(|value| value.l())
                .map_err(|e| e.to_string())?;
            let value = env
                .cast_local::<JString>(value)
                .map_err(|e| e.to_string())?;
            value
                .mutf8_chars(env)
                .map(|value| value.to_str().as_bytes().to_vec())
                .map_err(|e| e.to_string())
        })
    }

    pub fn has_config() -> Result<bool, String> {
        with_env(|env, host| {
            env.call_method(
                host.bridge.as_obj(),
                jni_str!("hasConfig"),
                jni_sig!("(Landroid/content/Context;)Z"),
                &[JValue::Object(host.context.as_obj())],
            )
            .and_then(|value| value.z())
            .map_err(|e| e.to_string())
        })
    }

    pub fn notify(
        sender_id: u64,
        sender: &str,
        body: &str,
        avatar: Option<&[u8]>,
    ) -> Result<(), String> {
        with_env(|env, host| {
            let sender = env.new_string(sender).map_err(|e| e.to_string())?;
            let body = env.new_string(body).map_err(|e| e.to_string())?;
            let avatar = env
                .byte_array_from_slice(avatar.unwrap_or_default())
                .map_err(|e| e.to_string())?;
            env.call_method(
                host.bridge.as_obj(),
                jni_str!("postMessageNotification"),
                jni_sig!("(Landroid/content/Context;JLjava/lang/String;Ljava/lang/String;[B)V"),
                &[
                    JValue::Object(host.context.as_obj()),
                    JValue::Long(sender_id as i64),
                    JValue::Object(&sender),
                    JValue::Object(&body),
                    JValue::Object(&avatar),
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    pub fn cancel_notification(sender_id: u64) -> Result<(), String> {
        with_env(|env, host| {
            env.call_method(
                host.bridge.as_obj(),
                jni_str!("cancelMessageNotification"),
                jni_sig!("(Landroid/content/Context;J)V"),
                &[
                    JValue::Object(host.context.as_obj()),
                    JValue::Long(sender_id as i64),
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    pub fn is_ignoring_battery_optimizations() -> Result<bool, String> {
        with_env(|env, host| {
            env.call_method(
                host.bridge.as_obj(),
                jni_str!("isIgnoringBatteryOptimizations"),
                jni_sig!("(Landroid/content/Context;)Z"),
                &[JValue::Object(host.context.as_obj())],
            )
            .and_then(|value| value.z())
            .map_err(|e| e.to_string())
        })
    }

    pub fn request_battery_exemption() -> Result<(), String> {
        with_env(|env, host| {
            env.call_method(
                host.bridge.as_obj(),
                jni_str!("requestBatteryExemption"),
                jni_sig!("(Landroid/content/Context;)V"),
                &[JValue::Object(host.context.as_obj())],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    #[no_mangle]
    pub extern "system" fn Java_net_tensamin_client_NativeMtpBridge_nativeAttach<'caller>(
        mut env: EnvUnowned<'caller>,
        _class: JClass,
        context: JObject<'caller>,
    ) {
        let _ = env.with_env(|env| {
            let _ = attach(env, context);
            Ok::<_, jni::errors::Error>(())
        });
        let manager = super::manager();
        let Some(app) = manager.app.read().expect("app lock poisoned").clone() else {
            return;
        };
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if !ACTIVITY_VISIBLE.load(Ordering::SeqCst)
                || handle.get_webview_window("main").is_some()
            {
                return;
            }
            let Some(config) = handle
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
            else {
                return;
            };
            if let Err(error) = tauri::WebviewWindowBuilder::from_config(&handle, config)
                .and_then(|builder| builder.build())
            {
                manager.log(
                    0,
                    "Failed to restore Android window",
                    Some(Value::String(error.to_string())),
                );
            }
        }) {
            manager.log(
                0,
                "Failed to schedule Android window restoration",
                Some(Value::String(error.to_string())),
            );
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_net_tensamin_client_NativeMtpBridge_nativeSetUiState(
        _env: EnvUnowned,
        _class: JClass,
        visible: jni::sys::jboolean,
    ) {
        ACTIVITY_VISIBLE.store(visible, Ordering::SeqCst);
        super::manager().set_ui_visible(visible);
    }

    #[no_mangle]
    pub extern "system" fn Java_net_tensamin_client_NativeMtpBridge_nativeLog<'caller>(
        mut env: EnvUnowned<'caller>,
        _class: JClass,
        level: jni::sys::jint,
        message: JString<'caller>,
        details: JString<'caller>,
    ) {
        let _ = env.with_env(|env| {
            if let (Ok(message), Ok(details)) = (message.mutf8_chars(env), details.mutf8_chars(env))
            {
                let message = message.to_str();
                let details = details.to_str();
                super::manager().log(
                    level.clamp(0, 3) as u8,
                    message.into_owned(),
                    (!details.is_empty()).then(|| Value::String(details.into_owned())),
                );
            }
            Ok::<_, jni::errors::Error>(())
        });
    }
}

#[cfg(target_os = "android")]
use android::{
    cancel_notification as android_cancel_notification, clear_config as clear_native_config,
    has_config as has_native_config,
    is_ignoring_battery_optimizations as android_is_ignoring_battery_optimizations,
    load_config as load_native_config, notify as android_notify,
    request_battery_exemption as android_request_battery_exemption,
    store_config as store_native_config,
};
