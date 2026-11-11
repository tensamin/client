mod manager;
pub use manager::*;
mod config;
pub(crate) use config::*;
mod plugin;
pub use plugin::*;
mod calls;
pub use calls::*;
mod relay;
pub use relay::*;
mod notifications;
pub(crate) use notifications::*;
mod codec;
pub(crate) use codec::*;
mod credentials;
pub use credentials::*;
mod platform;
pub use platform::*;
#[cfg(target_os = "android")]
mod certificates;
#[cfg(target_os = "android")]
use certificates::*;
#[cfg(target_os = "android")]
mod android;

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

const EVENT_NAME: &str = "tensamin://mtp";
#[cfg(test)]
pub(crate) static TEST_LIFECYCLE: std::sync::Mutex<()> = std::sync::Mutex::new(());
static CREDENTIALS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static RELAY_WORK: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
static FILE_VISIBILITY: (std::sync::Mutex<()>, std::sync::Condvar) =
    (std::sync::Mutex::new(()), std::sync::Condvar::new());
static NOTIFICATION_TIMES: OnceLock<
    std::sync::Mutex<std::collections::VecDeque<(String, crate::mtp_relay::NotificationStamp)>>,
> = OnceLock::new();
const DISCONNECTED: u8 = 0;
const CONNECTED: u8 = 2;
const CHAT_SECRET_SALT: &[u8] = b"tensamin-chat-secret-v1";
const CHAT_MESSAGE_SALT: &[u8] = b"tensamin-chat-message-v1";
const CHAT_SECRET_SCHEME: &str = "mtp-chat-secret-kem-chacha20poly1305-hkdf-sha256-v1";
pub(crate) const INITIAL_SYNC_TIMEOUT: Duration = Duration::from_secs(30);
const ROUTE_TARGET_ID_MASK: u64 = (1_u64 << 48) - 1;
const USER_ROUTE_TARGET_KIND: u64 = 0x4000_0000_0000_0000;
const IOTA_ROUTE_TARGET_KIND: u64 = 0x8000_0000_0000_0000;

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
    pub scope: Option<tau_relay_protocol::sync::Scope>,
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

#[derive(Default)]
struct CallInvitations {
    pending: std::collections::VecDeque<CommunicationValue>,
    handled: std::collections::VecDeque<String>,
}

impl CallInvitations {
    fn remember(&mut self, call_id: &str, frame: CommunicationValue) -> bool {
        if self.handled.iter().any(|id| id == call_id) {
            return false;
        }
        self.pending
            .retain(|invite| invite.get_str(DataType::CallId) != Some(call_id));
        if self.pending.len() == 8 {
            self.pending.pop_front();
        }
        self.pending.push_back(frame);
        true
    }

    fn dismiss(&mut self, call_id: &str) {
        self.pending
            .retain(|invite| invite.get_str(DataType::CallId) != Some(call_id));
        if !self.handled.iter().any(|id| id == call_id) {
            if self.handled.len() == 128 {
                self.handled.pop_front();
            }
            self.handled.push_back(call_id.to_owned());
        }
    }
}

pub struct MtpManager {
    pub(crate) runtime: tokio::runtime::Runtime,
    config: RwLock<Option<MtpConfig>>,
    snapshot: RwLock<MtpSnapshot>,
    generation: AtomicU64,
    enabled: AtomicBool,
    pub(crate) ui_visible: AtomicBool,
    pub(crate) ui_generation: AtomicU64,
    call_active: AtomicBool,
    document_visible: AtomicBool,
    platform_visible: AtomicBool,
    pub(crate) viewed_conversation: RwLock<Option<String>>,
    notification_owner: RwLock<Option<(String, String)>>,
    pending_calls: RwLock<CallInvitations>,
    app: RwLock<Option<AppHandle>>,
}

static MANAGER: OnceLock<MtpManager> = OnceLock::new();

#[cfg(target_os = "android")]
use android::{
    cancel_notification as android_cancel_notification, clear_config as clear_native_config,
    has_config as has_native_config,
    is_ignoring_battery_optimizations as android_is_ignoring_battery_optimizations,
    load_config as load_native_config, notify as android_notify,
    request_battery_exemption as android_request_battery_exemption,
    store_config as store_native_config,
};
