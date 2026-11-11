use super::*;

pub(crate) fn message_notification_id(account: &str, principal: &str) -> u64 {
    u64::from_be_bytes(
        mtp::crypto::sha256(format!("{account}:{principal}").as_bytes())[..8]
            .try_into()
            .expect("SHA-256 prefix"),
    )
}

pub(super) fn cancel_read_notification(
    generation: u64,
    principal: &str,
    stamp: crate::mtp_relay::NotificationStamp,
) -> Result<(), String> {
    let snapshot = manager().snapshot();
    if snapshot.generation != generation || manager().current_generation() != generation {
        return Ok(());
    }
    let peer: tau_relay_protocol::Principal =
        serde_json::from_str(principal).map_err(|_| "Invalid read notification principal")?;
    peer.validate()
        .map_err(|_| "Invalid read notification principal")?;
    if serde_json::to_string(&peer).map_err(|error| error.to_string())? != principal {
        return Err("Noncanonical read notification principal".into());
    }
    let scope = snapshot.scope.ok_or("Native account unavailable")?;
    let account = serde_json::to_string(&(&scope.principal, scope.authorization_generation))
        .map_err(|error| error.to_string())?;
    let conversation = format!("{account}:{principal}");
    let mut latest = NOTIFICATION_TIMES
        .get_or_init(|| std::sync::Mutex::new(std::collections::VecDeque::new()))
        .lock()
        .map_err(|_| "Notification order unavailable")?;
    if manager().current_generation() != generation {
        return Ok(());
    }
    if !latest
        .iter()
        .any(|(key, newer)| key == &conversation && *newer > stamp)
    {
        android_cancel_notification(message_notification_id(&account, principal))?;
        latest.retain(|(key, _)| key != &conversation);
        if latest.len() == 1024 {
            latest.pop_front();
        }
        latest.push_back((conversation, stamp));
    }
    crate::mtp_relay::dismiss_pending_conversation(&account, principal, stamp)
}

pub(crate) fn notify_generic(
    generation: u64,
    id: u64,
    title: &str,
    body: &str,
    principal: Option<&str>,
    receipt: Option<crate::mtp_relay::NotificationReceipt<'_>>,
) -> Result<bool, String> {
    if manager().current_generation() != generation {
        return Ok(false);
    }
    if principal.is_some()
        && manager().renderer_notifications_active()
        && manager()
            .viewed_conversation
            .read()
            .map_err(|_| "Notification view unavailable")?
            .as_deref()
            == principal
    {
        return Ok(false);
    }
    let snapshot = manager().snapshot();
    let account = snapshot
        .scope
        .as_ref()
        .map(|scope| serde_json::to_string(&(&scope.principal, scope.authorization_generation)))
        .transpose()
        .map_err(|error| error.to_string())?;
    let conversation = if let Some(principal) = principal {
        Some(format!(
            "{}:{principal}",
            account.as_deref().ok_or("Native account unavailable")?
        ))
    } else {
        None
    };
    let mut latest = NOTIFICATION_TIMES
        .get_or_init(|| std::sync::Mutex::new(std::collections::VecDeque::new()))
        .lock()
        .map_err(|_| "Notification order unavailable")?;
    if let (Some(conversation), Some(receipt)) = (conversation.as_ref(), receipt) {
        if latest
            .iter()
            .any(|(key, newest)| key == conversation && *newest > receipt.stamp)
        {
            return Ok(false);
        }
    }
    if let (Some(account), Some(principal), Some(receipt)) =
        (account.as_deref(), principal, receipt)
    {
        if crate::mtp_relay::newer_pending(account, principal, receipt.stamp)? {
            return Ok(false);
        }
    }
    if manager().current_generation() != generation {
        return Ok(false);
    }
    if let (Some(principal), Some(receipt)) = (principal, receipt) {
        let scope = snapshot
            .scope
            .as_ref()
            .ok_or("Native account unavailable")?;
        let signer: tau_relay_protocol::Principal =
            serde_json::from_str(principal).map_err(|_| "Invalid notification principal")?;
        let key = serde_json::to_string(&(&scope.principal, signer, receipt.relay_id))
            .map_err(|error| error.to_string())?;
        if !crate::mtp_relay::claim(&key)? {
            return Ok(false);
        }
    }
    android_notify(id, title, body, None, principal)?;
    if let (Some(conversation), Some(receipt)) = (conversation, receipt) {
        latest.retain(|(key, _)| key != &conversation);
        if latest.len() == 1024 {
            latest.pop_front();
        }
        latest.push_back((conversation, receipt.stamp));
    }
    if let (Some(account), Some(principal), Some(receipt)) =
        (account.as_deref(), principal, receipt)
    {
        crate::mtp_relay::dismiss_pending_conversation(account, principal, receipt.stamp)?;
    }
    Ok(true)
}

pub(crate) async fn notify_message_preview(
    user_id: u64,
    keyring: &Keyring,
    connection: Arc<tauri_plugin_mtp::Session>,
    message: &DataValue,
    verified_name: &str,
    receipt: crate::mtp_relay::NotificationReceipt<'_>,
    generation: u64,
) -> Result<(), String> {
    if manager().current_generation() != generation {
        return Ok(());
    }
    let content = container_value_by_name(message, "Content")
        .and_then(DataValue::as_str)
        .ok_or("MessageLive omitted Content")?;
    let message_version = container_value_by_name(message, "VersionNumber")
        .and_then(DataValue::as_number)
        .map(u128::try_from)
        .transpose()
        .map_err(|_| "MessageLive VersionNumber must be nonnegative")?
        .unwrap_or(1);
    let scope = manager()
        .snapshot()
        .scope
        .ok_or("Account identity is unavailable")?;
    let notification_account =
        serde_json::to_string(&(&scope.principal, scope.authorization_generation))
            .map_err(|error| error.to_string())?;
    if scope.principal.user_id != user_id {
        return Err("Account identity changed".into());
    }
    let sender_json = container_value_by_name(message, "Principal")
        .and_then(DataValue::as_str)
        .ok_or("Message omitted canonical sender")?;
    let sender: tau_relay_protocol::Principal =
        serde_json::from_str(sender_json).map_err(|error| error.to_string())?;
    if serde_json::to_string(&sender).map_err(|error| error.to_string())? != sender_json {
        return Err("Noncanonical message sender".into());
    }
    let owner_json = serde_json::to_string(&scope.principal).map_err(|error| error.to_string())?;
    let chat_id = tau_relay_protocol::ConversationPair::new(scope.principal, sender.clone())
        .and_then(|pair| pair.chat_id())
        .map_err(|error| error.to_string())?;
    let secret_id = tau_relay_protocol::chat_secret_id(&chat_id);
    let map = connection.connection().codec.type_map();
    let secret_request =
        CommunicationValue::new_with_type_map(CommunicationType::GetChatSecret, map)
            .add_typed_default(DataType::UserId, DataValue::Str(owner_json.clone()))
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
    if secret.type_map() != Some(map)
        || secret.get_str(DataType::UserId) != Some(owner_json.as_str())
        || secret.get_str(DataType::ChatId) != Some(chat_id.as_str())
        || secret.get_str(DataType::SecretId) != Some(secret_id.as_str())
        || secret.get_str(DataType::WrappingScheme) != Some(CHAT_SECRET_SCHEME)
        || secret
            .get_data(DataType::VersionNumber)
            .and_then(DataValue::as_number)
            != i128::try_from(message_version).ok()
    {
        return Err("Chat secret response does not match the requested scope".into());
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

    let relay_id = container_value_by_name(message, "RelayMessageId")
        .and_then(DataValue::as_str)
        .ok_or("Notification omitted relay identity")?;
    let current_request = CommunicationValue::new_with_type_map(CommunicationType::MessageGet, map)
        .add_typed_default(DataType::Principal, DataValue::Str(sender_json.to_owned()))
        .add_typed_default(
            DataType::RelayMessageId,
            DataValue::Str(relay_id.to_owned()),
        );
    let current = connection
        .request(
            current_request,
            Some(CommunicationType::MessageGet),
            INITIAL_SYNC_TIMEOUT,
        )
        .await
        .map_err(|error| error.to_string())?;
    if current.get_str(DataType::Status) == Some("pruned") {
        return Err("Notification preview was pruned after durable synchronization".into());
    }
    if !crate::mtp_relay::current_message_matches(&current, sender_json, relay_id, message) {
        return Ok(());
    }
    notify_generic(
        generation,
        message_notification_id(&notification_account, sender_json),
        verified_name,
        &String::from_utf8_lossy(&plaintext),
        Some(sender_json),
        Some(receipt),
    )?;
    Ok(())
}
#[tauri::command]
pub fn mtp_set_notification_owner(
    account: String,
    token: String,
    ready: bool,
) -> Result<bool, String> {
    uuid::Uuid::parse_str(&token).map_err(|_| "Invalid notification lifetime")?;
    let mut owner = manager()
        .notification_owner
        .write()
        .map_err(|_| "Notification owner unavailable")?;
    if ready {
        let snapshot = manager().snapshot();
        let Some(scope) = snapshot.scope else {
            return Ok(false);
        };
        if !snapshot.identified
            || account
                != serde_json::to_string(&(&scope.principal, scope.authorization_generation))
                    .map_err(|error| error.to_string())?
        {
            return Ok(false);
        }
        *owner = Some((account, token));
    } else if owner
        .as_ref()
        .is_some_and(|(current, lifetime)| current == &account && lifetime == &token)
    {
        *owner = None;
    }
    drop(owner);
    if !ready {
        crate::mtp_relay::wake_notifications();
    }
    Ok(true)
}

#[tauri::command]
pub fn mtp_set_viewed_conversation(principal: Option<String>) -> Result<(), String> {
    if let Some(value) = principal.as_ref() {
        let parsed: tau_relay_protocol::Principal =
            serde_json::from_str(value).map_err(|_| "Invalid viewed conversation")?;
        parsed
            .validate()
            .map_err(|_| "Invalid viewed conversation")?;
        if serde_json::to_string(&parsed).map_err(|_| "Invalid viewed conversation")? != *value {
            return Err("Noncanonical viewed conversation".into());
        }
    }
    *manager()
        .viewed_conversation
        .write()
        .map_err(|_| "Notification view unavailable")? = principal;
    Ok(())
}
