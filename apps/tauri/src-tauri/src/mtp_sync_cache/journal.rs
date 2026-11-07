use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use tau_relay_protocol::sync::{Event, EventAction};
mod files;

const MAX_RECORD_BYTES: usize = 256 * 1024;
const MESSAGE_PREVIEW_LIMIT: usize = 30;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    scope: Scope,
    generation: String,
    head: i64,
}

pub(crate) struct AccountSyncJournal {
    cache: AccountSyncCache,
    connection: Connection,
    active: Option<Header>,
    staging: Option<Header>,
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

impl AccountSyncJournal {
    pub fn new(directory: PathBuf, config: &MtpConfig, device: String) -> Result<Self, String> {
        let cache = AccountSyncCache::new(directory, config, device)?;
        let path = cache.path.with_extension("sqlite3");
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path).map_err(error)?;
        let connection = Connection::open(&path).map_err(error)?;
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(error)?;
        if version != 0 && version != 1 {
            return Err("Unsupported account journal schema".into());
        }
        if version == 0 {
            let existing:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')",[],|row|row.get(0)).map_err(error)?;
            if existing {
                return Err("Unrecognized account journal schema".into());
            }
            connection.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE metadata(name TEXT PRIMARY KEY,value BLOB NOT NULL);
                CREATE TABLE records(generation TEXT NOT NULL,entity TEXT NOT NULL,id TEXT NOT NULL,value BLOB NOT NULL,
                    PRIMARY KEY(generation,entity,id));
                PRAGMA user_version=1; COMMIT;").map_err(error)?;
        }
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
            .map_err(error)?;
        let mut journal = Self {
            cache,
            connection,
            active: None,
            staging: None,
        };
        journal.active = journal.read_header("active")?;
        journal.staging = journal.read_header("staging")?;
        Ok(journal)
    }

    fn header_aad(&self, name: &str) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&(
            "tensamin-account-journal-header:v1",
            &self.cache.binding,
            name,
        ))
        .map_err(error)
    }

    fn record_aad(&self, header: &Header, entity: &str, id: &str) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&(
            "tensamin-account-journal-record:v1",
            &self.cache.binding,
            &header.scope,
            &header.generation,
            entity,
            id,
        ))
        .map_err(error)
    }

    fn read_header(&self, name: &str) -> Result<Option<Header>, String> {
        let stored: Option<Vec<u8>> = self
            .connection
            .query_row(
                "SELECT substr(value,1,?2) FROM metadata WHERE name=?1",
                params![name, MAX_RECORD_BYTES as i64 + 1],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        let Some(stored) = stored else {
            return Ok(None);
        };
        if stored.len() > MAX_RECORD_BYTES {
            return Err("Account journal header is too large".into());
        }
        let plaintext = Zeroizing::new(
            self.cache
                .cipher
                .decrypt(&stored, &self.header_aad(name)?)
                .map_err(error)?,
        );
        let header: Header = serde_json::from_slice(&plaintext).map_err(error)?;
        if !header.scope.validate()
            || header.head < 0
            || header.scope.principal.user_id != self.cache.user_id
            || header.scope.device_id != self.cache.device_id
            || uuid::Uuid::parse_str(&header.generation).is_err()
        {
            return Err("Account journal does not match this credential".into());
        }
        Ok(Some(header))
    }

    fn encrypted_header(&self, header: &Header, name: &str) -> Result<Vec<u8>, String> {
        let plaintext = Zeroizing::new(serde_json::to_vec(header).map_err(error)?);
        self.cache
            .cipher
            .encrypt(&plaintext, &self.header_aad(name)?)
            .map_err(error)
    }

    pub fn head(&self, scope: &Scope) -> Option<i64> {
        self.active
            .as_ref()
            .filter(|header| &header.scope == scope)
            .map(|header| header.head)
    }

    pub fn verify_principal(
        &mut self,
        principal: &tau_relay_protocol::Principal,
        proof: &str,
        home_public_key: &str,
        now: i64,
    ) -> Result<Vec<mtp::crypto::PublicKeyBundle>, String> {
        let name = format!(
            "principal-revision:{}",
            serde_json::to_string(principal).map_err(error)?
        );
        let aad = serde_json::to_vec(&(
            "tensamin-native-principal-revision:v1",
            &self.cache.binding,
            &name,
        ))
        .map_err(error)?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        let stored: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT substr(value,1,?2) FROM metadata WHERE name=?1",
                params![name, MAX_RECORD_BYTES as i64 + 1],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        let minimum_revision = if let Some(stored) = stored {
            if stored.len() > MAX_RECORD_BYTES {
                return Err("Principal revision record exceeds capacity".into());
            }
            let plaintext =
                Zeroizing::new(self.cache.cipher.decrypt(&stored, &aad).map_err(error)?);
            let (version, owner, revision): (u8, tau_relay_protocol::Principal, i64) =
                serde_json::from_slice(&plaintext).map_err(error)?;
            if version != 1 || &owner != principal || revision < 1 {
                return Err("Unsupported or mismatched principal revision record".into());
            }
            Some(revision)
        } else {
            None
        };
        let (revision, keys) = crate::mtp_principal_proof::verify(
            proof,
            principal,
            home_public_key,
            minimum_revision,
            now,
        )?;
        let plaintext =
            Zeroizing::new(serde_json::to_vec(&(1u8, principal, revision)).map_err(error)?);
        let encrypted = self.cache.cipher.encrypt(&plaintext, &aad).map_err(error)?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO metadata VALUES(?1,?2)",
                params![name, encrypted],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)?;
        Ok(keys)
    }

    pub fn begin(&mut self, scope: Scope) -> Result<(), String> {
        if !scope.validate()
            || scope.principal.user_id != self.cache.user_id
            || scope.device_id != self.cache.device_id
        {
            return Err("Account journal scope changed".into());
        }
        if let Some(previous) = &self.staging {
            if self
                .active
                .as_ref()
                .is_some_and(|active| active.generation == previous.generation)
            {
                return Err("Account journal staging conflicts with its active generation".into());
            }
        }
        let header = Header {
            scope,
            generation: uuid::Uuid::new_v4().to_string(),
            head: 0,
        };
        let encrypted = self.encrypted_header(&header, "staging")?;
        let transaction = self.connection.transaction().map_err(error)?;
        if let Some(previous) = &self.staging {
            transaction
                .execute(
                    "DELETE FROM records WHERE generation=?1",
                    [&previous.generation],
                )
                .map_err(error)?;
        }
        transaction
            .execute(
                "INSERT OR REPLACE INTO metadata VALUES('staging',?1)",
                [encrypted],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)?;
        self.staging = Some(header);
        Ok(())
    }

    fn record_id(record: &Record) -> Result<(String, String), String> {
        let entity = serde_json::to_string(&record.entity).map_err(error)?;
        let id = sha256(&serde_json::to_vec(&(&record.entity, &record.key)).map_err(error)?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok((entity, id))
    }

    fn encrypt_record(
        &self,
        header: &Header,
        record: &Record,
    ) -> Result<(String, String, Vec<u8>), String> {
        let (entity, id) = Self::record_id(record)?;
        let plaintext = Zeroizing::new(serde_json::to_vec(record).map_err(error)?);
        if plaintext.len() > MAX_RECORD_BYTES {
            return Err("Account journal record is too large".into());
        }
        let encrypted = self
            .cache
            .cipher
            .encrypt(&plaintext, &self.record_aad(header, &entity, &id)?)
            .map_err(error)?;
        Ok((entity, id, encrypted))
    }

    pub fn append(&mut self, records: &[Record]) -> Result<(), String> {
        if records.len() > 128
            || serde_json::to_vec(records).map_err(error)?.len()
                > tau_relay_protocol::sync::PAGE_BYTES
        {
            return Err("Account journal page is too large".into());
        }
        let header = self
            .staging
            .as_ref()
            .ok_or("No account snapshot is staged")?;
        let encrypted = records
            .iter()
            .map(|record| self.encrypt_record(header, record))
            .collect::<Result<Vec<_>, _>>()?;
        let transaction = self.connection.transaction().map_err(error)?;
        for (entity, id, value) in encrypted {
            transaction
                .execute(
                    "INSERT INTO records VALUES(?1,?2,?3,?4)",
                    params![header.generation, entity, id, value],
                )
                .map_err(error)?;
        }
        transaction.commit().map_err(error)
    }

    pub fn apply(&mut self, scope: &Scope, events: &[Event], head: i64) -> Result<(), String> {
        if events.len() > 128
            || serde_json::to_vec(events).map_err(error)?.len()
                > tau_relay_protocol::sync::PAGE_BYTES
        {
            return Err("Account journal delta is too large".into());
        }
        let active = self
            .active
            .as_ref()
            .filter(|header| &header.scope == scope)
            .ok_or("No matching account journal")?;
        let mut sequence = active.head;
        let mut changes = Vec::new();
        for event in events {
            if sequence.checked_add(1) != Some(event.sequence)
                || event.sequence > head
                || event.event_id
                    != format!(
                        "{}:{}:{}",
                        scope.principal.authority, scope.principal.user_id, event.sequence
                    )
            {
                return Err("Account delta is not contiguous".into());
            }
            let record = match (&event.operation, &event.record) {
                (EventAction::Upsert, Some(record))
                    if record.entity == event.entity && record.key == event.key =>
                {
                    Some(record)
                }
                (EventAction::Delete, None) => None,
                _ => return Err("Account delta record changed".into()),
            };
            let placeholder = Record {
                entity: event.entity,
                key: event.key.clone(),
                value: serde_json::Value::Null,
            };
            let (entity, id) = Self::record_id(&placeholder)?;
            changes.push((
                entity,
                id,
                record
                    .map(|record| {
                        self.encrypt_record(active, record)
                            .map(|(_, _, value)| value)
                    })
                    .transpose()?,
            ));
            sequence = event.sequence;
        }
        let header = Header {
            scope: scope.clone(),
            generation: active.generation.clone(),
            head: sequence,
        };
        let metadata = self.encrypted_header(&header, "active")?;
        let transaction = self.connection.transaction().map_err(error)?;
        for (entity, id, value) in changes {
            if let Some(value) = value {
                transaction
                    .execute(
                        "INSERT OR REPLACE INTO records VALUES(?1,?2,?3,?4)",
                        params![header.generation, entity, id, value],
                    )
                    .map_err(error)?;
            } else {
                transaction
                    .execute(
                        "DELETE FROM records WHERE generation=?1 AND entity=?2 AND id=?3",
                        params![header.generation, entity, id],
                    )
                    .map_err(error)?;
            }
        }
        transaction
            .execute(
                "INSERT OR REPLACE INTO metadata VALUES('active',?1)",
                [metadata],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)?;
        self.active = Some(header);
        Ok(())
    }

    pub fn commit(&mut self, scope: &Scope, head: i64, snapshot: bool) -> Result<(), String> {
        let current = if snapshot {
            self.staging.as_ref()
        } else {
            self.active.as_ref()
        };
        let current = current
            .filter(|header| &header.scope == scope)
            .ok_or("No matching account journal")?;
        if head < current.head {
            return Err("Account journal checkpoint moved backwards".into());
        }
        let header = Header {
            scope: scope.clone(),
            generation: current.generation.clone(),
            head,
        };
        let metadata = self.encrypted_header(&header, "active")?;
        let transaction = self.connection.transaction().map_err(error)?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO metadata VALUES('active',?1)",
                [metadata],
            )
            .map_err(error)?;
        transaction
            .execute("DELETE FROM metadata WHERE name='staging'", [])
            .map_err(error)?;
        transaction
            .execute(
                "DELETE FROM records WHERE generation<>?1",
                [&header.generation],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)?;
        self.active = Some(header);
        self.staging = None;
        Ok(())
    }

    pub fn projection(&self) -> Result<Option<Snapshot>, String> {
        // Read the checkpoint and its records at one boundary, including when
        // offline restoration races a page commit on another connection.
        let _transaction = self.connection.unchecked_transaction().map_err(error)?;
        let Some(header) = self.read_header("active")? else {
            return Ok(None);
        };
        let mut records = Vec::new();
        let mut messages: Vec<(i64, Record)> = Vec::new();
        let mut statement=self.connection.prepare("SELECT entity,id,CASE WHEN length(value)<=?2 THEN value ELSE NULL END FROM records WHERE generation=?1 ORDER BY entity,id").map_err(error)?;
        let mut rows = statement
            .query(params![header.generation, MAX_RECORD_BYTES as i64 + 64])
            .map_err(error)?;
        while let Some(row) = rows.next().map_err(error)? {
            let entity: String = row.get(0).map_err(error)?;
            let id: String = row.get(1).map_err(error)?;
            let encrypted: Option<Vec<u8>> = row.get(2).map_err(error)?;
            let encrypted = encrypted.ok_or("Account journal record exceeds capacity")?;
            let plaintext = Zeroizing::new(
                self.cache
                    .cipher
                    .decrypt(&encrypted, &self.record_aad(&header, &entity, &id)?)
                    .map_err(error)?,
            );
            let record: Record = serde_json::from_slice(&plaintext).map_err(error)?;
            if Self::record_id(&record)? != (entity, id) {
                return Err("Account journal record binding changed".into());
            }
            if record.entity == tau_relay_protocol::sync::Entity::Message {
                if record.value["history_deleted"] == "1"
                    || record.value["deleted_by_external"] == "1"
                {
                    continue;
                }
                let time = record.value["message_time"]
                    .as_str()
                    .and_then(|value| value.parse::<i64>().ok())
                    .ok_or("Invalid message preview time")?;
                messages.push((time, record));
                messages.sort_by_key(|(time, _)| std::cmp::Reverse(*time));
                if messages.len() > MESSAGE_PREVIEW_LIMIT {
                    messages.pop();
                }
            } else {
                records.push(record)
            }
        }
        records.extend(messages.into_iter().map(|(_, record)| record));
        Ok(Some(Snapshot {
            scope: header.scope.clone(),
            head: header.head,
            records,
        }))
    }
}
