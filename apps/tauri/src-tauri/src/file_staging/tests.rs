use super::*;

fn fixture() -> (PathBuf, Context) {
    let root = std::env::temp_dir().join(format!("tensamin-file-stage-{}", uuid::Uuid::new_v4()));
    let context = Context {
        namespace: digest(b"fixture-account"),
        cipher: ChaCha20Poly1305::new([7; 32]),
        generation: crate::mtp_backend::manager().current_generation(),
    };
    (root, context)
}

#[test]
fn private_ciphertext_is_bounded_immutable_and_restart_recoverable() {
    let (root, context) = fixture();
    let store = Store::open(root.clone()).unwrap();
    let stage = store.create(&context, Purpose::Ciphertext).unwrap();
    assert!(store.read(&context, &stage.id, 0, 1).is_err());
    assert!(store
        .append(&context, &stage.id, 0, &vec![0; CHUNK_BYTES + 1])
        .is_err());
    store.append(&context, &stage.id, 0, b"ciphertext").unwrap();
    assert!(store
        .append(&context, &stage.id, 0, b"replacement")
        .is_err());
    store.commit(&context, &stage.id).unwrap();
    assert_eq!(store.read(&context, &stage.id, 1, 4).unwrap(), b"iphe");
    assert!(store.append(&context, &stage.id, 10, b"extra").is_err());
    assert!(store.directory(&context, "../escape").is_err());
    assert!(Store::open(root.clone()).is_err());
    drop(store);
    let store = Store::open(root.clone()).unwrap();
    assert!(store.info(&context, &stage.id).unwrap().committed);
    assert_eq!(
        store.read(&context, &stage.id, 0, 256).unwrap(),
        b"ciphertext"
    );
    store.remove(&context, &stage.id).unwrap();
    store.remove(&context, &stage.id).unwrap();
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn plaintext_is_encrypted_at_rest_and_only_verified_committed_output_can_be_exported() {
    let (root, context) = fixture();
    let store = Store::open(root.clone()).unwrap();
    let stage = store.create(&context, Purpose::Plaintext).unwrap();
    let secret = b"private-profile-file";
    store.append(&context, &stage.id, 0, secret).unwrap();
    let data = store.directory(&context, &stage.id).unwrap().join("data");
    assert!(!std::fs::read(&data)
        .unwrap()
        .windows(secret.len())
        .any(|window| window == secret));
    assert!(store
        .copy_output(&context, &stage.id, std::io::sink())
        .is_err());
    store.commit(&context, &stage.id).unwrap();
    assert!(store.read(&context, &stage.id, 0, 256).is_err());
    let mut plaintext = Vec::new();
    store
        .copy_output(&context, &stage.id, &mut plaintext)
        .unwrap();
    assert_eq!(plaintext, secret);
    let destination = root.join("selected-file");
    std::fs::write(&destination, b"previous document").unwrap();
    let mut corrupt = std::fs::read(&data).unwrap();
    corrupt[8] ^= 1;
    std::fs::write(&data, corrupt).unwrap();
    assert!(store
        .export_path(&context, &stage.id, &destination)
        .is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"previous document");
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_output_is_collected_without_removing_completed_upload_ciphertext() {
    let (root, context) = fixture();
    let store = Store::open(root.clone()).unwrap();
    let upload = store.create(&context, Purpose::Ciphertext).unwrap();
    store
        .append(&context, &upload.id, 0, b"ciphertext")
        .unwrap();
    store.commit(&context, &upload.id).unwrap();
    let interrupted = store.create(&context, Purpose::Ciphertext).unwrap();
    let output = store.create(&context, Purpose::Plaintext).unwrap();
    store
        .append(&context, &output.id, 0, b"private output")
        .unwrap();
    store.commit(&context, &output.id).unwrap();
    drop(store);
    let store = Store::open(root.clone()).unwrap();
    assert!(store.info(&context, &upload.id).unwrap().committed);
    assert!(store.info(&context, &interrupted.id).is_err());
    assert!(store.info(&context, &output.id).is_err());
    let other = Context {
        namespace: digest(b"other-account"),
        cipher: ChaCha20Poly1305::new([7; 32]),
        generation: context.generation,
    };
    assert!(store.info(&other, &upload.id).is_err());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_output_replaces_the_selected_path_only_after_a_complete_verified_copy() {
    let (root, context) = fixture();
    let store = Store::open(root.clone()).unwrap();
    let output = store.create(&context, Purpose::Plaintext).unwrap();
    store.append(&context, &output.id, 0, b"verified ").unwrap();
    store.append(&context, &output.id, 9, b"contents").unwrap();
    store.commit(&context, &output.id).unwrap();
    let destination = root.join("selected-file");
    std::fs::write(&destination, b"previous document").unwrap();
    store
        .export_path(&context, &output.id, &destination)
        .unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"verified contents");
    let empty = store.create(&context, Purpose::Plaintext).unwrap();
    store.append(&context, &empty.id, 0, b"").unwrap();
    store.commit(&context, &empty.id).unwrap();
    store
        .export_path(&context, &empty.id, &destination)
        .unwrap();
    assert!(std::fs::read(&destination).unwrap().is_empty());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&destination)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(
                store
                    .directory(&context, &output.id)
                    .unwrap()
                    .join("header.json")
            )
            .unwrap()
            .permissions()
            .mode()
                & 0o777,
            0o600
        );
    }
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn corrupted_staging_never_commits_over_an_incomplete_prefix() {
    let (root, context) = fixture();
    let store = Store::open(root.clone()).unwrap();
    let upload = store.create(&context, Purpose::Ciphertext).unwrap();
    store
        .append(&context, &upload.id, 0, b"ciphertext")
        .unwrap();
    OpenOptions::new()
        .append(true)
        .open(store.directory(&context, &upload.id).unwrap().join("data"))
        .unwrap()
        .write_all(b"uncommitted tail")
        .unwrap();
    assert!(store.commit(&context, &upload.id).is_err());
    let output = store.create(&context, Purpose::Plaintext).unwrap();
    store
        .append(&context, &output.id, 0, b"private output")
        .unwrap();
    OpenOptions::new()
        .append(true)
        .open(store.directory(&context, &output.id).unwrap().join("data"))
        .unwrap()
        .write_all(b"trailing record")
        .unwrap();
    assert!(store.commit(&context, &output.id).is_err());
    assert!(!store.info(&context, &output.id).unwrap().committed);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_staging_rejects_unauthenticated_calls_before_any_filesystem_access() {
    assert!(file_stage_create("untrusted".into(), Purpose::Ciphertext)
        .await
        .is_err());
    assert!(
        file_stage_read("untrusted".into(), uuid::Uuid::new_v4().to_string(), 0, 1)
            .await
            .is_err()
    );
}

#[test]
fn obsolete_session_output_is_reclaimed_without_discarding_resumable_ciphertext() {
    let (root, context) = fixture();
    let store = Store::open(root.clone()).unwrap();
    let upload = store.create(&context, Purpose::Ciphertext).unwrap();
    store
        .append(&context, &upload.id, 0, b"ciphertext")
        .unwrap();
    store.commit(&context, &upload.id).unwrap();
    let output = store.create(&context, Purpose::Plaintext).unwrap();
    store
        .append(&context, &output.id, 0, b"private output")
        .unwrap();
    store.commit(&context, &output.id).unwrap();
    let writing = store.create(&context, Purpose::Ciphertext).unwrap();
    for id in [&upload.id, &output.id, &writing.id] {
        let path = store.directory(&context, id).unwrap();
        let mut header = Store::header(&path).unwrap();
        header.generation = header.generation.wrapping_add(1);
        Store::save(&path, &header).unwrap();
    }
    assert!(store
        .copy_output(&context, &output.id, std::io::sink())
        .is_err());
    assert!(store
        .append(&context, &writing.id, 0, b"stale append")
        .is_err());
    assert!(store.commit(&context, &writing.id).is_err());
    assert_eq!(
        store.read(&context, &upload.id, 0, 256).unwrap(),
        b"ciphertext"
    );
    let next = store.create(&context, Purpose::Ciphertext).unwrap();
    assert!(store.info(&context, &output.id).is_err());
    assert!(store.info(&context, &writing.id).is_err());
    assert!(store.info(&context, &upload.id).unwrap().committed);
    assert!(store.info(&context, &next.id).is_ok());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
