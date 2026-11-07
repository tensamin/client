use super::*;
use crate::mtp_files::{Checkpoint, FileEvent};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored<T> {
    version: u8,
    scope: Scope,
    resource: String,
    value: T,
}

impl AccountSyncJournal {
    pub(super) fn file_name(scope: &Scope, resource: &str) -> Result<String, String> {
        let scope_hash = sha256(&serde_json::to_vec(scope).map_err(error)?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let resource_hash = sha256(resource.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(format!("file-journal:v1:{scope_hash}:{resource_hash}"))
    }

    fn read_file<T: serde::de::DeserializeOwned>(
        &self,
        scope: &Scope,
        resource: &str,
    ) -> Result<Option<T>, String> {
        let name = Self::file_name(scope, resource)?;
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
            return Err("File journal record exceeds capacity".into());
        }
        let plaintext = Zeroizing::new(
            self.cache
                .cipher
                .decrypt(&stored, &self.header_aad(&name)?)
                .map_err(error)?,
        );
        let decoded: Stored<T> = serde_json::from_slice(&plaintext)
            .map_err(|_| "Invalid encrypted file journal record")?;
        if decoded.version != 1 || &decoded.scope != scope || decoded.resource != resource {
            return Err("File journal record binding changed".into());
        }
        Ok(Some(decoded.value))
    }

    fn encrypted_file<T: Serialize>(
        &self,
        scope: &Scope,
        resource: &str,
        value: T,
    ) -> Result<(String, Vec<u8>), String> {
        let name = Self::file_name(scope, resource)?;
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&Stored {
                version: 1,
                scope: scope.clone(),
                resource: resource.into(),
                value,
            })
            .map_err(error)?,
        );
        if plaintext.len() > MAX_RECORD_BYTES - 64 {
            return Err("File journal record exceeds capacity".into());
        }
        let value = self
            .cache
            .cipher
            .encrypt(&plaintext, &self.header_aad(&name)?)
            .map_err(error)?;
        Ok((name, value))
    }

    pub fn file_checkpoint(&self, scope: &Scope) -> Result<Checkpoint, String> {
        if !scope.validate()
            || scope.principal.user_id != self.cache.user_id
            || scope.device_id != self.cache.device_id
        {
            return Err("File journal scope differs from this credential".into());
        }
        let checkpoint: Checkpoint = self.read_file(scope, "cursor")?.unwrap_or_default();
        if checkpoint.after < 0
            || checkpoint
                .upper
                .is_some_and(|upper| upper < checkpoint.after)
        {
            return Err("Invalid durable file journal checkpoint".into());
        }
        Ok(checkpoint)
    }

    pub fn file_event(&self, scope: &Scope, resource: &str) -> Result<Option<FileEvent>, String> {
        let event: Option<FileEvent> = self.read_file(scope, resource)?;
        if let Some(event) = &event {
            if event.resource(&scope.principal)? != resource {
                return Err("File journal event identity changed".into());
            }
        }
        Ok(event)
    }

    pub fn commit_file_page(
        &mut self,
        scope: &Scope,
        previous: &Checkpoint,
        next: &Checkpoint,
        events: &[FileEvent],
    ) -> Result<(), String> {
        if events.len() > tau_relay_protocol::files::PAGE_SIZE
            || serde_json::to_vec(events).map_err(error)?.len()
                > tau_relay_protocol::files::MAX_CONTROL_BYTES
        {
            return Err("File journal page exceeds its control budget".into());
        }
        let transaction = self.connection.unchecked_transaction().map_err(error)?;
        if self.file_checkpoint(scope)? != *previous
            || next.after < previous.after
            || next.upper.is_some_and(|upper| upper < next.after)
            || previous.upper.is_some_and(|upper| {
                next.upper.is_some_and(|next| next != upper) || next.after > upper
            })
        {
            return Err("File journal checkpoint changed during page preparation".into());
        }
        let mut last = previous.after;
        for event in events {
            if event.sequence <= last || event.sequence > next.after {
                return Err("File journal page is out of order".into());
            }
            last = event.sequence;
            let resource = event.resource(&scope.principal)?;
            if let (Some(grant), Some(old)) = (event.grant()?, self.file_event(scope, &resource)?) {
                let old_grant = old.grant()?.ok_or("Invalid committed file grant")?;
                if old_grant.revision() > grant.revision() {
                    continue;
                }
                if old_grant.revision() == grant.revision()
                    && (old.kind != event.kind || old.payload != event.payload)
                {
                    return Err("File grant revision contains conflicting signed operations".into());
                }
            }
            let (name, value) = self.encrypted_file(scope, &resource, event)?;
            transaction
                .execute(
                    "INSERT OR REPLACE INTO metadata VALUES(?1,?2)",
                    params![name, value],
                )
                .map_err(error)?;
        }
        let (name, value) = self.encrypted_file(scope, "cursor", next)?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO metadata VALUES(?1,?2)",
                params![name, value],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)
    }
}
