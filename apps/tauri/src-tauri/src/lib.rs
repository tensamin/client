mod accessibility_backend;
mod mtp_backend;
mod mtp_plugin;

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
        .plugin(tauri_plugin_opener::init());

    let app = builder
        .invoke_handler(tauri::generate_handler![
            accessibility_backend::accessibility_get_initial_scale,
            accessibility_backend::accessibility_set_initial_scale,
            mtp_backend::mtp_send_sealed_relay,
            mtp_backend::mtp_status,
            mtp_backend::mtp_refresh_state,
            mtp_backend::mtp_frontend_options,
            mtp_backend::mtp_store_credentials,
            mtp_backend::mtp_clear_credentials,
            mtp_backend::mtp_has_credentials,
            mtp_backend::mtp_restore_credentials,
            mtp_backend::mtp_set_ui_visible,
            mtp_backend::mtp_post_message_notification,
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
