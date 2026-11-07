use std::sync::Arc;

use mtp::{
    codec::{
        open_relay_content_with_limits_without_replay,
        open_relay_metadata_with_limits_without_replay, CommunicationType, CommunicationValue,
        DataType, DataValue, ProtectionPolicy, RelayOpenOptions, SignaturePolicy,
    },
    crypto::{Keyring, PublicKeyBundle},
};
use serde_json::Value;
use tauri_plugin_mtp::Session;

fn number(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}

fn resolved_signer_keys(
    response: &CommunicationValue,
    principal: &tau_relay_protocol::Principal,
    journal: &mut crate::mtp_sync_cache::AccountSyncJournal,
    now: i64,
) -> Result<Vec<PublicKeyBundle>, String> {
    let canonical = serde_json::to_string(principal).map_err(|error| error.to_string())?;
    if !response.is_type(CommunicationType::UserResolved)
        || response.get_str(DataType::Principal) != Some(canonical.as_str())
        || response.get_str(DataType::AuthorityId) != Some(principal.authority.as_str())
        || response
            .get_data(DataType::UserId)
            .and_then(DataValue::as_number)
            != Some(principal.user_id.into())
    {
        return Err("resolved relay signer does not match its authenticated scope".into());
    }
    let home = response
        .get_str(DataType::PublicKey)
        .ok_or("resolved relay signer omitted its home key")?;
    let home_key =
        PublicKeyBundle::from_base64(home).map_err(|_| "invalid resolved signer home key")?;
    let node = iota_identity::IotaNodeId::from_public_keys(&home_key)
        .map_err(|_| "invalid resolved signer home key")?;
    if response.get_str(DataType::NodeId) != Some(node.as_str()) {
        return Err("resolved relay signer returned a contradictory home".into());
    }
    journal.verify_principal(
        principal,
        response
            .get_str(DataType::Json)
            .ok_or("resolved relay signer omitted authority proof")?,
        home,
        now,
    )
}

fn committed_message<'a>(
    state: &'a Value,
    message_id: &str,
    signer: &tau_relay_protocol::Principal,
) -> Result<&'a Value, String> {
    state
        .get("records")
        .and_then(Value::as_array)
        .and_then(|records| {
            records.iter().find(|record| {
                record.get("entity").and_then(Value::as_str) == Some("message")
                    && record.get("value").is_some_and(|value| {
                        value.get("relay_message_id").and_then(Value::as_str) == Some(message_id)
                            && value.get("relay_signer_principal_identity")
                                == Some(&serde_json::to_value(signer).unwrap_or(Value::Null))
                    })
            })
        })
        .map(|record| record.get("value").expect("matched message value"))
        .ok_or_else(|| "synchronized account omitted the relay's committed message".into())
}

fn authenticate_relay(
    frame: &CommunicationValue,
    user_id: u64,
    keyring: &Keyring,
    route: &tau_relay_protocol::NativeRelayRoute,
    keys: &[PublicKeyBundle],
) -> Result<
    (
        tau_relay_protocol::Principal,
        String,
        mtp::codec::VerifiedRelayContent,
    ),
    String,
> {
    let map = frame.type_map().ok_or("relay omitted dictionary")?;
    let policy = ProtectionPolicy {
        signature: SignaturePolicy::Dual,
    };
    let options = RelayOpenOptions::new(policy);
    let metadata = open_relay_metadata_with_limits_without_replay(
        frame,
        &[keyring],
        Some(route.signer.user_id),
        |_| Some(keys.to_vec()),
        options,
    )
    .map_err(|error| error.to_string())?;
    let content = open_relay_content_with_limits_without_replay(
        &metadata,
        &[keyring],
        keys,
        Some(user_id),
        options,
    )
    .map_err(|error| error.to_string())?;
    if !matches!(
        content.message_type,
        CommunicationType::SetChatSecret
            | CommunicationType::MessageSend
            | CommunicationType::MessageEdit
            | CommunicationType::MessageDelete
            | CommunicationType::MessageReactionAdd
            | CommunicationType::MessageReactionRemove
            | CommunicationType::MessageState
            | CommunicationType::AddConversation
            | CommunicationType::FileShareOffered
            | CommunicationType::FileShareRevoked
    ) {
        return Err("unsupported authenticated relay operation".into());
    }
    let application = tau_relay_protocol::NativeRelayRoute::from_metadata(
        metadata
            .metadata()
            .ok_or("authenticated relay omitted canonical metadata")?,
        map,
    )
    .map_err(|error| error.to_string())?;
    if application != *route || application.recipient.user_id != user_id {
        return Err("authenticated relay metadata is outside this account".into());
    }
    let message_id = metadata.message_id().get().to_string();
    Ok((application.signer, message_id, content))
}

pub async fn handle_plugin_relay(
    session: Arc<Session>,
    frame: CommunicationValue,
    user_id: u64,
    keyring: Arc<Keyring>,
) -> Result<(), String> {
    let generation = crate::mtp_backend::manager().snapshot().generation;
    let config = crate::mtp_backend::current_config()?;
    if config.user_id != user_id {
        return Err("Native relay credentials changed".into());
    }
    let active = crate::mtp_plugin::manager()
        .registry
        .attach(crate::mtp_plugin::CONNECTION_NAME)
        .await;
    if !active
        .as_ref()
        .is_some_and(|active| Arc::ptr_eq(active, &session))
        || crate::mtp_backend::manager().snapshot().generation != generation
        || crate::mtp_backend::current_config()? != config
    {
        return Err("Native session changed before relay resolution".into());
    }
    let route = tau_relay_protocol::unverified_native_route(&frame, &keyring)
        .map_err(|error| error.to_string())?;
    let map = session.connection().codec.type_map();
    if frame.type_map() != Some(map) {
        return Err("relay dictionary differs from this session".into());
    }
    let signer = &route.signer;
    let principal = serde_json::to_string(signer).map_err(|error| error.to_string())?;
    let resolve = CommunicationValue::new_with_type_map(CommunicationType::UserResolve, map)
        .add_typed_default(DataType::UserAddress, DataValue::Str(principal))
        .add_typed_default(
            DataType::Json,
            DataValue::Str("{\"principal_proof\":1}".into()),
        );
    let resolved = session
        .request(
            resolve,
            Some(CommunicationType::UserResolved),
            crate::mtp_backend::INITIAL_SYNC_TIMEOUT,
        )
        .await
        .map_err(|error| error.to_string())?;
    if crate::mtp_backend::manager().snapshot().generation != generation
        || crate::mtp_backend::current_config()? != config
    {
        return Err("Native relay credentials changed during resolution".into());
    }
    let directory = crate::mtp_backend::sync_directory()?;
    let device = std::fs::read_to_string(directory.join(crate::mtp_sync_cache::DEVICE_ID_FILE))
        .map_err(|error| error.to_string())?;
    uuid::Uuid::parse_str(&device).map_err(|_| "Native sync device identity is not initialized")?;
    let mut journal = crate::mtp_sync_cache::AccountSyncJournal::new(directory, &config, device)?;
    let now = i64::try_from(mtp::common::unix_time_millis().map_err(|error| error.to_string())?)
        .map_err(|_| "Native identity timestamp exceeds its range")?;
    let keys = resolved_signer_keys(&resolved, signer, &mut journal, now)?;
    let (signer, message_id, content) =
        authenticate_relay(&frame, user_id, &keyring, &route, &keys)?;
    let applied = crate::mtp_plugin::synchronize(&session).await?;
    let scope: tau_relay_protocol::sync::Scope = serde_json::from_value(
        applied
            .get("scope")
            .cloned()
            .ok_or("account snapshot omitted scope")?,
    )
    .map_err(|error| error.to_string())?;
    if scope.principal != route.recipient || scope.dictionary != route.type_map_fingerprint {
        return Err("account scope changed during relay application".into());
    }
    if matches!(
        content.message_type,
        CommunicationType::FileShareOffered | CommunicationType::FileShareRevoked
    ) {
        crate::mtp_files::synchronize(&session, &scope, &mut journal).await?;
        crate::mtp_files::require_committed_grant(
            &session,
            &scope,
            &mut journal,
            &signer,
            content.message_type,
            &content.content,
        )
        .await?;
    }
    let current = crate::mtp_plugin::manager()
        .registry
        .attach(crate::mtp_plugin::CONNECTION_NAME)
        .await
        .ok_or("Native relay session is no longer connected")?;
    if !Arc::ptr_eq(&current, &session)
        || crate::mtp_backend::manager().snapshot().generation != generation
        || crate::mtp_backend::current_config()? != config
    {
        return Err("Native session changed during relay application".into());
    }
    crate::mtp_backend::manager().publish_relay_state(generation, applied.clone())?;
    let response = CommunicationValue::new_with_type_map(CommunicationType::Success, map)
        .with_id(frame.id().ok_or("incoming relay omitted request ID")?)
        .add_typed_default(DataType::RelayMessageId, DataValue::Str(message_id.clone()))
        .add_typed_default(
            DataType::Principal,
            DataValue::Str(serde_json::to_string(&signer).map_err(|error| error.to_string())?),
        );
    session
        .send(&response)
        .await
        .map_err(|error| error.to_string())?;

    if content.message_type == CommunicationType::MessageSend
        && !crate::mtp_backend::manager()
            .ui_visible
            .load(std::sync::atomic::Ordering::SeqCst)
    {
        // The original delivery can arrive after an edit or deletion. Acknowledge
        // delivery above, but never display stale ciphertext from the relay.
        let Ok(stored) = committed_message(&applied, &message_id, &signer) else {
            return Ok(());
        };
        if stored.get("history_deleted").and_then(Value::as_str) == Some("1")
            || stored.get("deleted_by_external").and_then(Value::as_str) == Some("1")
            || stored.get("content").and_then(Value::as_str)
                != crate::mtp_backend::container_value_by_name(&content.content, "Content")
                    .and_then(DataValue::as_str)
        {
            return Ok(());
        }
        let mut fields = content
            .content
            .container_entries()
            .ok_or("message content is not a container")?
            .to_vec();
        fields.push((
            DataType::Principal
                .try_to_id(map)
                .ok_or("principal dictionary entry unavailable")?,
            DataValue::Str(serde_json::to_string(&signer).map_err(|error| error.to_string())?),
        ));
        fields.push((
            DataType::RelayMessageId
                .try_to_id(map)
                .ok_or("relay ID dictionary entry unavailable")?,
            DataValue::Str(message_id),
        ));
        let message = DataValue::Container(fields);
        let notification =
            CommunicationValue::new_with_type_map(CommunicationType::MessageLive, map)
                .add_typed_default(
                    DataType::SenderId,
                    DataValue::UnsignedNumber(
                        stored
                            .get("external_principal")
                            .and_then(number)
                            .ok_or("message omitted contact handle")?
                            .into(),
                    ),
                )
                .add_typed_default(DataType::Message, message);
        crate::mtp_backend::notify_plugin_message(user_id, &keyring, session, &notification)
            .await?;
    }
    Ok(())
}
