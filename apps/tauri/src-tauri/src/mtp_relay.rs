use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, OnceLock},
};

use mtp::{
    codec::{
        open_relay_content_with_limits_without_replay,
        open_relay_metadata_with_limits_without_replay, CommunicationType, CommunicationValue,
        DataType, DataValue, ProtectionPolicy, RelayOpenOptions, SignaturePolicy,
    },
    crypto::{Keyring, PublicKeyBundle},
};
use tauri_plugin_mtp::Session;

static NOTIFIED_RELAYS: OnceLock<Mutex<VecDeque<NotificationId>>> = OnceLock::new();
pub(crate) static NOTIFICATION_ORDER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
static PRINCIPAL_REVISIONS: OnceLock<Mutex<VecDeque<(String, i64)>>> = OnceLock::new();
static PENDING_NOTIFICATIONS: OnceLock<Mutex<VecDeque<PendingNotification>>> = OnceLock::new();
static DRAINING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static NOTIFICATION_WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

struct NotificationId {
    key: String,
    order: u64,
    handled: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct NotificationStamp {
    pub time: i64,
    pub order: u64,
}

#[derive(Clone, Copy)]
pub(crate) struct NotificationReceipt<'a> {
    pub relay_id: &'a str,
    pub stamp: NotificationStamp,
}

#[derive(Clone)]
struct PendingNotification {
    account: String,
    signer: tau_relay_protocol::Principal,
    relay_id: String,
    kind: CommunicationType,
    digest: Option<[u8; 32]>,
    version: Option<i128>,
    stamp: NotificationStamp,
    title: String,
    first: tokio::time::Instant,
    due: tokio::time::Instant,
}

fn resolved_signer(
    response: &CommunicationValue,
    principal: &tau_relay_protocol::Principal,
    now: i64,
) -> Result<(Vec<PublicKeyBundle>, Option<String>), String> {
    let canonical = serde_json::to_string(principal).map_err(|error| error.to_string())?;
    let config = crate::mtp_backend::current_config()?;
    let binding = serde_json::to_string(&(
        config.user_id,
        &config.omega_url,
        mtp::crypto::sha256(config.keyring.as_bytes()),
        &canonical,
    ))
    .map_err(|error| error.to_string())?;
    let revisions = PRINCIPAL_REVISIONS.get_or_init(|| Mutex::new(VecDeque::new()));
    let minimum = revisions
        .lock()
        .map_err(|_| "Principal verification unavailable")?
        .iter()
        .find(|(key, _)| key == &binding)
        .map(|(_, revision)| *revision);
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
    let (revision, keys, display) = crate::mtp_principal_proof::verify(
        response
            .get_str(DataType::Json)
            .ok_or("resolved relay signer omitted authority proof")?,
        principal,
        home,
        minimum,
        now,
    )?;
    let mut revisions = revisions
        .lock()
        .map_err(|_| "Principal verification unavailable")?;
    if revisions
        .iter()
        .any(|(key, latest)| key == &binding && *latest > revision)
    {
        return Err("Principal revision moved backwards".into());
    }
    revisions.retain(|(key, _)| key != &binding);
    if revisions.len() == 1024 {
        revisions.pop_front();
    }
    revisions.push_back((binding, revision));
    Ok((keys, display))
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
    let message_id = format!("mtp-sealed-v1:{}", metadata.message_id().get());
    Ok((application.signer, message_id, content))
}

pub(crate) fn current_message_matches(
    current: &CommunicationValue,
    signer: &str,
    relay_id: &str,
    original: &DataValue,
) -> bool {
    let content = crate::mtp_backend::container_value_by_name(original, "Content")
        .and_then(DataValue::as_str);
    let version = crate::mtp_backend::container_value_by_name(original, "VersionNumber")
        .and_then(DataValue::as_number);
    current.is_type(CommunicationType::MessageGet)
        && current.get_str(DataType::Principal) == Some(signer)
        && current.get_str(DataType::RelayMessageId) == Some(relay_id)
        && content.is_some()
        && current.get_str(DataType::Content) == content
        && version.is_some_and(|version| version > 0)
        && current
            .get_data(DataType::VersionNumber)
            .and_then(DataValue::as_number)
            == version
}

pub async fn handle_plugin_relay(
    session: Arc<Session>,
    frame: CommunicationValue,
    user_id: u64,
    keyring: Arc<Keyring>,
    order: u64,
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
    let now = i64::try_from(mtp::common::unix_time_millis().map_err(|error| error.to_string())?)
        .map_err(|_| "Native identity timestamp exceeds its range")?;
    let (keys, display) = resolved_signer(&resolved, signer, now)?;
    let (signer, message_id, content) =
        authenticate_relay(&frame, user_id, &keyring, &route, &keys)?;
    let scope = if let Some(scope) = crate::mtp_backend::manager().snapshot().scope {
        scope
    } else {
        let scope = crate::mtp_plugin::account_scope(&session).await?;
        crate::mtp_backend::manager().set_authenticated_scope(generation, scope.clone())?;
        scope
    };
    if scope.principal != route.recipient || scope.dictionary != route.type_map_fingerprint {
        return Err("account scope changed during relay application".into());
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
    let response = CommunicationValue::new_with_type_map(CommunicationType::Success, map)
        .with_id(frame.id().ok_or("incoming relay omitted request ID")?)
        .add_typed_default(DataType::RelayMessageId, DataValue::Str(message_id.clone()))
        .add_typed_default(DataType::Status, DataValue::Str("notification".into()))
        .add_typed_default(
            DataType::Principal,
            DataValue::Str(serde_json::to_string(&signer).map_err(|error| error.to_string())?),
        );
    session
        .send(&response)
        .await
        .map_err(|error| error.to_string())?;

    let account = serde_json::to_string(&(&scope.principal, scope.authorization_generation))
        .map_err(|error| error.to_string())?;
    let principal = serde_json::to_string(&signer).map_err(|error| error.to_string())?;
    let time = crate::mtp_backend::container_value_by_name(&content.content, "SendTime")
        .and_then(DataValue::as_number)
        .and_then(|value| i64::try_from(value).ok())
        .unwrap_or(now);
    let notification_key = serde_json::to_string(&(&scope.principal, &signer, &message_id))
        .map_err(|error| error.to_string())?;
    let Some(order) = accept_event(&notification_key, order)? else {
        return Ok(());
    };
    crate::mtp_backend::manager().relay_hint(
        &account,
        &principal,
        &message_id,
        &format!("{:?}", content.message_type),
        time,
        order,
    );
    if matches!(
        content.message_type,
        CommunicationType::MessageSend | CommunicationType::FileShareOffered
    ) {
        if crate::mtp_backend::manager().renderer_notifications_active()
            && crate::mtp_backend::manager()
                .viewed_conversation
                .read()
                .map_err(|_| "Notification view unavailable")?
                .as_deref()
                == Some(principal.as_str())
        {
            let _ = claim(&notification_key)?;
        } else {
            let now = tokio::time::Instant::now();
            let hint = PendingNotification {
                account,
                signer,
                relay_id: message_id,
                kind: content.message_type,
                digest: crate::mtp_backend::container_value_by_name(&content.content, "Content")
                    .and_then(DataValue::as_str)
                    .map(|text| mtp::crypto::sha256(text.as_bytes())),
                version: crate::mtp_backend::container_value_by_name(
                    &content.content,
                    "VersionNumber",
                )
                .and_then(DataValue::as_number),
                stamp: NotificationStamp { time, order },
                title: display.unwrap_or_else(|| "New message".into()),
                first: now,
                due: now + std::time::Duration::from_millis(200),
            };
            let mut pending = PENDING_NOTIFICATIONS
                .get_or_init(|| Mutex::new(VecDeque::new()))
                .lock()
                .map_err(|_| "Pending notifications unavailable")?;
            coalesce_pending(&mut pending, &scope.principal, hint)?;
        }
        wake_notifications();
    }
    Ok(())
}

fn coalesce_pending(
    pending: &mut VecDeque<PendingNotification>,
    owner: &tau_relay_protocol::Principal,
    mut hint: PendingNotification,
) -> Result<(), String> {
    if !pending.iter().any(|old| {
        old.account == hint.account && old.signer == hint.signer && old.stamp >= hint.stamp
    }) {
        for old in pending
            .iter()
            .filter(|old| old.account == hint.account && old.signer == hint.signer)
        {
            hint.first = old.first;
            hint.due = hint.due.min(old.first + std::time::Duration::from_secs(1));
            claim(
                &serde_json::to_string(&(owner, &old.signer, &old.relay_id))
                    .map_err(|error| error.to_string())?,
            )?;
        }
        pending.retain(|old| old.account != hint.account || old.signer != hint.signer);
        if pending.len() == 1024 {
            pending.pop_front();
        }
        pending.push_back(hint);
    }
    Ok(())
}

pub(crate) fn claim(key: &str) -> Result<bool, String> {
    let mut notified = NOTIFIED_RELAYS
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .map_err(|_| "Notification history unavailable")?;
    if let Some(previous) = notified.iter_mut().find(|previous| previous.key == key) {
        let fresh = !previous.handled;
        previous.handled = true;
        return Ok(fresh);
    }
    if notified.len() == 1024 {
        notified.pop_front();
    }
    notified.push_back(NotificationId {
        key: key.to_owned(),
        order: 0,
        handled: true,
    });
    Ok(true)
}

fn accept_event(key: &str, order: u64) -> Result<Option<u64>, String> {
    let mut notified = NOTIFIED_RELAYS
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .map_err(|_| "Notification history unavailable")?;
    if let Some(previous) = notified.iter().find(|previous| previous.key == key) {
        return Ok((!previous.handled).then_some(previous.order));
    }
    if notified.len() == 1024 {
        notified.pop_front();
    }
    notified.push_back(NotificationId {
        key: key.to_owned(),
        order,
        handled: false,
    });
    Ok(Some(order))
}

pub(crate) fn clear_pending_notifications() {
    if let Some(pending) = PENDING_NOTIFICATIONS.get() {
        if let Ok(mut pending) = pending.lock() {
            pending.clear();
        }
    }
}

pub(crate) fn newer_pending(
    account: &str,
    principal: &str,
    stamp: NotificationStamp,
) -> Result<bool, String> {
    let pending = PENDING_NOTIFICATIONS
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .map_err(|_| "Pending notifications unavailable")?;
    Ok(pending.iter().any(|hint| {
        hint.account == account
            && serde_json::to_string(&hint.signer).ok().as_deref() == Some(principal)
            && hint.stamp > stamp
    }))
}

pub(crate) fn dismiss_pending_conversation(
    account: &str,
    principal: &str,
    through: NotificationStamp,
) -> Result<(), String> {
    let (owner, _): (tau_relay_protocol::Principal, i64) =
        serde_json::from_str(account).map_err(|_| "Invalid notification account")?;
    let mut pending = PENDING_NOTIFICATIONS
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .map_err(|_| "Pending notifications unavailable")?;
    for index in (0..pending.len()).rev() {
        if pending[index].account == account
            && serde_json::to_string(&pending[index].signer).map_err(|error| error.to_string())?
                == principal
            && pending[index].stamp <= through
        {
            let hint = pending
                .remove(index)
                .expect("existing pending notification");
            claim(
                &serde_json::to_string(&(&owner, hint.signer, hint.relay_id))
                    .map_err(|error| error.to_string())?,
            )?;
        }
    }
    Ok(())
}

fn notification_generation() -> Option<u64> {
    let manager = crate::mtp_backend::manager();
    let snapshot = manager.snapshot();
    (snapshot.identified && snapshot.scope.is_some() && !manager.renderer_notifications_active())
        .then_some(snapshot.generation)
}

pub(crate) fn wake_notifications() {
    use std::sync::atomic::Ordering;
    NOTIFICATION_WAKE.notify_one();
    let manager = crate::mtp_backend::manager();
    if notification_generation().is_none() || DRAINING.swap(true, Ordering::SeqCst) {
        return;
    }
    manager.runtime.spawn(async {
        let mut work = tokio::task::JoinSet::new();
        let mut running = Vec::new();
        let mut interrupted = None;
        loop {
            if notification_generation().is_some_and(|generation| interrupted.is_some_and(|old| old != generation)) { interrupted = None; }
            while interrupted.is_none()
                && work.len() < 4
                && notification_generation().is_some()
            {
                let hint = PENDING_NOTIFICATIONS.get_or_init(|| Mutex::new(VecDeque::new())).lock().ok().and_then(|mut pending| {
                    let index = pending.iter().position(|hint| hint.due <= tokio::time::Instant::now() && !running.contains(&(hint.account.clone(), hint.signer.clone())))?;
                    pending.remove(index)
                });
                let Some(hint) = hint else {
                    break;
                };
                let conversation = (hint.account.clone(), hint.signer.clone());
                let generation = crate::mtp_backend::manager().current_generation();
                running.push(conversation.clone());
                work.spawn(async move {
                    let stopped = match notify_pending(&hint).await {
                        Ok(false) if crate::mtp_backend::manager().is_enabled() => {
                            if let Ok(mut pending) = PENDING_NOTIFICATIONS
                                .get_or_init(|| Mutex::new(VecDeque::new()))
                                .lock()
                            {
                                if pending.len() < 1024
                                    && !pending.iter().any(|newer| {
                                        newer.account == hint.account
                                            && newer.signer == hint.signer
                                            && newer.stamp >= hint.stamp
                                    })
                                {
                                    pending.push_back(hint);
                                }
                            }
                            true
                        }
                        Err(error) => {
                            eprintln!("Background notification failed: {error}");
                            false
                        }
                        _ => false,
                    };
                    (conversation, stopped.then_some(generation))
                });
            }
            let next = if interrupted.is_none() && work.len() < 4 && notification_generation().is_some() {
                PENDING_NOTIFICATIONS.get().and_then(|pending| pending.lock().ok()).and_then(|pending| pending.iter().filter(|hint| !running.contains(&(hint.account.clone(), hint.signer.clone()))).map(|hint| hint.due).min())
            } else { None };
            if work.is_empty() && next.is_none() { break; }
            let result = if let Some(next) = next {
                tokio::select! { result = work.join_next(), if !work.is_empty() => result, _ = tokio::time::sleep_until(next) => continue, _ = NOTIFICATION_WAKE.notified() => continue }
            } else { tokio::select! { result = work.join_next() => result, _ = NOTIFICATION_WAKE.notified() => continue } };
            match result {
                Some(Ok((conversation, stopped))) => { running.retain(|active| active != &conversation); if stopped.is_some() { interrupted = stopped; } }
                Some(Err(error)) => eprintln!("Background notification worker failed: {error}"),
                None => {}
            }
        }
        DRAINING.store(false, Ordering::SeqCst);
        if notification_generation().is_some_and(|generation| interrupted != Some(generation))
            && PENDING_NOTIFICATIONS
                .get()
                .is_some_and(|pending| pending.lock().is_ok_and(|pending| !pending.is_empty()))
        {
            wake_notifications();
        }
    });
}

async fn notify_pending(hint: &PendingNotification) -> Result<bool, String> {
    let snapshot = crate::mtp_backend::manager().snapshot();
    let Some(scope) = snapshot.scope else {
        return Ok(false);
    };
    let account = serde_json::to_string(&(&scope.principal, scope.authorization_generation))
        .map_err(|error| error.to_string())?;
    if account != hint.account {
        return Ok(true);
    }
    let generation = snapshot.generation;
    let principal = serde_json::to_string(&hint.signer).map_err(|error| error.to_string())?;
    let id = crate::mtp_backend::message_notification_id(&account, &principal);
    let session = crate::mtp_plugin::manager()
        .registry
        .attach(crate::mtp_plugin::CONNECTION_NAME)
        .await;
    let Some(session) = session else {
        return Ok(false);
    };
    let mut stored = None;
    let mut generic = if hint.kind == CommunicationType::FileShareOffered {
        "Shared a file"
    } else {
        "New encrypted message"
    };
    if hint.kind == CommunicationType::MessageSend {
        let map = session.connection().codec.type_map();
        let request = CommunicationValue::new_with_type_map(CommunicationType::MessageGet, map)
            .add_typed_default(DataType::Principal, DataValue::Str(principal.clone()))
            .add_typed_default(
                DataType::RelayMessageId,
                DataValue::Str(hint.relay_id.clone()),
            );
        match session
            .request(
                request,
                Some(CommunicationType::MessageGet),
                crate::mtp_backend::INITIAL_SYNC_TIMEOUT,
            )
            .await
        {
            Ok(current) if current.is_type(CommunicationType::ErrorNotFound) => return Ok(true),
            Ok(current) if current.is_type(CommunicationType::MessageGet) => {
                if current.get_str(DataType::Principal) != Some(principal.as_str())
                    || current.get_str(DataType::RelayMessageId) != Some(hint.relay_id.as_str())
                {
                    return Err("Notification lookup identity changed".into());
                }
                if current.get_str(DataType::Status) != Some("pruned") {
                    let digest = current
                        .get_str(DataType::Content)
                        .map(|text| mtp::crypto::sha256(text.as_bytes()));
                    if digest != hint.digest
                        || current
                            .get_data(DataType::VersionNumber)
                            .and_then(DataValue::as_number)
                            != hint.version
                    {
                        return Ok(true);
                    }
                    stored = Some(current);
                }
            }
            _ => {}
        }
    }
    if crate::mtp_backend::manager().current_generation() != generation {
        return Ok(false);
    }
    if let Some(stored) = stored {
        let lifecycle =
            tauri_plugin_mtp::mobile::lifecycle().ok_or("Native lifecycle unavailable")?;
        let identity = lifecycle
            .identities
            .entries
            .lock()
            .await
            .get(crate::mtp_plugin::CONNECTION_NAME)
            .and_then(|identity| identity.client_id.map(|user| (user, identity.keys.clone())));
        if let Some((user, keys)) = identity {
            match crate::mtp_backend::notify_message_preview(
                user,
                &keys,
                session,
                stored.payload(),
                &hint.title,
                NotificationReceipt {
                    relay_id: &hint.relay_id,
                    stamp: hint.stamp,
                },
                generation,
            )
            .await
            {
                Ok(()) => {
                    return Ok(crate::mtp_backend::manager().current_generation() == generation)
                }
                Err(error) => {
                    eprintln!("Notification preview unavailable: {error}");
                    generic = "New encrypted message";
                }
            }
        }
    }
    crate::mtp_backend::notify_generic(
        generation,
        id,
        &hint.title,
        generic,
        Some(&principal),
        Some(NotificationReceipt {
            relay_id: &hint.relay_id,
            stamp: hint.stamp,
        }),
    )?;
    Ok(crate::mtp_backend::manager().current_generation() == generation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_bursts_debounce_per_conversation_with_a_one_second_limit() {
        let owner =
            tau_relay_protocol::Principal::new(format!("omega-key:{}", "a".repeat(64)), 1).unwrap();
        let mut pending = VecDeque::new();
        let first = tokio::time::Instant::now();
        for order in 0..10 {
            let now = first + std::time::Duration::from_millis(order * 100);
            let hint = PendingNotification {
                account: "debounce-account".into(),
                signer: owner.clone(),
                relay_id: uuid::Uuid::new_v4().to_string(),
                kind: CommunicationType::MessageSend,
                digest: None,
                version: None,
                stamp: NotificationStamp { time: 10, order },
                title: "Verified sender".into(),
                first: now,
                due: now + std::time::Duration::from_millis(200),
            };
            coalesce_pending(&mut pending, &owner, hint).unwrap();
        }
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].stamp.order, 9);
        assert_eq!(pending[0].first, first);
        assert_eq!(pending[0].due, first + std::time::Duration::from_secs(1));
        let mut unrelated = pending[0].clone();
        unrelated.signer.user_id = 2;
        unrelated.due = first + std::time::Duration::from_millis(200);
        coalesce_pending(&mut pending, &owner, unrelated).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(
            pending[1].due,
            first + std::time::Duration::from_millis(200)
        );
    }

    #[test]
    fn delivery_order_survives_replay_and_handled_ids_are_not_reaccepted() {
        let key = format!("notification-test-{}", uuid::Uuid::new_v4());
        assert_eq!(accept_event(&key, 7).unwrap(), Some(7));
        assert_eq!(accept_event(&key, 20).unwrap(), Some(7));
        assert!(claim(&key).unwrap());
        assert!(!claim(&key).unwrap());
        assert_eq!(accept_event(&key, 30).unwrap(), None);
    }

    #[test]
    fn handoff_dismisses_only_the_saved_conversation_through_its_exact_order() {
        let _lifecycle = crate::mtp_backend::TEST_LIFECYCLE.lock().unwrap();
        let signer =
            tau_relay_protocol::Principal::new(format!("omega-key:{}", "b".repeat(64)), 2).unwrap();
        let owner =
            tau_relay_protocol::Principal::new(format!("omega-key:{}", "a".repeat(64)), 1).unwrap();
        let account = serde_json::to_string(&(&owner, 77)).unwrap();
        let principal = serde_json::to_string(&signer).unwrap();
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        {
            let mut pending = PENDING_NOTIFICATIONS
                .get_or_init(|| Mutex::new(VecDeque::new()))
                .lock()
                .unwrap();
            for (relay_id, order) in [(&first, 1), (&second, 2)] {
                pending.push_back(PendingNotification {
                    account: account.clone(),
                    signer: signer.clone(),
                    relay_id: relay_id.clone(),
                    kind: CommunicationType::MessageSend,
                    digest: None,
                    version: None,
                    stamp: NotificationStamp { time: 10, order },
                    title: "Verified sender".into(),
                    first: tokio::time::Instant::now(),
                    due: tokio::time::Instant::now(),
                });
            }
        }
        dismiss_pending_conversation(
            &account,
            &principal,
            NotificationStamp { time: 10, order: 1 },
        )
        .unwrap();
        let pending = PENDING_NOTIFICATIONS.get().unwrap().lock().unwrap();
        assert!(!pending.iter().any(|hint| hint.relay_id == first));
        assert!(pending.iter().any(|hint| hint.relay_id == second));
        drop(pending);
        assert!(!claim(&serde_json::to_string(&(&owner, &signer, &first)).unwrap()).unwrap());
        dismiss_pending_conversation(
            &account,
            &principal,
            NotificationStamp { time: 10, order: 2 },
        )
        .unwrap();
    }

    #[test]
    fn delayed_previews_require_the_exact_current_author_id_content_and_epoch() {
        let original = CommunicationValue::new(CommunicationType::MessageSend)
            .add_typed_default(DataType::Content, DataValue::Str("AQ==".into()))
            .add_typed_default(DataType::VersionNumber, DataValue::SignedNumber(1));
        let response = CommunicationValue::new(CommunicationType::MessageGet)
            .add_typed_default(
                DataType::Principal,
                DataValue::Str("canonical-author".into()),
            )
            .add_typed_default(
                DataType::RelayMessageId,
                DataValue::Str("exact-message".into()),
            )
            .add_typed_default(DataType::Content, DataValue::Str("AQ==".into()))
            .add_typed_default(DataType::VersionNumber, DataValue::SignedNumber(1));
        assert!(current_message_matches(
            &response,
            "canonical-author",
            "exact-message",
            original.payload()
        ));
        assert!(!current_message_matches(
            &response,
            "wrong-author",
            "exact-message",
            original.payload()
        ));
        assert!(!current_message_matches(
            &response,
            "canonical-author",
            "wrong-message",
            original.payload()
        ));
        for changed in [
            response
                .clone()
                .add_typed_default(DataType::Content, DataValue::Str("edited".into())),
            response
                .clone()
                .add_typed_default(DataType::VersionNumber, DataValue::SignedNumber(2)),
            CommunicationValue::new(CommunicationType::ErrorNotFound),
        ] {
            assert!(!current_message_matches(
                &changed,
                "canonical-author",
                "exact-message",
                original.payload()
            ));
        }
    }
}

#[tauri::command]
pub fn mtp_post_message_notification(
    account: String,
    signer: tau_relay_protocol::Principal,
    relay_id: String,
    title: String,
    body: String,
    time: i64,
    order: u64,
) -> Result<bool, String> {
    let snapshot = crate::mtp_backend::manager().snapshot();
    let scope = snapshot.scope.ok_or("Native account unavailable")?;
    if !snapshot.identified
        || account
            != serde_json::to_string(&(&scope.principal, scope.authorization_generation))
                .map_err(|error| error.to_string())?
        || signer.validate().is_err()
        || relay_id.is_empty()
        || relay_id.len() > 128
    {
        return Err("Notification belongs to another account".into());
    }
    let principal = serde_json::to_string(&signer).map_err(|error| error.to_string())?;
    if crate::mtp_backend::manager().renderer_notifications_active()
        && crate::mtp_backend::manager()
            .viewed_conversation
            .read()
            .map_err(|_| "Notification view unavailable")?
            .as_deref()
            == Some(principal.as_str())
    {
        claim(
            &serde_json::to_string(&(&scope.principal, &signer, &relay_id))
                .map_err(|error| error.to_string())?,
        )?;
        dismiss_pending_conversation(
            &account,
            &principal,
            NotificationStamp {
                time: i64::MAX,
                order: u64::MAX,
            },
        )?;
        return Ok(false);
    }
    if title.len() > 4096 || body.len() > 64 * 1024 {
        return Err("Notification exceeds capacity".into());
    }
    let id = crate::mtp_backend::message_notification_id(&account, &principal);
    crate::mtp_backend::notify_generic(
        snapshot.generation,
        id,
        &title,
        &body,
        Some(&principal),
        Some(NotificationReceipt {
            relay_id: &relay_id,
            stamp: NotificationStamp { time, order },
        }),
    )
}
