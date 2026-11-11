use super::*;

pub(super) fn decode_key_material(value: EncodedKeyMaterial) -> Result<PublicKeyBundle, String> {
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

pub(super) async fn prepare_sealed_relay(
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

pub(super) async fn relay_session(
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

pub(super) fn prepared_relay_frame(
    bytes: &[u8],
    map: &TypeMap,
) -> Result<CommunicationValue, String> {
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
    let (connection, frame) = {
        let _credentials = CREDENTIALS_LOCK.lock().await;
        let connection = relay_session(generation, &dictionary_fingerprint).await?;
        let frame = prepared_relay_frame(&frame, connection.connection().codec.type_map())?;
        (connection, frame)
    };
    // Session::request replaces only the outer correlation ID, preserving the UI's saved signed relay ID and encrypted body.
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
