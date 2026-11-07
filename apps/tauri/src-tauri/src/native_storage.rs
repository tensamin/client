use std::{io::Write, path::Path};

pub(crate) fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    path.parent().ok_or("Private file has no directory")?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        publish_private_atomic(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn publish_private_atomic(temporary: &Path, path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("Private file has no directory")?;
    if temporary.parent() != Some(parent) {
        return Err("Atomic file publication requires the same directory".into());
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(temporary, path).map_err(|error| error.to_string())?;
        sync_directory(parent)?;
        if let Some(ancestor) = parent.parent() {
            sync_directory(ancestor)?;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from = temporary
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let to = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        // Both paths are terminated UTF-16 buffers kept alive for this call.
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn sync_directory(path: &Path) -> Result<(), String> {
    std::fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}
