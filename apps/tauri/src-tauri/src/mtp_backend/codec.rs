use super::*;

pub(crate) fn decode_browser_base64(value: &str) -> Result<Vec<u8>, String> {
    let normalized: String = value
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect();
    if normalized.is_empty() {
        return Err("value is empty".into());
    }
    STANDARD
        .decode(&normalized)
        .or_else(|_| STANDARD_NO_PAD.decode(&normalized))
        .map_err(|_| "invalid base64 encoding".into())
}

pub(super) fn decode_sdk_bytes(value: &str) -> Result<Vec<u8>, String> {
    let trimmed = value.trim();
    let hex: String = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed)
        .chars()
        .filter(|character| !matches!(character, ' ' | '\t' | '\r' | '\n' | ':' | '_' | '-'))
        .collect();
    if !hex.is_empty() && hex.chars().all(|character| character.is_ascii_hexdigit()) {
        if !hex.len().is_multiple_of(2) {
            return Err("hex string has an odd length".into());
        }
        return (0..hex.len())
            .step_by(2)
            .map(|offset| {
                u8::from_str_radix(&hex[offset..offset + 2], 16)
                    .map_err(|_| "invalid hex encoding".to_string())
            })
            .collect();
    }
    decode_browser_base64(trimmed)
}
pub(super) fn container_value(value: &DataValue, field: DataType) -> Option<&DataValue> {
    let id = field.try_to_id(&TypeMap::latest())?;
    value.get_field(id)
}

pub(crate) fn container_value_by_name<'a>(
    value: &'a DataValue,
    field: &str,
) -> Option<&'a DataValue> {
    container_value(value, DataType::from_name(field)?)
}

pub(super) fn communication_type(name: &str) -> Result<CommunicationType, String> {
    CommunicationType::from_name(name).ok_or_else(|| format!("unknown communication type: {name}"))
}

pub(super) fn json_to_frame(
    type_name: &str,
    data: Value,
    id: u32,
    map: &TypeMap,
) -> Result<CommunicationValue, String> {
    let comm_type = communication_type(type_name)?;
    let mut frame = CommunicationValue::new_with_type_map(comm_type, map).with_id(id);
    let Value::Object(fields) = data else {
        return Err("MTP request data must be an object".into());
    };
    for (name, value) in fields {
        let data_type =
            DataType::from_name(&name).ok_or_else(|| format!("unknown data type: {name}"))?;
        frame = frame.add_typed_default(data_type, json_to_data(&name, value, map)?);
    }
    Ok(frame)
}

pub(super) fn json_to_data(field: &str, value: Value, map: &TypeMap) -> Result<DataValue, String> {
    Ok(match value {
        Value::Null => DataValue::Null,
        Value::Bool(value) => DataValue::from(value),
        Value::Number(value) => {
            if let Some(integer) = value.as_u64() {
                DataValue::UnsignedNumber(integer as u128)
            } else if let Some(integer) = value.as_i64() {
                DataValue::SignedNumber(integer as i128)
            } else {
                DataValue::Float(value.as_f64().ok_or("invalid number")?)
            }
        }
        Value::String(value) => DataValue::Str(value),
        Value::Array(values) if is_bytes_field(field) => DataValue::Bytes(
            values
                .into_iter()
                .map(|value| {
                    value
                        .as_u64()
                        .and_then(|n| u8::try_from(n).ok())
                        .ok_or("invalid byte")
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Value::Array(values) => DataValue::Array(
            values
                .into_iter()
                .map(|value| json_to_data(field, value, map))
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(fields) => {
            let mut entries = Vec::with_capacity(fields.len());
            for (name, value) in fields {
                let data_type = DataType::from_name(&name)
                    .ok_or_else(|| format!("unknown nested data type: {name}"))?;
                let id = data_type
                    .try_to_id(map)
                    .ok_or_else(|| format!("unmapped data type: {name}"))?;
                entries.push((id, json_to_data(&name, value, map)?));
            }
            DataValue::Container(entries)
        }
    })
}

pub(super) fn is_bytes_field(field: &str) -> bool {
    matches!(
        field,
        "Blob" | "EncryptedSecret" | "KemCiphertext" | "Payload" | "PublicKeys"
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn pending_calls_can_retry_until_handled_without_ringing_again() {
        let _lifecycle = super::TEST_LIFECYCLE.lock().unwrap();
        let backend = super::manager();
        backend.set_snapshot(super::MtpSnapshot {
            generation: backend.current_generation(),
            ready_state: super::CONNECTED,
            identified: true,
            ..super::MtpSnapshot::default()
        });
        let invitation = super::CommunicationValue::new(super::CommunicationType::CallInvite)
            .add_typed_default(DataType::CallId, DataValue::Str("handoff-call".into()));
        assert!(backend
            .pending_calls
            .write()
            .unwrap()
            .remember("handoff-call", invitation.clone()));
        let expected = vec![invitation.to_bytes().unwrap()];
        assert_eq!(super::mtp_pending_calls().unwrap(), expected);
        assert_eq!(super::mtp_pending_calls().unwrap(), expected);
        backend
            .pending_calls
            .write()
            .unwrap()
            .dismiss("handoff-call");
        assert!(super::mtp_pending_calls().unwrap().is_empty());
        assert!(!backend
            .pending_calls
            .write()
            .unwrap()
            .remember("handoff-call", invitation.clone()));
        backend.stop();
        assert!(backend
            .pending_calls
            .write()
            .unwrap()
            .remember("handoff-call", invitation));
        backend.stop();
    }

    use mtp::codec::{DataType, DataValue, TypeMap};
    use serde_json::json;

    use super::{
        container_value_by_name, decode_browser_base64, decode_sdk_bytes, json_to_frame,
        RelayTargetDto,
    };

    #[test]
    fn browser_base64_accepts_file_whitespace_and_missing_padding() {
        assert_eq!(decode_browser_base64(" AQID\r\n").unwrap(), [1, 2, 3]);
        assert_eq!(decode_browser_base64("AQI").unwrap(), [1, 2]);
    }

    #[test]
    fn sdk_bytes_accept_hex_and_base64() {
        assert_eq!(decode_sdk_bytes("0x01:02-ff").unwrap(), [1, 2, 255]);
        assert_eq!(decode_sdk_bytes("AQI=").unwrap(), [1, 2]);
    }

    #[test]
    fn iota_relay_target_encodes_its_namespace() {
        assert_eq!(
            RelayTargetDto::Iota { id: 42 }.wire_id().unwrap(),
            0x8000_0000_0000_002a
        );
    }

    #[test]
    fn relay_target_rejects_raw_or_out_of_range_ids() {
        assert!(RelayTargetDto::Iota { id: 0 }.wire_id().is_err());
        assert!(RelayTargetDto::User { id: 1_u64 << 48 }.wire_id().is_err());
    }

    #[test]
    fn json_content_uses_content_wire_type() {
        let frame = json_to_frame(
            "MessageEdit",
            json!({
                "Content": "ciphertext",
                "ChatPartnerId": 42,
                "SendTime": 10,
            }),
            1,
            &TypeMap::latest(),
        )
        .unwrap();

        assert_eq!(
            frame
                .get_data(DataType::Content)
                .and_then(DataValue::as_str),
            Some("ciphertext")
        );
    }

    #[test]
    fn nested_json_content_uses_content_wire_type() {
        let frame = json_to_frame(
            "MessageEdit",
            json!({
                "Message": { "Content": "ciphertext" },
            }),
            1,
            &TypeMap::latest(),
        )
        .unwrap();
        let message = frame.get_data(DataType::Message).unwrap();

        assert_eq!(
            container_value_by_name(message, "Content").and_then(DataValue::as_str),
            Some("ciphertext")
        );
    }
}
