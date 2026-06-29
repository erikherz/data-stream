// Minimal AMF0 encode/decode — just the value types we put on the wire for RTMP
// commands and the onHawkeye data message, plus enough decode to read script
// tags back out of an http-flv stream for verification.

// --- encode ---
export function encodeNumber(n) {
  const b = Buffer.alloc(9);
  b[0] = 0x00;
  b.writeDoubleBE(n, 1);
  return b;
}
export function encodeBool(v) {
  return Buffer.from([0x01, v ? 1 : 0]);
}
export function encodeString(s) {
  const body = Buffer.from(s, 'utf8');
  if (body.length > 0xffff) return encodeLongString(s);
  const head = Buffer.alloc(3);
  head[0] = 0x02;
  head.writeUInt16BE(body.length, 1);
  return Buffer.concat([head, body]);
}
export function encodeLongString(s) {
  const body = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
  const head = Buffer.alloc(5);
  head[0] = 0x0c;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}
export const encodeNull = () => Buffer.from([0x05]);

export function encodeObject(obj) {
  const parts = [Buffer.from([0x03])];
  for (const [k, v] of Object.entries(obj)) {
    const key = Buffer.from(k, 'utf8');
    const kh = Buffer.alloc(2);
    kh.writeUInt16BE(key.length, 0);
    parts.push(kh, key, encodeValue(v));
  }
  parts.push(Buffer.from([0x00, 0x00, 0x09])); // empty key + object-end marker
  return Buffer.concat(parts);
}

export function encodeValue(v) {
  if (v === null || v === undefined) return encodeNull();
  switch (typeof v) {
    case 'number': return encodeNumber(v);
    case 'boolean': return encodeBool(v);
    case 'string': return encodeString(v);
    case 'object': return encodeObject(v);
    default: throw new Error(`AMF0: cannot encode ${typeof v}`);
  }
}

// Encode a sequence of AMF0 values into one buffer.
export const encode = (...values) => Buffer.concat(values.map(encodeValue));

// --- decode (enough to walk script-data payloads) ---
function decodeOne(buf, pos) {
  const type = buf[pos];
  pos += 1;
  switch (type) {
    case 0x00:
      return { value: buf.readDoubleBE(pos), pos: pos + 8 };
    case 0x01:
      return { value: buf[pos] !== 0, pos: pos + 1 };
    case 0x02: {
      const len = buf.readUInt16BE(pos);
      pos += 2;
      return { value: buf.toString('utf8', pos, pos + len), pos: pos + len, raw: buf.subarray(pos, pos + len) };
    }
    case 0x0c: {
      const len = buf.readUInt32BE(pos);
      pos += 4;
      return { value: buf.toString('latin1', pos, pos + len), pos: pos + len, raw: buf.subarray(pos, pos + len) };
    }
    case 0x05:
    case 0x06:
      return { value: null, pos };
    case 0x03:
    case 0x08: {
      if (type === 0x08) pos += 4; // ECMA array count (ignored)
      const obj = {};
      while (pos < buf.length) {
        const klen = buf.readUInt16BE(pos);
        pos += 2;
        if (klen === 0 && buf[pos] === 0x09) { pos += 1; break; }
        const key = buf.toString('utf8', pos, pos + klen);
        pos += klen;
        const r = decodeOne(buf, pos);
        obj[key] = r.value;
        pos = r.pos;
      }
      return { value: obj, pos };
    }
    case 0x0a: {
      const count = buf.readUInt32BE(pos);
      pos += 4;
      const arr = [];
      for (let i = 0; i < count; i++) {
        const r = decodeOne(buf, pos);
        arr.push(r.value);
        pos = r.pos;
      }
      return { value: arr, pos };
    }
    default:
      throw new Error(`AMF0: unsupported type 0x${type.toString(16)} at ${pos - 1}`);
  }
}

// Decode all AMF0 values in a buffer. Returns { values, raws } where raws[i] is
// the underlying bytes for string/long-string values (used to recover payloads).
export function decodeAll(buf) {
  const values = [];
  const raws = [];
  let pos = 0;
  while (pos < buf.length) {
    const r = decodeOne(buf, pos);
    values.push(r.value);
    raws.push(r.raw ?? null);
    pos = r.pos;
  }
  return { values, raws };
}
