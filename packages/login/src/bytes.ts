const encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function writeUintBE(
  value: bigint | number,
  byteLength: number,
): Uint8Array {
  const out = new Uint8Array(byteLength);
  const view = new DataView(out.buffer);
  if (byteLength === 2) {
    view.setUint16(0, Number(value), false);
  } else if (byteLength === 4) {
    view.setUint32(0, Number(value), false);
  } else if (byteLength === 8) {
    view.setBigUint64(0, BigInt(value), false);
  } else {
    throw new RangeError("writeUintBE supports 2, 4 or 8 byte widths");
  }
  return out;
}

export function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new RangeError(`Invalid UUID: ${uuid}`);
  }
  const out = new Uint8Array(16);
  for (let index = 0; index < 16; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function zeroBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}
