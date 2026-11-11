use super::*;

pub(super) async fn initialize_plugin_connection() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let roots = android::files_directory()?.join("tensamin-android-ca-certificates.pem");
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
            *manager()
                .notification_owner
                .write()
                .expect("Notification owner unavailable") = None;
            manager().set_snapshot(MtpSnapshot {
                generation,
                ..MtpSnapshot::default()
            });
            if let Some(session) = session {
                manager().enabled.store(true, Ordering::SeqCst);
                manager().set_snapshot(MtpSnapshot {
                    generation,
                    ready_state: CONNECTED,
                    identified: true,
                    ..MtpSnapshot::default()
                });
                let identity = tokio::select! {
                    result = crate::mtp_plugin::account_scope(&session) => result,
                    changed = sessions.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        continue;
                    }
                };
                match identity {
                    Ok(scope) => {
                        manager().enabled.store(true, Ordering::SeqCst);
                        manager().set_snapshot(MtpSnapshot {
                            generation,
                            ready_state: CONNECTED,
                            identified: true,
                            scope: Some(scope),
                            error: None,
                        });
                        crate::mtp_relay::wake_notifications();
                    }
                    Err(error) => {
                        manager().log(
                            0,
                            "Native account identity unavailable",
                            Some(Value::String(error)),
                        );
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
    if matches!(
        frame.get_comm_type_enum(),
        Some(CommunicationType::CallInvite | CommunicationType::CallEnded)
    ) {
        let generation = manager().current_generation();
        let active = crate::mtp_plugin::manager()
            .registry
            .attach(crate::mtp_plugin::CONNECTION_NAME)
            .await;
        if !active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &session))
            || manager().current_generation() != generation
        {
            return;
        }
        if let Some(call_id) = frame
            .get_str(DataType::CallId)
            .filter(|id| !id.is_empty() && id.len() <= 128)
        {
            let id = u64::from_be_bytes(
                mtp::crypto::sha256(call_id.as_bytes())[..8]
                    .try_into()
                    .expect("SHA-256 prefix"),
            );
            let mut pending = manager()
                .pending_calls
                .write()
                .expect("Call invitations unavailable");
            if frame.is_type(CommunicationType::CallEnded) {
                pending.dismiss(call_id);
                let _ = android_cancel_notification(id);
            } else if let Ok(config) = current_config() {
                if frame
                    .get_data(DataType::ReceiverId)
                    .and_then(DataValue::as_number)
                    == Some(config.user_id.into())
                    && pending.remember(call_id, frame.clone())
                    && !manager().ui_visible.load(Ordering::SeqCst)
                {
                    let _ = notify_generic(
                        generation,
                        id,
                        "Incoming call",
                        "Open Tensamin to answer",
                        None,
                        None,
                    );
                }
            }
        }
        return;
    }
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
            // Preview I/O must not block incoming calls. Busy deliveries remain unacknowledged for the server's durable retry.
            let Ok(permit) = RELAY_WORK
                .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
                .clone()
                .try_acquire_owned()
            else {
                return;
            };
            let order = crate::mtp_relay::NOTIFICATION_ORDER.fetch_add(1, Ordering::SeqCst) + 1;
            manager().runtime.spawn(async move {
                let _permit = permit;
                if let Err(error) =
                    crate::mtp_relay::handle_plugin_relay(session, frame, user_id, keyring, order)
                        .await
                {
                    manager().log(
                        1,
                        "Authenticated relay handling failed",
                        Some(Value::String(error)),
                    );
                }
            });
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
}
