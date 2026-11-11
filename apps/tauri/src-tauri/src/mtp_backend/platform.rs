use super::*;

pub fn file_directory() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        android::files_directory().map(|path| path.join("file-staging-v2"))
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri::Manager;
        let app = manager().app.read().map_err(|_| "app lock unavailable")?;
        app.as_ref()
            .ok_or("application directory unavailable")?
            .path()
            .app_local_data_dir()
            .map(|path| path.join("file-staging-v2"))
            .map_err(|error| error.to_string())
    }
}
#[cfg(not(target_os = "android"))]
pub(crate) fn android_notify(
    id: u64,
    title: &str,
    body: &str,
    _: Option<&[u8]>,
    _: Option<&str>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let app = manager()
        .app
        .read()
        .map_err(|_| "Application unavailable")?;
    let app = app.as_ref().ok_or("Application unavailable")?;
    app.notification()
        .builder()
        .id(id as i32)
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}
#[cfg(not(target_os = "android"))]
pub(super) fn android_cancel_notification(_: u64) -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "android"))]
pub(super) fn android_is_ignoring_battery_optimizations() -> Result<bool, String> {
    Ok(true)
}
#[cfg(not(target_os = "android"))]
pub(super) fn android_request_battery_exemption() -> Result<(), String> {
    Ok(())
}
