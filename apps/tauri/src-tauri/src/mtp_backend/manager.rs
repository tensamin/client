use super::*;

pub fn manager() -> &'static MtpManager {
    MANAGER.get_or_init(|| MtpManager {
        runtime: tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("tensamin-mtp")
            .build()
            .expect("failed to create MTP runtime"),
        config: RwLock::new(None),
        snapshot: RwLock::new(MtpSnapshot {
            ready_state: DISCONNECTED,
            ..MtpSnapshot::default()
        }),
        generation: AtomicU64::new(0),
        enabled: AtomicBool::new(false),
        ui_visible: AtomicBool::new(false),
        ui_generation: AtomicU64::new(0),
        call_active: AtomicBool::new(false),
        document_visible: AtomicBool::new(false),
        platform_visible: AtomicBool::new(true),
        viewed_conversation: RwLock::new(None),
        notification_owner: RwLock::new(None),
        pending_calls: RwLock::new(CallInvitations::default()),
        app: RwLock::new(None),
    })
}

impl MtpManager {
    pub(crate) fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    pub fn attach_app(&self, app: AppHandle) {
        *self.app.write().expect("app lock poisoned") = Some(app);
    }

    pub fn stop(&self) {
        self.call_active.store(false, Ordering::SeqCst);
        #[cfg(target_os = "android")]
        if let Err(error) = android::set_call_active(false, false) {
            eprintln!("Unable to stop native call audio: {error}");
        }
        crate::mtp_relay::clear_pending_notifications();
        *self
            .notification_owner
            .write()
            .expect("Notification owner unavailable") = None;
        *self
            .pending_calls
            .write()
            .expect("Call invitations unavailable") = CallInvitations::default();
        self.enabled.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.wake_file_operations();
        *self
            .viewed_conversation
            .write()
            .expect("Notification view unavailable") = None;
        self.set_snapshot(MtpSnapshot {
            generation: self.generation.load(Ordering::SeqCst),
            ready_state: DISCONNECTED,
            identified: false,
            scope: None,
            error: None,
        });
    }

    pub fn set_ui_visible(&self, visible: bool) {
        self.document_visible.store(visible, Ordering::SeqCst);
        self.update_visibility();
    }

    pub(super) fn wake_file_operations(&self) {
        let _visibility = FILE_VISIBILITY
            .0
            .lock()
            .expect("File visibility unavailable");
        FILE_VISIBILITY.1.notify_all();
    }

    pub(crate) fn wait_for_file_foreground(
        &self,
        generation: u64,
        ui_generation: u64,
    ) -> Result<(), String> {
        let mut visibility = FILE_VISIBILITY
            .0
            .lock()
            .map_err(|_| "File visibility unavailable")?;
        loop {
            if self.current_generation() != generation
                || self.ui_generation.load(Ordering::SeqCst) != ui_generation
            {
                return Err("File operation lifetime changed".into());
            }
            if self.ui_visible.load(Ordering::SeqCst) {
                return Ok(());
            }
            visibility = FILE_VISIBILITY
                .1
                .wait(visibility)
                .map_err(|_| "File visibility unavailable")?;
        }
    }

    pub(crate) fn view_destroyed(&self) {
        self.ui_generation.fetch_add(1, Ordering::SeqCst);
        self.call_active.store(false, Ordering::SeqCst);
        self.set_platform_visible(false);
        self.wake_file_operations();
    }

    pub(crate) fn set_platform_visible(&self, visible: bool) {
        self.platform_visible.store(visible, Ordering::SeqCst);
        self.update_visibility();
    }

    pub(super) fn update_visibility(&self) {
        let visible = self.document_visible.load(Ordering::SeqCst)
            && self.platform_visible.load(Ordering::SeqCst);
        if self.ui_visible.swap(visible, Ordering::SeqCst) == visible {
            return;
        }
        self.wake_file_operations();
        if let Some(app) = self.app.read().expect("app lock poisoned").as_ref() {
            let _ = app.emit("tensamin://visibility", visible);
        }
        if !visible {
            crate::mtp_relay::wake_notifications();
        } else {
            self.emit(MtpEvent::State {
                snapshot: self.snapshot(),
            });
        }
    }

    pub(crate) fn relay_hint(
        &self,
        account: &str,
        signer: &str,
        relay_id: &str,
        kind: &str,
        time: i64,
        order: u64,
    ) {
        if !self.ui_visible.load(Ordering::SeqCst) {
            return;
        }
        if let Some(app) = self.app.read().expect("app lock poisoned").as_ref() {
            let _ = app.emit("tensamin://notification", serde_json::json!({"account":account,"signer":signer,"relayId":relay_id,"kind":kind,"time":time,"order":order}));
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn snapshot(&self) -> MtpSnapshot {
        self.snapshot
            .read()
            .expect("snapshot lock poisoned")
            .clone()
    }

    pub(crate) fn renderer_notifications_active(&self) -> bool {
        if !self.ui_visible.load(Ordering::SeqCst) {
            return false;
        }
        let Some(scope) = self.snapshot().scope else {
            return false;
        };
        let Ok(account) =
            serde_json::to_string(&(&scope.principal, scope.authorization_generation))
        else {
            return false;
        };
        self.notification_owner
            .read()
            .is_ok_and(|owner| owner.as_ref().is_some_and(|(owner, _)| owner == &account))
    }

    pub(super) fn set_snapshot(&self, snapshot: MtpSnapshot) {
        if let Some(error) = snapshot.error.as_ref() {
            eprintln!("android: MTP connection failed: {error}");
        }
        let mut current = self.snapshot.write().expect("snapshot lock poisoned");
        if snapshot.generation < current.generation {
            return;
        }
        *current = snapshot.clone();
        self.emit(MtpEvent::State { snapshot });
    }

    pub(crate) fn set_authenticated_scope(
        &self,
        generation: u64,
        scope: tau_relay_protocol::sync::Scope,
    ) -> Result<(), String> {
        if self.current_generation() != generation
            || !scope.validate()
            || scope.principal.user_id != current_config()?.user_id
        {
            return Err("Native authentication context changed".into());
        }
        self.set_snapshot(MtpSnapshot {
            generation,
            ready_state: CONNECTED,
            identified: true,
            scope: Some(scope),
            error: None,
        });
        crate::mtp_relay::wake_notifications();
        Ok(())
    }

    pub(super) fn emit(&self, event: MtpEvent) {
        if !self.ui_visible.load(Ordering::SeqCst) && !self.call_active.load(Ordering::SeqCst) {
            return;
        }
        if let Some(app) = self.app.read().expect("app lock poisoned").as_ref() {
            let _ = app.emit(EVENT_NAME, event);
        }
    }

    pub(super) fn log(&self, level: u8, message: impl Into<String>, details: Option<Value>) {
        let message = message.into();
        eprintln!(
            "android: {message}{}",
            details
                .as_ref()
                .map(|value| format!(": {value}"))
                .unwrap_or_default()
        );
        self.emit(MtpEvent::Log {
            level,
            message,
            details,
        });
    }
}
