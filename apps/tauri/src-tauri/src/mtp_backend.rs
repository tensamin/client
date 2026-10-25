use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, OnceLock, RwLock,
};
use std::time::Duration;

use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine as _,
};
use mtp::client::ClientConfig;
use mtp::codec::{
    CommunicationType, CommunicationValue, DataType, DataValue, SealedRelayBuilder, TypeMap,
};
use mtp::common::MessageId;
use mtp::crypto::{
    derive_encryption_key, AeadDecrypt, ChaCha20Poly1305, DualSigner, HybridKem, Keyring,
    PublicKeyBundle,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

const EVENT_NAME: &str = "tensamin://mtp";
const DISCONNECTED: u8 = 0;
const CONNECTED: u8 = 2;
const CHAT_SECRET_SALT: &[u8] = b"tensamin-chat-secret-v1";
const CHAT_MESSAGE_SALT: &[u8] = b"tensamin-chat-message-v1";
const CHAT_SECRET_SCHEME: &str = "mtp-chat-secret-kem-chacha20poly1305-hkdf-sha256-v1";
const INITIAL_SYNC_TIMEOUT: Duration = Duration::from_secs(30);
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
    ui_visible: AtomicBool,
    app: RwLock<Option<AppHandle>>,
}

static MANAGER: OnceLock<MtpManager> = OnceLock::new();
static PLUGIN_NOTIFICATIONS: OnceLock<
    mpsc::Sender<(
        u64,
        Arc<Keyring>,
        Arc<tauri_plugin_mtp::Session>,
        CommunicationValue,
    )>,
> = OnceLock::new();

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
        *self.snapshot.write().expect("snapshot lock poisoned") = snapshot.clone();
        self.emit(MtpEvent::State { snapshot });
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

async fn initialize_plugin_connection() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let roots = std::env::temp_dir().join("tensamin-android-ca-certificates.pem");
        std::fs::write(&roots, android_root_certificates()?).map_err(|error| error.to_string())?;
        std::env::set_var("SSL_CERT_FILE", roots);
    }
    let config = manager()
        .config
        .read()
        .map_err(|_| "config lock unavailable")?
        .clone()
        .ok_or("credentials unavailable")?;
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
    let config = manager()
        .config
        .read()
        .map_err(|_| "config lock unavailable")?
        .clone();
    #[cfg(target_os = "android")]
    let config = match config {
        Some(config) => Some(config),
        None => android_load_config()?
            .map(|serialized| serde_json::from_str(&serialized).map_err(|error| error.to_string()))
            .transpose()?
            .map(validate_config)
            .transpose()?,
    };
    let config = config.ok_or("discovery configuration unavailable")?;
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
            if let Some(session) = session {
                match crate::mtp_plugin::synchronize(&session).await {
                    Ok(state) => {
                        manager().enabled.store(true, Ordering::SeqCst);
                        manager().set_snapshot(MtpSnapshot {
                            generation: manager().generation.fetch_add(1, Ordering::SeqCst) + 1,
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
            } else {
                manager().set_snapshot(MtpSnapshot {
                    generation: manager().generation.load(Ordering::SeqCst),
                    ..MtpSnapshot::default()
                });
            }
            if sessions.changed().await.is_err() {
                break;
            }
        }
    });
}

pub fn validated_plugin_state(frame: &CommunicationValue) -> Result<Value, String> {
    let state = frame_data_to_json(frame)?;
    validate_account_state_snapshot(&state)?;
    Ok(state)
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
                let (sender, mut receiver) = mpsc::channel::<(
                    u64,
                    Arc<Keyring>,
                    Arc<tauri_plugin_mtp::Session>,
                    CommunicationValue,
                )>(NOTIFICATION_QUEUE_CAPACITY);
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

fn validate_config(config: MtpConfig) -> Result<MtpConfig, String> {
    let keyring_bytes = decode_browser_base64(&config.keyring)
        .map_err(|error| format!("invalid MTP keyring: {error}"))?;
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

fn validate_account_state_snapshot(state: &Value) -> Result<(), String> {
    let data = state
        .as_object()
        .ok_or("AccountStateSnapshot payload is not an object")?;
    for field in ["Contacts", "Communities", "Calls", "Messages"] {
        if !data.get(field).is_some_and(Value::is_array) {
            return Err(format!("ClientStateSync {field} must be an array"));
        }
    }
    for field in ["DeletedMessageIds", "DeletedContactIds"] {
        if let Some(value) = data.get(field) {
            let values = value
                .as_array()
                .ok_or_else(|| format!("ClientStateSync {field} must be an array"))?;
            if values.iter().any(|value| !value.is_number()) {
                return Err(format!("ClientStateSync {field} must contain numbers"));
            }
        }
    }
    validate_object_array(data, "Communities", |_| Ok(()))?;
    validate_object_array(data, "Contacts", validate_contact)?;
    validate_object_array(data, "Calls", validate_call)?;
    validate_object_array(data, "Messages", validate_message)?;
    Ok(())
}

fn validate_object_array(
    data: &Map<String, Value>,
    field: &str,
    validate: impl Fn(&Map<String, Value>) -> Result<(), String>,
) -> Result<(), String> {
    let values = data
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("ClientStateSync {field} must be an array"))?;
    for value in values {
        let object = value
            .as_object()
            .ok_or_else(|| format!("ClientStateSync {field} entries must be objects"))?;
        validate(object)?;
    }
    Ok(())
}

fn validate_contact(contact: &Map<String, Value>) -> Result<(), String> {
    if !contact.get("UserId").is_some_and(Value::is_number) {
        return Err("ClientStateSync contact omitted numeric UserId".into());
    }
    if let Some(messages) = contact.get("Messages") {
        let messages = messages
            .as_array()
            .ok_or("ClientStateSync contact Messages must be an array")?;
        for message in messages {
            validate_message(
                message
                    .as_object()
                    .ok_or("ClientStateSync contact message must be an object")?,
            )?;
        }
    }
    Ok(())
}

fn validate_call(call: &Map<String, Value>) -> Result<(), String> {
    if !call.get("CallId").is_some_and(Value::is_string) {
        return Err("ClientStateSync call omitted string CallId".into());
    }
    let members = call
        .get("CallMembers")
        .and_then(Value::as_array)
        .ok_or("ClientStateSync call omitted CallMembers array")?;
    if members.iter().any(|member| !member.is_number()) {
        return Err("ClientStateSync CallMembers must contain numbers".into());
    }
    Ok(())
}

fn validate_message(message: &Map<String, Value>) -> Result<(), String> {
    for field in ["SenderId", "SendTime"] {
        if !message.get(field).is_some_and(Value::is_number) {
            return Err(format!("ClientStateSync message omitted numeric {field}"));
        }
    }
    let content = message
        .get("Content")
        .and_then(Value::as_str)
        .ok_or("ClientStateSync message omitted string Content")?;
    STANDARD
        .decode(content)
        .or_else(|_| STANDARD_NO_PAD.decode(content))
        .map_err(|_| "ClientStateSync message Content must be base64".to_string())?;
    if let Some(state) = message.get("MessageState") {
        match state.as_str() {
            Some("read" | "received" | "sent" | "sending" | "awaiting") => {}
            _ => return Err("ClientStateSync message has invalid MessageState".into()),
        }
    }
    Ok(())
}

async fn resolve_endpoint(config: &MtpConfig) -> Result<(String, String), String> {
    if let (Some(url), Some(key)) = (
        config.forced_omikron_url.as_ref(),
        config.forced_omikron_public_key.as_ref(),
    ) {
        return Ok((url.clone(), key.clone()));
    }
    #[derive(Deserialize)]
    struct Omikron {
        ip_address: String,
        port: u16,
        public_key: String,
    }
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
    let response = client
        .build()
        .map_err(|error| error.to_string())?
        .get(format!("{root}/api/get/omikron/{}", config.user_id))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Omikron lookup failed: {}", response.status()));
    }
    let data: Omikron = response.json().await.map_err(|error| error.to_string())?;
    Ok((
        format!("https://{}:{}", data.ip_address, data.port),
        data.public_key,
    ))
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

async fn send_sealed_relay(request: SealedRelayRequest) -> Result<Value, String> {
    if request.metadata_recipients.is_empty() || request.content_recipients.is_empty() {
        return Err("sealed relay requires metadata and content recipients".into());
    }
    if request.final_recipient_id == 0 {
        return Err("sealed relay final recipient ID must be non-zero".into());
    }
    let connection = crate::mtp_plugin::manager()
        .registry
        .attach(crate::mtp_plugin::CONNECTION_NAME)
        .await
        .ok_or_else(|| "MTP is not connected".to_string())?;
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
    let type_map = TypeMap::latest();
    let message_type = communication_type(&request.type_name)?;
    let content = json_to_frame(&request.type_name, request.data, 1)?.into_payload();
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
    let frame = SealedRelayBuilder::new(
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
    .type_map(&type_map)
    .build()
    .map_err(|error| format!("failed to build sealed relay: {error}"))?;
    let response = connection
        .request(frame, None, INITIAL_SYNC_TIMEOUT)
        .await
        .map_err(|error| format!("sealed relay request failed: {error}"))?;
    frame_to_json(&response)
}

async fn notify_plugin_message(
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
    let chat_id = derive_chat_id(user_id, sender_id);
    let secret_id = format!("chat:{chat_id}:main");
    let secret_request = CommunicationValue::new(CommunicationType::GetChatSecret)
        .add_typed_default(DataType::UserId, DataValue::Str(user_id.to_string()))
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
    if secret.get_str(DataType::WrappingScheme) != Some(CHAT_SECRET_SCHEME) {
        return Err("unsupported chat secret wrapping scheme".into());
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

    let user_request = CommunicationValue::new(CommunicationType::GetUserData).add_typed_default(
        DataType::UserId,
        DataValue::UnsignedNumber(sender_id as u128),
    );
    let user = connection
        .request(user_request, None, INITIAL_SYNC_TIMEOUT)
        .await
        .map_err(|error| error.to_string())?;
    let sender = user
        .get_str(DataType::Display)
        .or_else(|| user.get_str(DataType::Username))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("User {sender_id}"));
    let avatar = user
        .get_str(DataType::Avatar)
        .and_then(|avatar| decode_browser_base64(avatar).ok());
    android_notify(
        sender_id,
        &sender,
        &String::from_utf8_lossy(&plaintext),
        avatar.as_deref(),
    )?;
    Ok(())
}

fn derive_chat_id(own: u64, peer: u64) -> String {
    format!("{}:{}", own.min(peer), own.max(peer))
}

fn decode_browser_base64(value: &str) -> Result<Vec<u8>, String> {
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
        if hex.len() % 2 != 0 {
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

fn container_value_by_name<'a>(value: &'a DataValue, field: &str) -> Option<&'a DataValue> {
    container_value(value, DataType::from_name(field)?)
}

fn communication_type(name: &str) -> Result<CommunicationType, String> {
    CommunicationType::from_name(name).ok_or_else(|| format!("unknown communication type: {name}"))
}

fn json_to_frame(type_name: &str, data: Value, id: u32) -> Result<CommunicationValue, String> {
    let comm_type = communication_type(type_name)?;
    let mut frame = CommunicationValue::new(comm_type).with_id(id);
    let Value::Object(fields) = data else {
        return Err("MTP request data must be an object".into());
    };
    for (name, value) in fields {
        let data_type =
            DataType::from_name(&name).ok_or_else(|| format!("unknown data type: {name}"))?;
        frame = frame.add_typed_default(data_type, json_to_data(&name, value)?);
    }
    Ok(frame)
}

fn json_to_data(field: &str, value: Value) -> Result<DataValue, String> {
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
                .map(|value| json_to_data(field, value))
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(fields) => {
            let mut entries = Vec::with_capacity(fields.len());
            for (name, value) in fields {
                let data_type = DataType::from_name(&name)
                    .ok_or_else(|| format!("unknown nested data type: {name}"))?;
                let id = data_type
                    .try_to_id(&TypeMap::latest())
                    .ok_or_else(|| format!("unmapped data type: {name}"))?;
                entries.push((id, json_to_data(&name, value)?));
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

fn frame_to_json(frame: &CommunicationValue) -> Result<Value, String> {
    let mut result = Map::new();
    if let Some(id) = frame.id() {
        result.insert("id".into(), Value::from(id));
    }
    result.insert(
        "type".into(),
        Value::String(frame.get_type_name().unwrap_or("Unknown").to_owned()),
    );
    result.insert("data".into(), frame_data_to_json(frame)?);
    Ok(Value::Object(result))
}

fn frame_data_to_json(frame: &CommunicationValue) -> Result<Value, String> {
    let map = frame.type_map().cloned().unwrap_or_else(TypeMap::latest);
    let mut result = Map::new();
    let entries = frame
        .data()
        .ok_or("MTP frame payload is not a data container")?;
    for (id, value) in entries {
        let name = map
            .data_type_name(id.0)
            .ok_or_else(|| format!("unknown data type id: {}", id.0))?;
        result.insert(name.to_owned(), data_to_json(value, &map)?);
    }
    Ok(Value::Object(result))
}

fn data_to_json(value: &DataValue, map: &TypeMap) -> Result<Value, String> {
    Ok(match value {
        DataValue::BoolTrue => Value::Bool(true),
        DataValue::BoolFalse => Value::Bool(false),
        DataValue::Bool(value) => Value::Bool(*value),
        DataValue::SignedNumber(value) => number_to_json(*value)?,
        DataValue::UnsignedNumber(value) => {
            number_to_json(i128::try_from(*value).map_err(|_| "number exceeds JSON range")?)?
        }
        DataValue::Float(value) => serde_json::Number::from_f64(*value)
            .map(Value::Number)
            .ok_or("invalid float")?,
        DataValue::Str(value) => Value::String(value.clone()),
        DataValue::Bytes(value) => Value::Array(value.iter().copied().map(Value::from).collect()),
        DataValue::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| data_to_json(value, map))
                .collect::<Result<_, _>>()?,
        ),
        DataValue::Container(entries) => {
            let mut object = Map::new();
            for (id, value) in entries {
                let name = map
                    .data_type_name(id.0)
                    .ok_or_else(|| format!("unknown nested data type id: {}", id.0))?;
                object.insert(name.to_owned(), data_to_json(value, map)?);
            }
            Value::Object(object)
        }
        DataValue::Null => Value::Null,
        _ => return Err("encrypted protocol values cannot cross the frontend bridge".into()),
    })
}

fn number_to_json(value: i128) -> Result<Value, String> {
    i64::try_from(value)
        .map(Value::from)
        .map_err(|_| "number exceeds JSON range".into())
}

#[cfg(test)]
mod tests {
    use mtp::codec::{CommunicationType, CommunicationValue, DataType, DataValue};
    use serde_json::json;

    use super::{
        container_value_by_name, decode_browser_base64, decode_sdk_bytes, frame_to_json,
        json_to_frame, validated_plugin_state, RelayTargetDto,
    };

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
        )
        .unwrap();
        let message = frame.get_data(DataType::Message).unwrap();

        assert_eq!(
            container_value_by_name(message, "Content").and_then(DataValue::as_str),
            Some("ciphertext")
        );
    }

    #[test]
    fn content_is_exposed_to_frontend() {
        let frame = CommunicationValue::new(CommunicationType::MessageEditLive)
            .with_id(1)
            .add_typed_default(DataType::Content, DataValue::Str("ciphertext".into()));

        let json = frame_to_json(&frame).unwrap();

        assert_eq!(json["data"]["Content"], "ciphertext");
    }

    fn valid_initial_state() -> CommunicationValue {
        CommunicationValue::new(CommunicationType::AccountStateSnapshot)
            .add_typed_default(DataType::SessionId, DataValue::UnsignedNumber(1))
            .add_typed_default(DataType::VersionNumber, DataValue::UnsignedNumber(0))
            .add_typed_default(DataType::CacheSchemaVersion, DataValue::UnsignedNumber(0))
            .add_typed_default(DataType::SyncMode, DataValue::Str("full".into()))
            .add_typed_default(DataType::Contacts, DataValue::Array(vec![]))
            .add_typed_default(DataType::Communities, DataValue::Array(vec![]))
            .add_typed_default(DataType::Calls, DataValue::Array(vec![]))
            .add_typed_default(DataType::Messages, DataValue::Array(vec![]))
    }

    #[test]
    fn valid_initial_state_is_validated() {
        let state = validated_plugin_state(&valid_initial_state()).unwrap();
        assert_eq!(state["SyncMode"], "full");
    }

    #[test]
    fn malformed_initial_state_does_not_prepare_ack() {
        let malformed = CommunicationValue::new(CommunicationType::AccountStateSnapshot)
            .add_typed_default(DataType::SessionId, DataValue::UnsignedNumber(1));

        assert!(validated_plugin_state(&malformed).is_err());
    }

    #[test]
    fn malformed_nested_initial_state_does_not_prepare_ack() {
        let malformed = CommunicationValue::new(CommunicationType::AccountStateSnapshot)
            .add_typed_default(DataType::SessionId, DataValue::UnsignedNumber(1))
            .add_typed_default(DataType::VersionNumber, DataValue::UnsignedNumber(0))
            .add_typed_default(DataType::CacheSchemaVersion, DataValue::UnsignedNumber(0))
            .add_typed_default(DataType::SyncMode, DataValue::Str("full".into()))
            .add_typed_default(
                DataType::Contacts,
                DataValue::Array(vec![DataValue::Container(vec![])]),
            )
            .add_typed_default(DataType::Communities, DataValue::Array(vec![]))
            .add_typed_default(DataType::Calls, DataValue::Array(vec![]))
            .add_typed_default(DataType::Messages, DataValue::Array(vec![]));

        assert!(validated_plugin_state(&malformed).is_err());
    }
}

#[tauri::command]
pub async fn mtp_send_sealed_relay(request: SealedRelayRequest) -> Result<Value, String> {
    send_sealed_relay(request).await
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
    options.as_object_mut().ok_or("invalid frontend options")?.retain(|key, value| key != "credentials" && !value.is_null());
    Ok(options)
}

#[tauri::command]
pub async fn mtp_store_credentials(config: MtpConfig) -> Result<(), String> {
    let config = validate_config(config)?;
    let serialized = serde_json::to_string(&config).map_err(|error| error.to_string())?;
    android_store_config(&serialized)?;
    *manager().config.write().expect("config lock poisoned") = Some(config);
    manager().enabled.store(true, Ordering::SeqCst);
    initialize_plugin_connection().await?;
    Ok(())
}

#[tauri::command]
pub async fn mtp_clear_credentials() -> Result<(), String> {
    if let Some(lifecycle) = tauri_plugin_mtp::mobile::lifecycle() {
        lifecycle.remove(crate::mtp_plugin::CONNECTION_NAME).await;
    }
    manager().stop();
    *manager().config.write().expect("config lock poisoned") = None;
    android_clear_config()
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
    android_has_config()
}

#[tauri::command]
pub async fn mtp_restore_credentials() -> Result<bool, String> {
    let lifecycle = tauri_plugin_mtp::mobile::lifecycle().ok_or("lifecycle unavailable")?;
    if lifecycle
        .identities
        .entries
        .lock()
        .await
        .contains_key(crate::mtp_plugin::CONNECTION_NAME)
    {
        manager().enabled.store(true, Ordering::SeqCst);
        return Ok(true);
    }
    #[cfg(target_os = "android")]
    {
        let Some(serialized) = android_load_config()? else {
            return Ok(false);
        };
        let config = serde_json::from_str(serialized.as_str())
            .map_err(|error| format!("invalid stored MTP config: {error}"))?;
        let config = validate_config(config)?;
        *manager().config.write().expect("config lock poisoned") = Some(config);
        initialize_plugin_connection().await?;
        Ok(true)
    }
    #[cfg(not(target_os = "android"))]
    {
        if manager()
            .config
            .read()
            .expect("config lock poisoned")
            .is_none()
        {
            return Ok(false);
        }
        initialize_plugin_connection().await?;
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
fn android_store_config(_: &str) -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "android"))]
fn android_clear_config() -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "android"))]
fn android_has_config() -> Result<bool, String> {
    Ok(manager()
        .config
        .read()
        .expect("config lock poisoned")
        .is_some())
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
    cancel_notification as android_cancel_notification, clear_config as android_clear_config,
    has_config as android_has_config,
    is_ignoring_battery_optimizations as android_is_ignoring_battery_optimizations,
    load_config as android_load_config, notify as android_notify,
    request_battery_exemption as android_request_battery_exemption,
    store_config as android_store_config,
};
