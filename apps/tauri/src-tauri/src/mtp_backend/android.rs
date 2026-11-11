use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};

use jni::{
    jni_sig, jni_str,
    objects::{Global, JClass, JObject, JString, JValue},
    Env, EnvUnowned, JavaVM,
};
use serde_json::Value;
use tauri::Manager;

pub struct Host {
    vm: JavaVM,
    context: Global<JObject<'static>>,
    bridge: Global<JObject<'static>>,
}

static HOST: OnceLock<Host> = OnceLock::new();
static ACTIVITY_VISIBLE: AtomicBool = AtomicBool::new(false);

pub fn attach(env: &mut Env, context: JObject) -> Result<(), String> {
    if HOST.get().is_some() {
        return Ok(());
    }
    let class = env
        .find_class(jni_str!("net/tensamin/client/NativeMtpBridge"))
        .map_err(|e| e.to_string())?;
    let bridge = env
        .get_static_field(
            class,
            jni_str!("INSTANCE"),
            jni_sig!("Lnet/tensamin/client/NativeMtpBridge;"),
        )
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    HOST.set(Host {
        vm: env.get_java_vm().map_err(|e| e.to_string())?,
        context: env.new_global_ref(context).map_err(|e| e.to_string())?,
        bridge: env.new_global_ref(bridge).map_err(|e| e.to_string())?,
    })
    .map_err(|_| "Android MTP host is already attached".to_string())
}

fn with_env<T>(call: impl FnOnce(&mut Env, &Host) -> Result<T, String>) -> Result<T, String> {
    let host = HOST.get().ok_or("Android MTP host is not attached")?;
    host.vm
        .attach_current_thread(|env| Ok::<_, jni::errors::Error>(call(env, host)))
        .map_err(|e| e.to_string())?
}

pub fn store_config(config: &str) -> Result<(), String> {
    with_env(|env, host| {
        let value = env.new_string(config).map_err(|e| e.to_string())?;
        env.call_method(
            host.bridge.as_obj(),
            jni_str!("storeConfig"),
            jni_sig!("(Landroid/content/Context;Ljava/lang/String;)V"),
            &[
                JValue::Object(host.context.as_obj()),
                JValue::Object(&value),
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

pub fn files_directory() -> Result<std::path::PathBuf, String> {
    with_env(|env, host| {
        let file = env
            .call_method(
                host.context.as_obj(),
                jni_str!("getFilesDir"),
                jni_sig!("()Ljava/io/File;"),
                &[],
            )
            .and_then(|value| value.l())
            .map_err(|error| error.to_string())?;
        let path = env
            .call_method(
                &file,
                jni_str!("getAbsolutePath"),
                jni_sig!("()Ljava/lang/String;"),
                &[],
            )
            .and_then(|value| value.l())
            .map_err(|error| error.to_string())?;
        let path = env
            .cast_local::<JString>(path)
            .map_err(|error| error.to_string())?;
        path.mutf8_chars(env)
            .map(|value| std::path::PathBuf::from(value.to_str().as_ref()))
            .map_err(|error| error.to_string())
    })
}

pub fn clear_config() -> Result<(), String> {
    with_env(|env, host| {
        env.call_method(
            host.bridge.as_obj(),
            jni_str!("clearConfig"),
            jni_sig!("(Landroid/content/Context;)V"),
            &[JValue::Object(host.context.as_obj())],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

pub fn load_config() -> Result<Option<String>, String> {
    with_env(|env, host| {
        let value = env
            .call_method(
                host.bridge.as_obj(),
                jni_str!("loadConfig"),
                jni_sig!("(Landroid/content/Context;)Ljava/lang/String;"),
                &[JValue::Object(host.context.as_obj())],
            )
            .and_then(|value| value.l())
            .map_err(|e| e.to_string())?;
        if value.is_null() {
            return Ok(None);
        }
        let value = env
            .cast_local::<JString>(value)
            .map_err(|e| e.to_string())?;
        value
            .mutf8_chars(env)
            .map(|value| Some(value.to_str().into_owned()))
            .map_err(|e| e.to_string())
    })
}

pub fn root_certificates() -> Result<Vec<u8>, String> {
    with_env(|env, host| {
        let value = env
            .call_method(
                host.bridge.as_obj(),
                jni_str!("trustedCertificates"),
                jni_sig!("()Ljava/lang/String;"),
                &[],
            )
            .and_then(|value| value.l())
            .map_err(|e| e.to_string())?;
        let value = env
            .cast_local::<JString>(value)
            .map_err(|e| e.to_string())?;
        value
            .mutf8_chars(env)
            .map(|value| value.to_str().as_bytes().to_vec())
            .map_err(|e| e.to_string())
    })
}

pub fn has_config() -> Result<bool, String> {
    with_env(|env, host| {
        env.call_method(
            host.bridge.as_obj(),
            jni_str!("hasConfig"),
            jni_sig!("(Landroid/content/Context;)Z"),
            &[JValue::Object(host.context.as_obj())],
        )
        .and_then(|value| value.z())
        .map_err(|e| e.to_string())
    })
}

pub fn set_call_active(active: bool, microphone: bool) -> Result<(), String> {
    with_env(|env, host| {
        env.call_method(
            host.bridge.as_obj(),
            jni_str!("setCallActive"),
            jni_sig!("(Landroid/content/Context;ZZ)V"),
            &[
                JValue::Object(host.context.as_obj()),
                JValue::Bool(active),
                JValue::Bool(microphone),
            ],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
}

pub fn notify(
    sender_id: u64,
    sender: &str,
    body: &str,
    avatar: Option<&[u8]>,
    principal: Option<&str>,
) -> Result<(), String> {
    with_env(|env, host| {
        let sender = env.new_string(sender).map_err(|e| e.to_string())?;
        let body = env.new_string(body).map_err(|e| e.to_string())?;
        let principal = env
            .new_string(principal.unwrap_or(""))
            .map_err(|e| e.to_string())?;
        let scope = crate::mtp_backend::manager()
            .snapshot()
            .scope
            .ok_or("Native account unavailable")?;
        let account = env
            .new_string(
                serde_json::to_string(&(&scope.principal, scope.authorization_generation))
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        let avatar = env
            .byte_array_from_slice(avatar.unwrap_or_default())
            .map_err(|e| e.to_string())?;
        env.call_method(
            host.bridge.as_obj(),
            jni_str!("postMessageNotification"),
            jni_sig!("(Landroid/content/Context;JLjava/lang/String;Ljava/lang/String;[BLjava/lang/String;Ljava/lang/String;)V"),
            &[
                JValue::Object(host.context.as_obj()),
                JValue::Long(sender_id as i64),
                JValue::Object(&sender),
                JValue::Object(&body),
                JValue::Object(&avatar),
                JValue::Object(&principal),
                JValue::Object(&account),
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

pub fn cancel_notification(sender_id: u64) -> Result<(), String> {
    with_env(|env, host| {
        env.call_method(
            host.bridge.as_obj(),
            jni_str!("cancelMessageNotification"),
            jni_sig!("(Landroid/content/Context;J)V"),
            &[
                JValue::Object(host.context.as_obj()),
                JValue::Long(sender_id as i64),
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

pub fn is_ignoring_battery_optimizations() -> Result<bool, String> {
    with_env(|env, host| {
        env.call_method(
            host.bridge.as_obj(),
            jni_str!("isIgnoringBatteryOptimizations"),
            jni_sig!("(Landroid/content/Context;)Z"),
            &[JValue::Object(host.context.as_obj())],
        )
        .and_then(|value| value.z())
        .map_err(|e| e.to_string())
    })
}

pub fn request_battery_exemption() -> Result<(), String> {
    with_env(|env, host| {
        env.call_method(
            host.bridge.as_obj(),
            jni_str!("requestBatteryExemption"),
            jni_sig!("(Landroid/content/Context;)V"),
            &[JValue::Object(host.context.as_obj())],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[no_mangle]
pub extern "system" fn Java_net_tensamin_client_NativeMtpBridge_nativeAttach<'caller>(
    mut env: EnvUnowned<'caller>,
    _class: JClass,
    context: JObject<'caller>,
) {
    let _ = env.with_env(|env| {
        let _ = attach(env, context);
        Ok::<_, jni::errors::Error>(())
    });
    let manager = crate::mtp_backend::manager();
    let Some(app) = manager.app.read().expect("app lock poisoned").clone() else {
        return;
    };
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if !ACTIVITY_VISIBLE.load(Ordering::SeqCst) || handle.get_webview_window("main").is_some() {
            return;
        }
        let Some(config) = handle
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
        else {
            return;
        };
        if let Err(error) = tauri::WebviewWindowBuilder::from_config(&handle, config)
            .and_then(|builder| builder.build())
        {
            manager.log(
                0,
                "Failed to restore Android window",
                Some(Value::String(error.to_string())),
            );
        }
    }) {
        manager.log(
            0,
            "Failed to schedule Android window restoration",
            Some(Value::String(error.to_string())),
        );
    }
}

#[no_mangle]
pub extern "system" fn Java_net_tensamin_client_NativeMtpBridge_nativeSetUiState(
    _env: EnvUnowned,
    _class: JClass,
    visible: jni::sys::jboolean,
) {
    ACTIVITY_VISIBLE.store(visible, Ordering::SeqCst);
    crate::mtp_backend::manager().set_platform_visible(visible);
}

#[no_mangle]
pub extern "system" fn Java_net_tensamin_client_NativeMtpBridge_nativeViewDestroyed(
    _env: EnvUnowned,
    _class: JClass,
) {
    crate::mtp_backend::manager().view_destroyed();
}

#[no_mangle]
pub extern "system" fn Java_net_tensamin_client_NativeMtpBridge_nativeLog<'caller>(
    mut env: EnvUnowned<'caller>,
    _class: JClass,
    level: jni::sys::jint,
    message: JString<'caller>,
    details: JString<'caller>,
) {
    let _ = env.with_env(|env| {
        if let (Ok(message), Ok(details)) = (message.mutf8_chars(env), details.mutf8_chars(env)) {
            let message = message.to_str();
            let details = details.to_str();
            crate::mtp_backend::manager().log(
                level.clamp(0, 3) as u8,
                message.into_owned(),
                (!details.is_empty()).then(|| Value::String(details.into_owned())),
            );
        }
        Ok::<_, jni::errors::Error>(())
    });
}
