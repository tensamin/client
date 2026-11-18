use mtp::common::diagnostics;
use serde_json::{json, Value};
use std::io::Write;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

pub fn initialize(directory: std::path::PathBuf) {
    if std::fs::create_dir_all(&directory).is_ok() {
        diagnostics::configure(directory.join("usage-diagnostics.json"));
    }
    diagnostics::set_sampler(sample);
    diagnostics::record("runtime.native_start", 1);
}

fn sample() {
    let info = device_info();
    for (field, metric) in [
        ("process_cpu_total_ms", "process.cpu_total_ms"),
        ("process_memory_bytes", "process.memory_bytes"),
        ("process_pss_kib", "process.pss_kib"),
        ("uid_received_bytes", "network.uid_received_total_bytes"),
        ("uid_sent_bytes", "network.uid_sent_total_bytes"),
        ("battery_percent", "battery.percent"),
    ] {
        if let Some(value) = info[field].as_u64() {
            diagnostics::record(metric, value);
        }
    }
    if let Some(value) = info["charging"].as_bool() {
        diagnostics::record("battery.charging", u64::from(value));
    }
}

fn device_info() -> Value {
    #[cfg(target_os = "android")]
    {
        crate::mtp_backend::android_diagnostics_info()
            .unwrap_or_else(|_| json!({"status": "unavailable"}))
    }
    #[cfg(not(target_os = "android"))]
    {
        use std::sync::{Mutex, OnceLock};
        use sysinfo::{ProcessesToUpdate, System};
        static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();
        let mut system = SYSTEM
            .get_or_init(|| {
                let mut system = System::new();
                system.refresh_cpu_all();
                system.refresh_memory();
                Mutex::new(system)
            })
            .lock()
            .expect("system information unavailable");
        let pid = sysinfo::Pid::from_u32(std::process::id());
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        json!({
            "os": System::name(), "os_version": System::long_os_version(), "kernel_version": System::kernel_version(),
            "architecture": std::env::consts::ARCH, "cpu_model": system.cpus().first().map(|cpu| cpu.brand()),
            "cpu_cores": system.cpus().len(), "ram_bytes": system.total_memory(),
            "process_memory_bytes": system.process(pid).map(|process| process.memory()),
            "process_cpu_total_ms": system.process(pid).map(|process| process.accumulated_cpu_time()),
        })
    }
}

#[tauri::command]
pub fn usage_diagnostics(
    app: tauri::AppHandle,
    action: &str,
    argument: Option<&str>,
    value: Option<u64>,
) -> Result<Value, String> {
    match action {
        "enabled" => diagnostics::set_enabled(argument == Some("true")),
        "clear" => diagnostics::clear(),
        "event" => {
            diagnostics::runtime_event(argument.unwrap_or(""), value.unwrap_or(1));
            return Ok(Value::Null);
        }
        "snapshot" => {}
        _ => return Err("Unknown diagnostic action".into()),
    }
    let history = diagnostics::snapshot();
    if matches!(action, "enabled" | "clear") && !history.storage_available {
        return Err("Diagnostic changes could not be saved on this device".into());
    }
    Ok(json!({
        "device": device_info(),
        "history": history,
        "client_revision": option_env!("TENSAMIN_CLIENT_REVISION").unwrap_or("unavailable"),
        "mtp_revision": option_env!("TENSAMIN_MTP_REVISION").unwrap_or("unavailable"),
        "app_version": app.package_info().version.to_string(),
        "channel": option_env!("TENSAMIN_CHANNEL").unwrap_or("unavailable"),
    }))
}

#[tauri::command]
pub async fn export_usage_diagnostics(
    app: tauri::AppHandle,
    renderer: String,
) -> Result<bool, String> {
    if renderer.len() > 64 * 1024 {
        return Err("Diagnostic context is too large".into());
    }
    // Only renderer environment and report field descriptions cross this boundary.
    let renderer: Value =
        serde_json::from_str(&renderer).map_err(|_| "Invalid renderer context")?;
    let snapshot = usage_diagnostics(app.clone(), "snapshot", None, None)?;
    let history: diagnostics::Snapshot = serde_json::from_value(snapshot["history"].clone())
        .map_err(|_| "Unable to read diagnostic history")?;
    let mut totals = std::collections::BTreeMap::<String, diagnostics::Aggregate>::new();
    for bucket in &history.buckets {
        for (name, metric) in &bucket.metrics {
            let total = totals.entry(name.clone()).or_default();
            total.count = total.count.saturating_add(metric.count);
            total.total = total.total.saturating_add(metric.total);
            total.max = total.max.max(metric.max);
        }
    }
    let report = json!({
        "schema_version": 1,
        "exported_at": renderer["exported_at"],
        "environment": {
            "client_type": "tauri",
            "app_version": snapshot["app_version"], "channel": snapshot["channel"],
            "client_revision": snapshot["client_revision"], "mtp_revision": snapshot["mtp_revision"],
            "mtp_version": history.mtp_version, "device": snapshot["device"],
            "browser": renderer["environment"]["browser"],
        },
        "history": history,
        "summary": { "buckets": history.buckets.len(), "metrics": totals },
        "storage_available": history.storage_available,
        "units": renderer["units"], "limitations": renderer["limitations"],
    });
    let bytes =
        serde_json::to_vec_pretty(&report).map_err(|_| "Unable to encode diagnostic report")?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Export usage diagnostics")
        .set_file_name("tensamin-diagnostics.json")
        .add_filter("JSON report", &["json"])
        .save_file(move |path| {
            let _ = send.send(path);
        });
    let Some(path) = receive
        .await
        .map_err(|_| "Unable to select export destination")?
    else {
        return Ok(false);
    };
    let mut options = tauri_plugin_fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let mut output = app
        .fs()
        .open(path, options)
        .map_err(|_| "Unable to open export destination")?;
    output
        .write_all(&bytes)
        .map_err(|_| "Unable to write diagnostic report")?;
    Ok(true)
}
