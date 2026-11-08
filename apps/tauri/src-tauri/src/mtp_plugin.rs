use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
    time::Duration,
};

use mtp::{
    codec::{CommunicationType, CommunicationValue, DataType, DataValue},
    common::CommunicationError,
};
use tauri_plugin_mtp::{Endpoint, HostCallbacks, Manager, Session};

pub const CONNECTION_NAME: &str = "mtp:credentials";
static MANAGER: OnceLock<Arc<Manager>> = OnceLock::new();
static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn manager() -> Arc<Manager> {
    MANAGER
        .get_or_init(|| {
            let manager = Manager::new(Arc::new(Callbacks));
            // Tensamin's password enrollment and device backups require serialization.
            // The separate export-credentials capability still gates every JS export.
            manager.set_credential_export(true);
            tauri_plugin_mtp::mobile::install(manager.clone()).expect("install MTP lifecycle");
            let observer = manager.clone();
            crate::mtp_backend::spawn_plugin_observer(observer);
            manager
        })
        .clone()
}

// Android also loads this cdylib in a boot-started service, before Tauri runs.
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
                // The plugin's Android command persists the same identity in its encrypted store.
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
            if name != CONNECTION_NAME {
                return;
            }
            crate::mtp_backend::handle_plugin_message(session, frame).await;
        })
    }
}

pub async fn synchronize(session: &Session) -> Result<serde_json::Value, String> {
    use crate::mtp_sync_cache::AccountSyncJournal;
    use tau_relay_protocol::sync::{Cursor, EventAction, Request, Response, SyncError};
    let config = crate::mtp_backend::current_config()?;
    let generation = crate::mtp_backend::manager().snapshot().generation;
    let _sync = SYNC_LOCK.lock().await;
    let active = manager().registry.attach(CONNECTION_NAME).await;
    if !active
        .as_ref()
        .is_some_and(|active| std::ptr::eq(active.as_ref(), session))
        || crate::mtp_backend::manager().snapshot().generation != generation
        || crate::mtp_backend::current_config()? != config
    {
        return Err("Native session changed before synchronization".into());
    }
    let directory = crate::mtp_backend::sync_directory()?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let device_file = directory.join(crate::mtp_sync_cache::DEVICE_ID_FILE);
    let device_id = match std::fs::read_to_string(&device_file) {
        Ok(id) => id,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            use std::io::Write;
            let id = uuid::Uuid::new_v4().to_string();
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&device_file)
                .map_err(|error| error.to_string())?;
            file.write_all(id.as_bytes())
                .map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            id
        }
        Err(error) => return Err(error.to_string()),
    };
    let dictionary = session
        .connection()
        .codec
        .type_map()
        .fingerprint_hex()
        .ok_or("MTP dictionary identity is unavailable")?;
    let discovered = exchange_sync(
        session,
        &Request::Discover {
            device_id: device_id.clone(),
            dictionary: dictionary.clone(),
        },
    )
    .await?;
    let Response::Scope { scope } = discovered else {
        return Err("Account sync scope was not returned".into());
    };
    if !scope.validate()
        || scope.device_id != device_id
        || scope.dictionary != dictionary
        || scope.principal.user_id != session.connection().client_id
        || scope.principal.user_id != config.user_id
    {
        return Err("Account sync scope does not match this session".into());
    }
    let mut cache = AccountSyncJournal::new(directory.clone(), &config, device_id)?;
    let after = cache.head(&scope);
    let mut resuming = after.is_some();
    let after = after.unwrap_or(0);
    if !resuming {
        cache.begin(scope.clone())?;
    }
    let mut sequence = after;
    let mut page = None;
    let mut boundary = None;
    let (head, page_id) = loop {
        let request = if resuming {
            Request::Delta {
                after: Cursor {
                    scope: scope.clone(),
                    sequence: after,
                },
                page: page.clone(),
                limit: 128,
            }
        } else {
            Request::Snapshot {
                scope: scope.clone(),
                page: page.clone(),
                limit: 128,
            }
        };
        let response = exchange_sync(session, &request).await?;
        if matches!(
            response,
            Response::Unavailable {
                error: SyncError::SnapshotRequired
            }
        ) && resuming
        {
            resuming = false;
            cache.begin(scope.clone())?;
            page = None;
            boundary = None;
            continue;
        }
        let mut snapshot_records = None;
        let mut delta_events = None;
        let (returned, head, floor, page_id, next, count) = match response {
            Response::Snapshot {
                scope,
                head,
                floor,
                page_id,
                next,
                records: items,
            } if !resuming => {
                let count = items.len();
                snapshot_records = Some(items);
                (scope, head, floor, page_id, next, count)
            }
            Response::Delta {
                scope: returned,
                head,
                floor,
                page_id,
                next,
                events,
            } if resuming => {
                if floor > after || head < sequence {
                    return Err("Account delta boundary is invalid".into());
                }
                let count = events.len();
                for event in &events {
                    if sequence.checked_add(1) != Some(event.sequence)
                        || event.sequence > head
                        || event.event_id
                            != format!(
                                "{}:{}:{}",
                                scope.principal.authority, scope.principal.user_id, event.sequence
                            )
                    {
                        return Err("Account delta is not contiguous".into());
                    }
                    match (event.operation, &event.record) {
                        (EventAction::Delete, None) => {}
                        (EventAction::Upsert, Some(record))
                            if record.entity == event.entity && record.key == event.key => {}
                        _ => return Err("Account delta record does not match its event".into()),
                    }
                    sequence = event.sequence;
                }
                delta_events = Some(events);
                (returned, head, floor, page_id, next, count)
            }
            Response::Unavailable { error } => {
                return Err(format!("Account synchronization: {error:?}"))
            }
            _ => return Err("Unexpected account synchronization response".into()),
        };
        if returned != scope
            || floor < 0
            || head < floor
            || count > 128
            || boundary
                .as_ref()
                .is_some_and(|previous| previous != &(head, floor, page_id.clone()))
        {
            return Err("Account sync page does not match its scope".into());
        }
        if let Some(records) = snapshot_records {
            cache.append(&records)?;
        }
        if let Some(events) = delta_events {
            cache.apply(&scope, &events, head)?;
        }
        let Some(next) = next else {
            break (head, page_id);
        };
        if !next.validate()
            || next.id != page_id
            || count == 0
            || next.offset != page.as_ref().map_or(0, |page| page.offset) + count as i64
        {
            return Err("Invalid account sync page token".into());
        }
        boundary = Some((head, floor, page_id));
        page = Some(next);
    };
    if resuming && sequence != head {
        return Err("Account delta omitted events".into());
    }
    let active = manager().registry.attach(CONNECTION_NAME).await;
    if !active
        .as_ref()
        .is_some_and(|active| std::ptr::eq(active.as_ref(), session))
        || crate::mtp_backend::current_config()? != config
    {
        return Err("Account changed during synchronization".into());
    }
    cache.commit(&scope, head, !resuming)?;
    let snapshot = cache
        .projection(None)?
        .ok_or("Account journal did not activate")?;
    let state = serde_json::to_value(snapshot).map_err(|error| error.to_string())?;
    let cursor = Cursor {
        scope,
        sequence: head,
    };
    match exchange_sync(
        session,
        &Request::Acknowledge {
            cursor: cursor.clone(),
            page_id,
        },
    )
    .await?
    {
        Response::Acknowledged { cursor: returned } if returned == cursor => Ok(state),
        _ => Err("Account sync acknowledgement does not match".into()),
    }
}

async fn exchange_sync(
    session: &Session,
    request: &tau_relay_protocol::sync::Request,
) -> Result<tau_relay_protocol::sync::Response, String> {
    if !request.validate() {
        return Err("Invalid account sync request".into());
    }
    let map = session.connection().codec.type_map();
    let frame = CommunicationValue::new_with_type_map(CommunicationType::AccountStateRequest, map)
        .add_typed_default(
            DataType::Json,
            DataValue::Bytes(serde_json::to_vec(request).map_err(|error| error.to_string())?),
        );
    let response = session
        .request(
            frame,
            Some(CommunicationType::AccountStateSnapshot),
            Duration::from_secs(30),
        )
        .await
        .map_err(|error| error.to_string())?;
    let Some([(id, DataValue::Bytes(bytes))]) = response.payload().container_entries() else {
        return Err("Invalid account sync response payload".into());
    };
    if response.type_map() != Some(map)
        || Some(*id) != DataType::Json.try_to_id(map)
        || bytes.len() > 1024 * 1024
    {
        return Err("Invalid account sync response dictionary or size".into());
    }
    let response: tau_relay_protocol::sync::Response =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    Ok(response)
}
