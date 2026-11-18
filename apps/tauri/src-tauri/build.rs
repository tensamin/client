fn main() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    for (name, path) in [
        ("TENSAMIN_CLIENT_REVISION", root.join("../../..")),
        ("TENSAMIN_MTP_REVISION", root.join("../../../../../mtp")),
    ] {
        println!("cargo:rerun-if-env-changed={name}");
        if let Ok(value) = std::env::var(name) {
            println!("cargo:rustc-env={name}={value}");
            continue;
        }
        if let Ok(output) = std::process::Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["rev-parse", "HEAD"])
            .output()
        {
            if output.status.success() {
                println!(
                    "cargo:rustc-env={name}={}",
                    String::from_utf8_lossy(&output.stdout).trim()
                );
                println!(
                    "cargo:rerun-if-changed={}",
                    path.join(".git/HEAD").display()
                );
                println!(
                    "cargo:rerun-if-changed={}",
                    path.join(".git/refs").display()
                );
            }
        }
    }
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // JNI must match the Kotlin namespace, not the channel-specific application ID.
        println!("cargo:rustc-env=TAURI_ANDROID_PACKAGE_NAME_PREFIX=net_tensamin");
        println!("cargo:rustc-env=TAURI_ANDROID_PACKAGE_NAME_APP_NAME=client");
    }
}
