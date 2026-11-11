use super::*;

pub(super) fn call_control_frame(
    bytes: &[u8],
    map: &TypeMap,
) -> Result<CommunicationValue, String> {
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

pub(super) fn require_call_generation(generation: u64) -> Result<(), String> {
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
    // Owner sessions last only for the request and are never saved as another credential identity.
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
#[tauri::command]
pub fn mtp_pending_calls() -> Result<Vec<Vec<u8>>, String> {
    if !manager().snapshot().identified {
        return Err("Native session is not authenticated".into());
    }
    manager()
        .pending_calls
        .read()
        .map_err(|_| "Call invitations unavailable")?
        .pending
        .iter()
        .map(|frame| frame.to_bytes().map_err(|error| error.to_string()))
        .collect()
}

#[tauri::command]
pub fn mtp_dismiss_call_invite(
    call_id: String,
    generation: u64,
    credential_sha256: String,
) -> Result<(), String> {
    if call_id.is_empty() || call_id.len() > 128 {
        return Err("Invalid call invitation".into());
    }
    let config = current_config()?;
    if credential_fingerprint(&config)? != credential_sha256 {
        return Err("Call invitation belongs to another account".into());
    }
    let mut calls = manager()
        .pending_calls
        .write()
        .map_err(|_| "Call invitations unavailable")?;
    if manager().current_generation() != generation {
        return Err("Call invitation session changed".into());
    }
    calls.dismiss(&call_id);
    let id = u64::from_be_bytes(
        mtp::crypto::sha256(call_id.as_bytes())[..8]
            .try_into()
            .expect("SHA-256 prefix"),
    );
    if let Err(error) = android_cancel_notification(id) {
        manager().log(
            1,
            "Handled call alert could not be dismissed",
            Some(Value::String(error)),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn mtp_call_invite_handled(
    call_id: String,
    generation: u64,
    credential_sha256: String,
) -> Result<bool, String> {
    if call_id.is_empty() || call_id.len() > 128 {
        return Err("Invalid call invitation".into());
    }
    let config = current_config()?;
    if credential_fingerprint(&config)? != credential_sha256 {
        return Err("Call invitation belongs to another account".into());
    }
    let calls = manager()
        .pending_calls
        .read()
        .map_err(|_| "Call invitations unavailable")?;
    if manager().current_generation() != generation {
        return Err("Call invitation session changed".into());
    }
    Ok(calls.handled.iter().any(|id| id == &call_id))
}
