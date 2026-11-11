use super::*;

#[tauri::command]
pub fn mtp_status() -> MtpSnapshot {
    manager().snapshot()
}

#[tauri::command]
pub fn mtp_credential_metadata() -> Result<Value, String> {
    let config = current_config()?;
    let fingerprint = credential_fingerprint(&config)?;
    Ok(
        serde_json::json!({"userId":config.user_id,"omegaUrl":config.omega_url,"credentialSha256":fingerprint}),
    )
}

pub(super) fn credential_fingerprint(config: &MtpConfig) -> Result<String, String> {
    let bytes = zeroize::Zeroizing::new(decode_browser_base64(&config.keyring)?);
    Ok(mtp::crypto::sha256(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

#[tauri::command]
pub async fn mtp_refresh_identity() -> Result<(), String> {
    let snapshot = manager().snapshot();
    if !snapshot.identified {
        return Err("Native transport is not authenticated".into());
    }
    if snapshot.scope.is_some() {
        return Ok(());
    }
    let session = crate::mtp_plugin::manager()
        .registry
        .attach(crate::mtp_plugin::CONNECTION_NAME)
        .await
        .ok_or("Native transport is disconnected")?;
    let scope = crate::mtp_plugin::account_scope(&session).await?;
    manager().set_authenticated_scope(snapshot.generation, scope)
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
    let mut config = config;
    validate_config(&mut config)?;
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
        return Ok(true);
    }
    #[cfg(target_os = "android")]
    {
        let Some(serialized) = load_native_config()? else {
            return Ok(false);
        };
        let mut config = serde_json::from_str(serialized.as_str())
            .map_err(|error| format!("invalid stored MTP config: {error}"))?;
        validate_config(&mut config)?;
        *manager().config.write().expect("config lock poisoned") = Some(config);
        initialize_plugin_connection().await?;
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
pub fn mtp_set_call_active(active: bool, microphone: bool) -> Result<(), String> {
    manager().call_active.store(active, Ordering::SeqCst);
    #[cfg(target_os = "android")]
    android::set_call_active(active, microphone)?;
    #[cfg(not(target_os = "android"))]
    let _ = microphone;
    if active {
        manager().emit(MtpEvent::State {
            snapshot: manager().snapshot(),
        });
    }
    Ok(())
}
#[cfg(not(target_os = "android"))]
pub(super) fn store_native_config(serialized: &str) -> Result<(), String> {
    crate::mtp_credentials::store_config(serialized)
}
#[cfg(not(target_os = "android"))]
pub(super) fn clear_native_config() -> Result<(), String> {
    crate::mtp_credentials::clear()
}
#[cfg(not(target_os = "android"))]
pub(super) fn has_native_config() -> Result<bool, String> {
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
