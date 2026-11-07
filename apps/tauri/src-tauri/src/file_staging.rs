use mtp::crypto::{derive_encryption_key, sha256, AeadDecrypt, AeadEncrypt, ChaCha20Poly1305};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;
use zeroize::Zeroizing;

const CHUNK_BYTES: usize = 256 * 1024;
const MAX_STAGES: usize = 64;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    Ciphertext,
    Plaintext,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    version: u8,
    generation: u64,
    purpose: Purpose,
    size: u64,
    committed: bool,
}

#[derive(Serialize)]
pub struct StageInfo {
    id: String,
    size: u64,
    committed: bool,
}

struct Context {
    namespace: String,
    cipher: ChaCha20Poly1305,
    generation: u64,
}

fn digest(bytes: &[u8]) -> String {
    sha256(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl Context {
    fn capture(account_key: &str) -> Result<Self, String> {
        let snapshot = crate::mtp_backend::manager().snapshot();
        if !snapshot.identified || snapshot.ready_state != 2 {
            return Err("File storage requires an authenticated account".into());
        }
        let scope: tau_relay_protocol::sync::Scope = serde_json::from_value(
            snapshot
                .state
                .as_ref()
                .and_then(|state| state.get("scope"))
                .cloned()
                .ok_or("File storage account scope is unavailable")?,
        )
        .map_err(|_| "Invalid file storage account scope")?;
        let expected = serde_json::to_string(&(&scope.principal, scope.authorization_generation))
            .map_err(|_| "Invalid file storage account")?;
        if account_key != expected || !scope.validate() {
            return Err("File storage belongs to another account".into());
        }
        let config = crate::mtp_backend::current_config()?;
        if config.user_id != scope.principal.user_id {
            return Err("File storage credentials changed".into());
        }
        let credential =
            Zeroizing::new(crate::mtp_backend::decode_browser_base64(&config.keyring)?);
        let binding = serde_json::to_vec(&(
            "tensamin-native-file-stage:v1",
            account_key,
            &config.omega_url,
            sha256(&credential),
        ))
        .map_err(|_| "Invalid file storage binding")?;
        let namespace = digest(&binding);
        let key = derive_encryption_key(&credential, b"tensamin-native-file-stage:v1", &binding)
            .map_err(|_| "Unable to derive private stage key")?;
        let context = Self {
            namespace,
            cipher: ChaCha20Poly1305::new(key),
            generation: snapshot.generation,
        };
        context.current()?;
        Ok(context)
    }

    fn current(&self) -> Result<(), String> {
        if crate::mtp_backend::manager().current_generation() != self.generation {
            return Err("Account changed during file storage operation".into());
        }
        Ok(())
    }

    fn aad(&self, id: &str, offset: u64) -> Vec<u8> {
        format!(
            "tensamin-private-file-output:v1:{}:{id}:{offset}",
            self.namespace
        )
        .into_bytes()
    }
}

fn private_directory(path: &Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| "Unable to create private file storage")?;
    #[cfg(not(windows))]
    {
        crate::native_storage::sync_directory(path)
            .map_err(|_| "Unable to commit private storage directory")?;
        if let Some(parent) = path.parent() {
            crate::native_storage::sync_directory(parent)
                .map_err(|_| "Unable to commit private storage parent")?;
        }
    }
    Ok(())
}

fn private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "Unable to create private file stage".into())
}

struct Store {
    root: PathBuf,
    _lease: File,
}
static STORE: OnceLock<Mutex<Option<Store>>> = OnceLock::new();

impl Store {
    fn export_path(&self, context: &Context, id: &str, path: &Path) -> Result<(), String> {
        self.copy_output(context, id, std::io::sink())?;
        let parent = path
            .parent()
            .ok_or("Selected export has no parent directory")?;
        let temporary = parent.join(format!(".tensamin-export-{}.tmp", uuid::Uuid::new_v4()));
        let mut output = private_file(&temporary)?;
        let result = (|| {
            self.copy_output(context, id, &mut output)?;
            output
                .sync_all()
                .map_err(|_| "Unable to commit exported file")?;
            drop(output);
            context.current()?;
            crate::native_storage::publish_private_atomic(&temporary, path)
                .map_err(|_| "Unable to publish verified export".to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    fn open(root: PathBuf) -> Result<Self, String> {
        private_directory(&root)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lease = options
            .open(root.join("owner.lock"))
            .map_err(|_| "Unable to lock private file storage")?;
        lease
            .try_lock()
            .map_err(|_| "Private file storage is already open in another application process")?;
        let store = Self {
            root,
            _lease: lease,
        };
        store.cleanup(None)?;
        Ok(store)
    }

    fn cleanup(&self, current: Option<&Context>) -> Result<usize, String> {
        let mut count = 0;
        for namespace in
            std::fs::read_dir(&self.root).map_err(|_| "Unable to inspect private file storage")?
        {
            let namespace = namespace.map_err(|_| "Unable to inspect private file storage")?;
            if !namespace
                .file_type()
                .map_err(|_| "Unable to inspect private file storage")?
                .is_dir()
            {
                continue;
            }
            let name = namespace.file_name().to_string_lossy().into_owned();
            if name.len() != 64
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                continue;
            }
            for stage in std::fs::read_dir(namespace.path())
                .map_err(|_| "Unable to inspect private file stages")?
            {
                let stage = stage.map_err(|_| "Unable to inspect private file stages")?;
                if !stage
                    .file_type()
                    .map_err(|_| "Unable to inspect private file stage")?
                    .is_dir()
                {
                    continue;
                }
                if uuid::Uuid::parse_str(&stage.file_name().to_string_lossy()).is_err() {
                    continue;
                }
                let header = Self::header(&stage.path());
                // No other process can own this store while the lease is held.
                // Interrupted encryption cannot resume, and plaintext output is
                // transient. Completed ciphertext remains for durable uploads.
                let remove = header.as_ref().is_ok_and(|header| {
                    let owned = current.is_some_and(|context| {
                        context.namespace == name && context.generation == header.generation
                    });
                    !owned && (!header.committed || header.purpose == Purpose::Plaintext)
                });
                if remove {
                    std::fs::remove_dir_all(stage.path())
                        .map_err(|_| "Unable to clear interrupted private stage")?;
                } else {
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    fn directory(&self, context: &Context, id: &str) -> Result<PathBuf, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid private stage ID")?;
        Ok(self.root.join(&context.namespace).join(id))
    }

    fn header(directory: &Path) -> Result<Header, String> {
        let file = File::open(directory.join("header.json"))
            .map_err(|_| "Private stage is unavailable")?;
        let mut bytes = Vec::new();
        file.take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| "Unable to read private stage state")?;
        if bytes.len() > 4096 {
            return Err("Private stage state exceeds its byte limit".into());
        }
        let header: Header =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid private stage state")?;
        if header.version != 1 || header.size > i64::MAX as u64 {
            return Err("Unsupported private stage state".into());
        }
        Ok(header)
    }

    fn save(directory: &Path, header: &Header) -> Result<(), String> {
        crate::native_storage::write_private_atomic(
            &directory.join("header.json"),
            &serde_json::to_vec(header).map_err(|_| "Invalid private stage state")?,
        )
        .map_err(|_| "Unable to commit private stage state".into())
    }

    fn create(&self, context: &Context, purpose: Purpose) -> Result<StageInfo, String> {
        context.current()?;
        if self.cleanup(Some(context))? >= MAX_STAGES {
            return Err("Too many private file stages. Resolve pending uploads first.".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        private_directory(&self.root.join(&context.namespace))?;
        let directory = self.directory(context, &id)?;
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        // Cleanup is allowed only after exclusive creation, never for an
        // existing stage whose UUID happens to collide.
        builder
            .create(&directory)
            .map_err(|_| "Unable to reserve private stage directory")?;
        let result = (|| {
            private_directory(&directory)?;
            private_file(&directory.join("data"))?
                .sync_all()
                .map_err(|_| "Unable to commit private stage data")?;
            Self::save(
                &directory,
                &Header {
                    version: 1,
                    generation: context.generation,
                    purpose,
                    size: 0,
                    committed: false,
                },
            )?;
            context.current()?;
            Ok(StageInfo {
                id: id.clone(),
                size: 0,
                committed: false,
            })
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(directory);
        }
        result
    }

    fn append(
        &self,
        context: &Context,
        id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<u64, String> {
        context.current()?;
        if bytes.len() > CHUNK_BYTES {
            return Err("Private stage write exceeds the chunk budget".into());
        }
        let directory = self.directory(context, id)?;
        let mut header = Self::header(&directory)?;
        if header.committed || header.size != offset || header.generation != context.generation {
            return Err("Private stage write offset or state changed".into());
        }
        let next = header
            .size
            .checked_add(bytes.len() as u64)
            .filter(|size| *size <= i64::MAX as u64)
            .ok_or("Private stage exceeds its size range")?;
        if bytes.is_empty() {
            return Ok(next);
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(directory.join("data"))
            .map_err(|_| "Unable to write private stage")?;
        if header.purpose == Purpose::Ciphertext {
            if file
                .metadata()
                .map_err(|_| "Unable to inspect private stage")?
                .len()
                != header.size
            {
                return Err("Private stage data differs from its committed prefix".into());
            }
            file.write_all(bytes)
                .map_err(|_| "Unable to write private ciphertext stage")?;
        } else {
            let encrypted = context
                .cipher
                .encrypt(bytes, &context.aad(id, offset))
                .map_err(|_| "Unable to encrypt private output stage")?;
            file.write_all(&(encrypted.len() as u32).to_be_bytes())
                .and_then(|_| file.write_all(&encrypted))
                .map_err(|_| "Unable to write encrypted private output")?;
        }
        file.sync_all()
            .map_err(|_| "Unable to commit private stage data")?;
        header.size = next;
        Self::save(&directory, &header)?;
        context.current()?;
        Ok(next)
    }

    fn info(&self, context: &Context, id: &str) -> Result<StageInfo, String> {
        context.current()?;
        let directory = self.directory(context, id)?;
        let header = Self::header(&directory)?;
        if header.purpose == Purpose::Ciphertext
            && std::fs::metadata(directory.join("data"))
                .map_err(|_| "Private stage data is unavailable")?
                .len()
                != header.size
        {
            return Err("Private ciphertext size changed".into());
        }
        Ok(StageInfo {
            id: id.into(),
            size: header.size,
            committed: header.committed,
        })
    }

    fn commit(&self, context: &Context, id: &str) -> Result<u64, String> {
        let info = self.info(context, id)?;
        let directory = self.directory(context, id)?;
        let mut header = Self::header(&directory)?;
        if header.generation != context.generation {
            return Err("Unfinished file staging belongs to a previous native session".into());
        }
        if header.committed {
            return Err("Private stage is already committed".into());
        }
        if header.purpose == Purpose::Plaintext {
            Self::copy_records(
                context,
                id,
                &header,
                File::open(directory.join("data")).map_err(|_| "Private output is unavailable")?,
                std::io::sink(),
            )?;
        }
        // Windows FlushFileBuffers requires a handle opened for writing.
        OpenOptions::new()
            .write(true)
            .open(directory.join("data"))
            .and_then(|file| file.sync_all())
            .map_err(|_| "Unable to commit private stage data")?;
        header.committed = true;
        Self::save(&directory, &header)?;
        context.current()?;
        Ok(info.size)
    }

    fn read(
        &self,
        context: &Context,
        id: &str,
        offset: u64,
        amount: u32,
    ) -> Result<Vec<u8>, String> {
        context.current()?;
        if amount as usize > CHUNK_BYTES {
            return Err("Private stage read exceeds the chunk budget".into());
        }
        let directory = self.directory(context, id)?;
        let header = Self::header(&directory)?;
        if !header.committed || header.purpose != Purpose::Ciphertext || offset > header.size {
            return Err("Private stage cannot be read in this state".into());
        }
        let mut file =
            File::open(directory.join("data")).map_err(|_| "Private stage data is unavailable")?;
        if file
            .metadata()
            .map_err(|_| "Unable to inspect private stage")?
            .len()
            != header.size
        {
            return Err("Private ciphertext size changed".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| "Unable to read private stage range")?;
        let mut bytes = vec![0; (header.size - offset).min(amount as u64) as usize];
        file.read_exact(&mut bytes)
            .map_err(|_| "Private stage range is unavailable")?;
        context.current()?;
        Ok(bytes)
    }

    fn remove(&self, context: &Context, id: &str) -> Result<(), String> {
        let directory = self.directory(context, id)?;
        match std::fs::remove_dir_all(directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Unable to remove private file stage".into()),
        }
    }

    fn copy_output(&self, context: &Context, id: &str, output: impl Write) -> Result<(), String> {
        context.current()?;
        let directory = self.directory(context, id)?;
        let header = Self::header(&directory)?;
        if header.generation != context.generation {
            return Err("File output belongs to a previous native session".into());
        }
        if !header.committed || header.purpose != Purpose::Plaintext {
            return Err("Output has not passed file verification".into());
        }
        let file =
            File::open(directory.join("data")).map_err(|_| "Private output is unavailable")?;
        Self::copy_records(context, id, &header, file, output)
    }

    fn copy_records(
        context: &Context,
        id: &str,
        header: &Header,
        mut file: File,
        mut output: impl Write,
    ) -> Result<(), String> {
        let mut offset = 0u64;
        while offset < header.size {
            context.current()?;
            let mut length = [0; 4];
            file.read_exact(&mut length)
                .map_err(|_| "Private output record is truncated")?;
            let length = u32::from_be_bytes(length) as usize;
            if length > CHUNK_BYTES + 64 {
                return Err("Private output record exceeds its byte limit".into());
            }
            let mut encrypted = vec![0; length];
            file.read_exact(&mut encrypted)
                .map_err(|_| "Private output record is truncated")?;
            let plaintext = Zeroizing::new(
                context
                    .cipher
                    .decrypt(&encrypted, &context.aad(id, offset))
                    .map_err(|_| "Private output authentication failed")?,
            );
            if plaintext.is_empty()
                || plaintext.len() > CHUNK_BYTES
                || plaintext.len() as u64 > header.size - offset
            {
                return Err("Private output length changed".into());
            }
            output
                .write_all(&plaintext)
                .map_err(|_| "Unable to write selected export destination")?;
            offset += plaintext.len() as u64;
        }
        let mut trailing = [0; 1];
        if file
            .read(&mut trailing)
            .map_err(|_| "Unable to verify private output length")?
            != 0
        {
            return Err("Private output has trailing records".into());
        }
        context.current()?;
        Ok(())
    }
}

async fn run<T: Send + 'static>(
    account_key: String,
    operation: impl FnOnce(&Store, &Context) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let context = Context::capture(&account_key)?;
    tokio::task::spawn_blocking(move || {
        let mut storage = STORE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "Private file storage is unavailable")?;
        context.current()?;
        if let Some(store) = storage.as_ref() {
            operation(store, &context)
        } else {
            let store = Store::open(crate::mtp_backend::sync_directory()?.join("file-stages"))?;
            context.current()?;
            let result = operation(&store, &context);
            *storage = Some(store);
            result
        }
    })
    .await
    .map_err(|_| "Private file storage task failed")?
}

#[tauri::command]
pub async fn file_stage_create(account_key: String, purpose: Purpose) -> Result<StageInfo, String> {
    run(account_key, move |store, context| {
        store.create(context, purpose)
    })
    .await
}
#[tauri::command]
pub async fn file_stage_append(
    account_key: String,
    id: String,
    offset: u64,
    bytes: Vec<u8>,
) -> Result<u64, String> {
    run(account_key, move |store, context| {
        store.append(context, &id, offset, &bytes)
    })
    .await
}
#[tauri::command]
pub async fn file_stage_commit(account_key: String, id: String) -> Result<u64, String> {
    run(account_key, move |store, context| {
        store.commit(context, &id)
    })
    .await
}
#[tauri::command]
pub async fn file_stage_info(account_key: String, id: String) -> Result<StageInfo, String> {
    run(account_key, move |store, context| store.info(context, &id)).await
}
#[tauri::command]
pub async fn file_stage_read(
    account_key: String,
    id: String,
    offset: u64,
    amount: u32,
) -> Result<Vec<u8>, String> {
    run(account_key, move |store, context| {
        store.read(context, &id, offset, amount)
    })
    .await
}
#[tauri::command]
pub async fn file_stage_remove(account_key: String, id: String) -> Result<(), String> {
    run(account_key, move |store, context| {
        store.remove(context, &id)
    })
    .await
}

#[tauri::command]
pub async fn file_stage_export(
    app: tauri::AppHandle,
    account_key: String,
    id: String,
    filename: String,
) -> Result<bool, String> {
    if filename.is_empty()
        || filename.len() > 255
        || filename
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
    {
        return Err("Invalid export filename".into());
    }
    let context = Context::capture(&account_key)?;
    let preflight_id = id.clone();
    run(account_key.clone(), move |store, context| {
        store.copy_output(context, &preflight_id, std::io::sink())
    })
    .await?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save verified file")
        .set_file_name(filename)
        .save_file(move |path| {
            let _ = send.send(path);
        });
    let Some(path) = receive
        .await
        .map_err(|_| "File destination selection failed")?
    else {
        return Ok(false);
    };
    context.current()?;
    run(account_key, move |store, current| {
        context.current()?;
        current.current()?;
        if let Ok(path) = path.clone().into_path() {
            store.export_path(current, &id, &path)?;
        } else {
            // Android document providers expose a user-selected URI rather than
            // a renameable local path. Open it only after staging authentication.
            store.copy_output(current, &id, std::io::sink())?;
            let mut options = tauri_plugin_fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            let mut output = app
                .fs()
                .open(path, options)
                .map_err(|_| "Unable to open selected export destination")?;
            store.copy_output(current, &id, &mut output)?;
            output
                .sync_all()
                .map_err(|_| "Unable to commit exported file")?;
        }
        store.remove(current, &id)?;
        Ok(true)
    })
    .await
}
