// SMPTE ST 336 KLV (Key-Length-Value) encode/decode for synchronous metadata
// carriage in MPEG-TS, per MISB ST 1402. Each Hawkeye frame becomes one KLV
// triplet: a 16-byte Universal Label key, a BER-encoded length, then the raw
// protobuf Message as the value. Carried in a private-data PES (stream_type
// 0x06) whose PMT entry has a 'KLVA' registration descriptor — which is what
// makes ffmpeg/GStreamer/MISB tools recognize and demux it as KLV.

// Private Universal Label for the Hawkeye payload. The leading 06 0E 2B 34 is
// the SMPTE UL designator; the trailing bytes spell 'VIVOHHK1' as an org-private
// identifier. For production, register a UL with SMPTE and publish the key + the
// .proto so consumers can interpret the value. (Tools demux KLV off the PMT
// 'KLVA' descriptor regardless of this key; the key only drives semantics.)
export const HAWKEYE_UL = Buffer.from([
  0x06, 0x0e, 0x2b, 0x34, 0x01, 0x01, 0x01, 0x0f,
  0x56, 0x49, 0x56, 0x4f, 0x48, 0x48, 0x4b, 0x31, // 'VIVOHHK1'
]);

// BER length: short form (<128) is one byte; long form is 0x80|n followed by n
// big-endian length bytes.
export function berLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

// Wrap a value as one KLV triplet.
export function klvWrap(value, key = HAWKEYE_UL) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([key, berLength(v.length), v]);
}

// Parse a KLV triplet, returning { key, value }. Throws on a malformed packet.
export function klvUnwrap(buf) {
  if (buf.length < 17) throw new Error('KLV too short');
  const key = buf.subarray(0, 16);
  let pos = 16;
  const b0 = buf[pos++];
  let len;
  if (b0 < 0x80) {
    len = b0;
  } else {
    const n = b0 & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
  }
  return { key, value: buf.subarray(pos, pos + len) };
}
