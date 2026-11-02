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
    use tau_relay_protocol::sync::{Cursor, Request, Response};
    let directory = crate::mtp_backend::sync_directory()?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let device_file = directory.join("sync-device-id");
    let device_id = match std::fs::read_to_string(&device_file) {
        Ok(id) => id,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let id = uuid::Uuid::new_v4().to_string();
            std::fs::write(&device_file, &id).map_err(|error| error.to_string())?;
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
    {
        return Err("Account sync scope does not match this session".into());
    }
    let mut page = None;
    let mut boundary = None;
    let mut records = Vec::new();
    let mut bytes = 0;
    let (head, page_id) = loop {
        let response = exchange_sync(
            session,
            &Request::Snapshot {
                scope: scope.clone(),
                page: page.clone(),
                limit: 128,
            },
        )
        .await?;
        let Response::Snapshot {
            scope: returned,
            head,
            floor,
            page_id,
            next,
            records: items,
        } = response
        else {
            return Err("Account snapshot was not returned".into());
        };
        if returned != scope
            || floor < 0
            || head < floor
            || items.len() > 128
            || boundary
                .as_ref()
                .is_some_and(|previous| previous != &(head, page_id.clone()))
        {
            return Err("Account sync page does not match its scope".into());
        }
        bytes += serde_json::to_vec(&items).map_err(|e| e.to_string())?.len();
        let count = items.len();
        records.extend(items);
        if records.len() > 100_000 || bytes > 32 * 1024 * 1024 {
            return Err("Account snapshot exceeds capacity".into());
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
        boundary = Some((head, page_id));
        page = Some(next);
    };
    let state = serde_json::json!({ "scope": scope, "head": head, "records": records });
    let snapshot_path = directory.join(format!(
        "account-sync-{}-{}.json",
        scope.principal.authority.replace(':', "-"),
        scope.principal.user_id
    ));
    let temporary = snapshot_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut file, &state).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &snapshot_path).map_err(|error| error.to_string())?;
    std::fs::File::open(&directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
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
    if let tau_relay_protocol::sync::Response::Unavailable { error } = response {
        return Err(format!("Account synchronization: {error:?}"));
    }
    Ok(response)
}
