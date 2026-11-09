mod accessibility_backend;
mod file_staging;
mod mtp_backend;
#[cfg(not(target_os = "android"))]
mod mtp_credentials;
mod mtp_plugin;
mod mtp_principal_proof;
mod mtp_relay;
mod native_storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_mtp::init(mtp_plugin::manager()))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_notification::init());

    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    let app = builder
        .on_window_event(|window, event| {
            #[cfg(not(target_os = "android"))]
            if matches!(event, tauri::WindowEvent::Destroyed) {
                mtp_backend::manager().view_destroyed();
            }
            #[cfg(not(target_os = "android"))]
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)
            ) {
                let visible =
                    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true);
                mtp_backend::manager().set_platform_visible(visible);
            }
            #[cfg(target_os = "android")]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            accessibility_backend::accessibility_get_initial_scale,
            file_staging::file_stage_create,
            file_staging::file_stage_append,
            file_staging::file_stage_commit,
            file_staging::file_stage_info,
            file_staging::file_stage_read,
            file_staging::file_stage_remove,
            file_staging::file_stage_export,
            accessibility_backend::accessibility_set_initial_scale,
            mtp_backend::mtp_prepare_sealed_relay,
            mtp_backend::mtp_send_prepared_relay,
            mtp_backend::mtp_send_call_control,
            mtp_backend::mtp_status,
            mtp_backend::mtp_credential_metadata,
            mtp_backend::mtp_refresh_identity,
            mtp_backend::mtp_pending_calls,
            mtp_backend::mtp_dismiss_call_invite,
            mtp_backend::mtp_call_invite_handled,
            mtp_relay::mtp_post_message_notification,
            mtp_backend::mtp_frontend_options,
            mtp_backend::mtp_store_credentials,
            mtp_backend::mtp_clear_credentials,
            mtp_backend::mtp_has_credentials,
            mtp_backend::mtp_restore_credentials,
            mtp_backend::mtp_set_ui_visible,
            mtp_backend::mtp_set_call_active,
            mtp_backend::mtp_set_notification_owner,
            mtp_backend::mtp_set_viewed_conversation,
            mtp_backend::mtp_is_ignoring_battery_optimizations,
            mtp_backend::mtp_request_battery_exemption,
        ])
        .setup(|_app| {
            mtp_backend::manager().attach_app(_app.handle().clone());
            #[cfg(any(target_os = "linux", windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                if let Err(error) = _app.deep_link().register_all() {
                    if cfg!(debug_assertions) {
                        eprintln!("Skipping deep link registration during dev: {error}");
                    } else {
                        return Err(error.into());
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        #[cfg(target_os = "android")]
        if let tauri::RunEvent::ExitRequested {
            api, code: None, ..
        } = _event
        {
            if mtp_backend::manager().is_enabled() {
                api.prevent_exit();
            }
        }
    });
}
