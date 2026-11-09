use mtp::{codec::CommunicationValue, common::CommunicationError};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
};
use tauri_plugin_mtp::{Endpoint, HostCallbacks, Manager, Session};

pub const CONNECTION_NAME: &str = "mtp:credentials";
static MANAGER: OnceLock<Arc<Manager>> = OnceLock::new();

pub fn manager() -> Arc<Manager> {
    MANAGER
        .get_or_init(|| {
            let manager = Manager::new(Arc::new(Callbacks));
            // Password enrollment and user-requested backups use the separately gated export capability.
            manager.set_credential_export(true);
            tauri_plugin_mtp::mobile::install(manager.clone()).expect("install MTP lifecycle");
            crate::mtp_backend::spawn_plugin_observer(manager.clone());
            manager
        })
        .clone()
}

#[cfg(target_os = "android")]
#[used]
#[link_section = ".init_array"]
static INITIALIZE: extern "C" fn() = {
    extern "C" fn initialize() {
        let _ = manager();
    }
    initialize
};

struct Callbacks;
impl HostCallbacks for Callbacks {
    fn persist<'a>(
        &'a self,
        connections: Vec<tauri_plugin_mtp::lifecycle::BackgroundConnection>,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            #[cfg(not(target_os = "android"))]
            {
                tokio::task::spawn_blocking(move || {
                    crate::mtp_credentials::persist_connections(connections)
                })
                .await
                .map_err(|error| error.to_string())?
            }
            #[cfg(target_os = "android")]
            {
                let _ = connections;
                Ok(())
            }
        })
    }
    fn resolve<'a>(
        &'a self,
        name: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Endpoint, CommunicationError>> + Send + 'a>> {
        Box::pin(async move {
            crate::mtp_backend::resolve_plugin_endpoint(name)
                .await
                .map_err(CommunicationError::Other)
        })
    }
    fn message<'a>(
        &'a self,
        name: &'a str,
        session: Arc<Session>,
        frame: CommunicationValue,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            if name == CONNECTION_NAME {
                crate::mtp_backend::handle_plugin_message(session, frame).await;
            }
        })
    }
}

/// Discover only authenticated account identity. Never request history or acknowledge a cursor.
pub async fn account_scope(session: &Session) -> Result<tau_relay_protocol::sync::Scope, String> {
    use mtp::codec::{CommunicationType, DataType, DataValue};
    use tau_relay_protocol::sync::{Request, Response};
    let map = session.connection().codec.type_map();
    let dictionary = map.fingerprint_hex().ok_or("MTP dictionary unavailable")?;
    let request = Request::Discover {
        device_id: "native-notifications".into(),
        dictionary: dictionary.clone(),
    };
    let frame = CommunicationValue::new_with_type_map(CommunicationType::AccountStateRequest, map)
        .add_typed_default(
            DataType::Json,
            DataValue::Bytes(serde_json::to_vec(&request).map_err(|error| error.to_string())?),
        );
    let response = session
        .request(
            frame,
            Some(CommunicationType::AccountStateSnapshot),
            crate::mtp_backend::INITIAL_SYNC_TIMEOUT,
        )
        .await
        .map_err(|error| error.to_string())?;
    if response.type_map() != Some(map) {
        return Err("Account identity dictionary changed".into());
    }
    let bytes = response
        .get_bytes(DataType::Json)
        .ok_or("Account identity omitted payload")?;
    if bytes.len() > 4096 {
        return Err("Account identity exceeds capacity".into());
    }
    let Response::Scope { scope } =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?
    else {
        return Err("Account identity unavailable".into());
    };
    if !scope.validate()
        || scope.dictionary != dictionary
        || scope.principal.user_id != session.connection().client_id
    {
        return Err("Account identity does not match authenticated transport".into());
    }
    Ok(scope)
}
