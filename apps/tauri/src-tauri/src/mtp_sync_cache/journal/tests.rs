use super::*;
use tau_relay_protocol::sync::Entity;

fn fixture() -> (PathBuf, MtpConfig, Snapshot) {
    super::super::tests::fixture()
}

fn open(directory: &std::path::Path, config: &MtpConfig) -> AccountSyncJournal {
    AccountSyncJournal::new(directory.into(), config, "device-one".into()).unwrap()
}

fn event(scope: &Scope, sequence: i64, record: Record) -> Event {
    Event {
        sequence,
        event_id: format!(
            "{}:{}:{sequence}",
            scope.principal.authority, scope.principal.user_id
        ),
        entity: record.entity,
        key: record.key.clone(),
        operation: EventAction::Upsert,
        record: Some(record),
    }
}

#[test]
fn staged_pages_stay_invisible_across_restart_until_activation() {
    let (directory, config, snapshot) = fixture();
    let mut journal = open(&directory, &config);
    journal.begin(snapshot.scope.clone()).unwrap();
    journal.append(&snapshot.records).unwrap();
    assert!(journal.projection().unwrap().is_none());
    drop(journal);
    let mut journal = open(&directory, &config);
    assert!(journal.projection().unwrap().is_none());
    journal.commit(&snapshot.scope, 17, true).unwrap();
    journal.begin(snapshot.scope.clone()).unwrap();
    let mut replacement = snapshot.records.clone();
    replacement[0].key = "replacement".into();
    journal.append(&replacement).unwrap();
    drop(journal);
    let mut journal = open(&directory, &config);
    assert_eq!(journal.projection().unwrap().unwrap().records[0].key, "1");
    // A resumed delta must never activate the abandoned snapshot generation.
    journal.commit(&snapshot.scope, 17, false).unwrap();
    assert_eq!(journal.projection().unwrap().unwrap().records[0].key, "1");
    journal.begin(snapshot.scope.clone()).unwrap();
    journal.append(&replacement).unwrap();
    journal.commit(&snapshot.scope, 19, true).unwrap();
    drop(journal);
    let journal = open(&directory, &config);
    assert_eq!(journal.head(&snapshot.scope), Some(19));
    assert_eq!(
        journal.projection().unwrap().unwrap().records[0].key,
        "replacement"
    );
    drop(journal);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn failed_page_and_delta_transactions_leave_records_and_checkpoint_unchanged() {
    let (directory, config, snapshot) = fixture();
    let mut journal = open(&directory, &config);
    journal.begin(snapshot.scope.clone()).unwrap();
    assert!(journal
        .append(&[snapshot.records[0].clone(), snapshot.records[0].clone()])
        .is_err());
    let count: i64 = journal
        .connection
        .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    journal.append(&snapshot.records).unwrap();
    journal.commit(&snapshot.scope, 17, true).unwrap();
    let reader = open(&directory, &config);
    journal.connection.execute_batch("CREATE TRIGGER refuse_checkpoint BEFORE INSERT ON metadata BEGIN SELECT RAISE(ABORT,'checkpoint refused'); END;").unwrap();
    let mut replacement = snapshot.records[0].clone();
    replacement.value = serde_json::json!({"name":"replacement"});
    let change = event(&snapshot.scope, 18, replacement);
    assert!(journal
        .apply(&snapshot.scope, std::slice::from_ref(&change), 18)
        .is_err());
    assert_eq!(journal.head(&snapshot.scope), Some(17));
    assert_eq!(
        journal.projection().unwrap().unwrap().records[0].value,
        snapshot.records[0].value
    );
    journal
        .connection
        .execute_batch("DROP TRIGGER refuse_checkpoint")
        .unwrap();
    journal.apply(&snapshot.scope, &[change], 18).unwrap();
    let concurrent = reader.projection().unwrap().unwrap();
    assert_eq!(concurrent.head, 18);
    assert_eq!(concurrent.records[0].value["name"], "replacement");
    drop(reader);
    drop(journal);
    let journal = open(&directory, &config);
    assert_eq!(journal.head(&snapshot.scope), Some(18));
    assert_eq!(
        journal.projection().unwrap().unwrap().records[0].value["name"],
        "replacement"
    );
    drop(journal);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn record_ciphertext_is_bound_to_its_identity_and_header_role() {
    let (directory, config, snapshot) = fixture();
    let mut journal = open(&directory, &config);
    journal.begin(snapshot.scope.clone()).unwrap();
    journal.append(&snapshot.records).unwrap();
    journal.commit(&snapshot.scope, 17, true).unwrap();
    journal
        .connection
        .execute("UPDATE records SET id='transplanted'", [])
        .unwrap();
    assert!(journal.projection().is_err());
    journal
        .connection
        .execute(
            "INSERT INTO metadata SELECT 'staging',value FROM metadata WHERE name='active'",
            [],
        )
        .unwrap();
    drop(journal);
    assert!(AccountSyncJournal::new(directory.clone(), &config, "device-one".into()).is_err());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn future_schema_and_corrupt_database_are_not_replaced() {
    let (directory, config, _) = fixture();
    let journal = open(&directory, &config);
    let path = journal.cache.path.with_extension("sqlite3");
    journal
        .connection
        .execute_batch("PRAGMA user_version=2")
        .unwrap();
    drop(journal);
    let before = std::fs::read(&path).unwrap();
    assert!(AccountSyncJournal::new(directory.clone(), &config, "device-one".into()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::write(&path, b"corrupt journal").unwrap();
    assert!(AccountSyncJournal::new(directory.clone(), &config, "device-one".into()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"corrupt journal");
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn large_history_is_durable_while_only_thirty_messages_are_projected() {
    let (directory, config, snapshot) = fixture();
    let mut journal = open(&directory, &config);
    journal.begin(snapshot.scope.clone()).unwrap();
    let mut batch = Vec::new();
    for id in 1..=100_001 {
        batch.push(Record {
            entity: Entity::Message,
            key: id.to_string(),
            value: serde_json::json!({
                "message_time": id.to_string(), "content": "x".repeat(512)
            }),
        });
        if batch.len() == 128 {
            journal.append(&batch).unwrap();
            batch.clear();
        }
    }
    journal.append(&batch).unwrap();
    journal.commit(&snapshot.scope, 100_001, true).unwrap();
    drop(journal);
    let journal = open(&directory, &config);
    let count: i64 = journal
        .connection
        .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 100_001);
    let projection = journal.projection().unwrap().unwrap();
    assert_eq!(projection.records.len(), MESSAGE_PREVIEW_LIMIT);
    assert_eq!(projection.records[0].key, "100001");
    assert_eq!(projection.records[29].key, "99972");
    drop(journal);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn verified_principal_revision_and_active_keys_survive_restart_without_rollback() {
    use crate::mtp_principal_proof::tests::signed_proof;
    use mtp::crypto::Keyring;
    let (directory, config, _) = fixture();
    let authority = Keyring::generate();
    let home = Keyring::generate();
    let old = Keyring::generate();
    let active = Keyring::generate();
    let (principal, first, home_key) = signed_proof(1, &authority, &home, &old);
    let (_, second, _) = signed_proof(2, &authority, &home, &active);
    let mut journal = open(&directory, &config);
    journal
        .verify_principal(&principal, &first, &home_key, 200)
        .unwrap();
    let keys = journal
        .verify_principal(&principal, &second, &home_key, 200)
        .unwrap();
    assert_eq!(
        keys[0].try_as_bytes().unwrap(),
        active.public_key_bundle().try_as_bytes().unwrap()
    );
    drop(journal);
    let mut journal = open(&directory, &config);
    assert!(journal
        .verify_principal(&principal, &first, &home_key, 200)
        .is_err());
    journal
        .verify_principal(&principal, &second, &home_key, 200)
        .unwrap();
    drop(journal);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn failed_revision_commit_does_not_return_keys_or_advance_the_floor() {
    use crate::mtp_principal_proof::tests::signed_proof;
    use mtp::crypto::Keyring;
    let (directory, config, _) = fixture();
    let authority = Keyring::generate();
    let home = Keyring::generate();
    let user = Keyring::generate();
    let (principal, first, home_key) = signed_proof(1, &authority, &home, &user);
    let (_, second, _) = signed_proof(2, &authority, &home, &user);
    let mut journal = open(&directory, &config);
    journal
        .verify_principal(&principal, &first, &home_key, 200)
        .unwrap();
    let before: Vec<u8> = journal
        .connection
        .query_row(
            "SELECT value FROM metadata WHERE name LIKE 'principal-revision:%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    journal.connection.execute_batch("CREATE TRIGGER refuse_revision BEFORE INSERT ON metadata WHEN NEW.name LIKE 'principal-revision:%' BEGIN SELECT RAISE(ABORT,'pin commit refused'); END;").unwrap();
    assert!(journal
        .verify_principal(&principal, &second, &home_key, 200)
        .is_err());
    let after: Vec<u8> = journal
        .connection
        .query_row(
            "SELECT value FROM metadata WHERE name LIKE 'principal-revision:%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, before);
    journal
        .connection
        .execute_batch("DROP TRIGGER refuse_revision")
        .unwrap();
    journal
        .verify_principal(&principal, &first, &home_key, 200)
        .unwrap();
    journal
        .verify_principal(&principal, &second, &home_key, 200)
        .unwrap();
    drop(journal);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn principal_pin_ciphertext_cannot_be_transplanted_between_equal_numeric_ids() {
    use crate::mtp_principal_proof::tests::signed_proof;
    use mtp::crypto::Keyring;
    let (directory, config, _) = fixture();
    let first_authority = Keyring::generate();
    let second_authority = Keyring::generate();
    let home = Keyring::generate();
    let user = Keyring::generate();
    let (first, first_proof, home_key) = signed_proof(3, &first_authority, &home, &user);
    let (second, second_proof, _) = signed_proof(1, &second_authority, &home, &user);
    assert_eq!(first.user_id, second.user_id);
    assert_ne!(first.authority, second.authority);
    let mut journal = open(&directory, &config);
    journal
        .verify_principal(&first, &first_proof, &home_key, 200)
        .unwrap();
    journal
        .verify_principal(&second, &second_proof, &home_key, 200)
        .unwrap();
    let first_name = format!(
        "principal-revision:{}",
        serde_json::to_string(&first).unwrap()
    );
    let second_name = format!(
        "principal-revision:{}",
        serde_json::to_string(&second).unwrap()
    );
    journal
        .connection
        .execute(
            "UPDATE metadata SET value=(SELECT value FROM metadata WHERE name=?2) WHERE name=?1",
            params![first_name, second_name],
        )
        .unwrap();
    assert!(journal
        .verify_principal(&first, &first_proof, &home_key, 200)
        .is_err());
    journal
        .verify_principal(&second, &second_proof, &home_key, 200)
        .unwrap();
    drop(journal);
    std::fs::remove_dir_all(directory).unwrap();
}
