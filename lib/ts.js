// MPEG-TS primitives for splicing a private-data elementary stream into an
// existing transport stream produced by ffmpeg.
//
// Scope is deliberately narrow: parse 188-byte packets, read/patch the PAT/PMT,
// read video PTS, and build + packetize a PES for our data PID. Just enough to
// carry the raw Hawkeye protobuf alongside H.264 in one TS over SRT.

export const TS_PACKET_SIZE = 188;
export const SYNC_BYTE = 0x47;

// MPEG-2 systems CRC-32: poly 0x04C11DB7, init 0xFFFFFFFF, MSB-first, no final XOR.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = (c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1) >>> 0;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

// --- packet field accessors ---
export const pidOf = (pkt) => ((pkt[1] & 0x1f) << 8) | pkt[2];
export const pusiOf = (pkt) => (pkt[1] & 0x40) !== 0;
const afcOf = (pkt) => (pkt[3] >> 4) & 0x3;

// True if this packet's adaptation field has random_access_indicator set —
// ffmpeg flags this on the first packet of a keyframe access unit, which is
// exactly where an HLS segment may start.
export function hasRandomAccess(pkt) {
  const afc = afcOf(pkt);
  if (!(afc & 0x2) || pkt[4] === 0) return false;
  return (pkt[5] & 0x40) !== 0;
}

// ES-level registration descriptor tagging a stream as carrying ID3 ('ID3 ').
export const ID3_REGISTRATION_DESCRIPTOR = Buffer.from([0x05, 0x04, 0x49, 0x44, 0x33, 0x20]);

// ES-level registration descriptor tagging a stream as synchronous KLV ('KLVA',
// SMPTE ST 336 / MISB ST 1402) — ffmpeg/GStreamer key off this to demux KLV.
export const KLVA_REGISTRATION_DESCRIPTOR = Buffer.from([0x05, 0x04, 0x4b, 0x4c, 0x56, 0x41]);

// Offset of the payload within a packet (-1 if the packet carries no payload).
export function payloadStart(pkt) {
  const afc = afcOf(pkt);
  if (!(afc & 0x1)) return -1;
  if (afc & 0x2) return 5 + pkt[4]; // 4-byte header + length byte + adaptation field
  return 4;
}

// Start of the PSI section within a PSI packet (accounts for the pointer_field).
const sectionStart = (pkt) => {
  const p = payloadStart(pkt);
  return p + 1 + pkt[p];
};

// --- PAT / PMT parsing (used to auto-detect PIDs across ffmpeg versions) ---

// Returns [{ programNumber, pmtPid }] for a PAT packet.
export function parsePat(pkt) {
  const s = sectionStart(pkt);
  const len = ((pkt[s + 1] & 0x0f) << 8) | pkt[s + 2];
  const end = s + 3 + len - 4; // exclude CRC
  const out = [];
  for (let i = s + 8; i + 4 <= end; i += 4) {
    const programNumber = (pkt[i] << 8) | pkt[i + 1];
    const pmtPid = ((pkt[i + 2] & 0x1f) << 8) | pkt[i + 3];
    if (programNumber !== 0) out.push({ programNumber, pmtPid });
  }
  return out;
}

// Returns every elementary stream in a PMT: { streamType, pid, reg } where reg
// is the 4-char registration format identifier ('KLVA', 'ID3 ', …) if present.
export function parsePmtStreams(pkt) {
  const s = sectionStart(pkt);
  const len = ((pkt[s + 1] & 0x0f) << 8) | pkt[s + 2];
  const end = s + 3 + len - 4;
  const programInfoLen = ((pkt[s + 10] & 0x0f) << 8) | pkt[s + 11];
  let i = s + 12 + programInfoLen;
  const out = [];
  while (i + 5 <= end) {
    const streamType = pkt[i];
    const pid = ((pkt[i + 1] & 0x1f) << 8) | pkt[i + 2];
    const esInfoLen = ((pkt[i + 3] & 0x0f) << 8) | pkt[i + 4];
    let reg = null;
    for (let j = i + 5, de = i + 5 + esInfoLen; j + 2 <= de; j += 2 + pkt[j + 1]) {
      if (pkt[j] === 0x05 && pkt[j + 1] >= 4) {
        reg = String.fromCharCode(pkt[j + 2], pkt[j + 3], pkt[j + 4], pkt[j + 5]).replace(/\0/g, '').trim();
      }
    }
    out.push({ streamType, pid, reg });
    i += 5 + esInfoLen;
  }
  return out;
}

// Returns the elementary PID of the first video stream described by a PMT.
export function parsePmtVideoPid(pkt) {
  const s = sectionStart(pkt);
  const len = ((pkt[s + 1] & 0x0f) << 8) | pkt[s + 2];
  const end = s + 3 + len - 4;
  const programInfoLen = ((pkt[s + 10] & 0x0f) << 8) | pkt[s + 11];
  let i = s + 12 + programInfoLen;
  while (i + 5 <= end) {
    const streamType = pkt[i];
    const elementaryPid = ((pkt[i + 1] & 0x1f) << 8) | pkt[i + 2];
    const esInfoLen = ((pkt[i + 3] & 0x0f) << 8) | pkt[i + 4];
    if ([0x01, 0x02, 0x1b, 0x24].includes(streamType)) return elementaryPid;
    i += 5 + esInfoLen;
  }
  return null;
}

// Returns a new PMT packet with an extra elementary stream appended
// (stream_type + elementary PID + optional ES-info descriptors), CRC recomputed.
export function patchPmt(pkt, dataPid, streamType = 0x06, esDescriptor = null) {
  const s = sectionStart(pkt);
  const len = ((pkt[s + 1] & 0x0f) << 8) | pkt[s + 2];
  const crcPos = s + 3 + len - 4;

  const desc = esDescriptor ?? Buffer.alloc(0);
  const entry = Buffer.concat([
    Buffer.from([
      streamType & 0xff,
      0xe0 | ((dataPid >> 8) & 0x1f),
      dataPid & 0xff,
      0xf0 | ((desc.length >> 8) & 0x0f),
      desc.length & 0xff,
    ]),
    desc,
  ]);

  const body = Buffer.concat([pkt.subarray(s, crcPos), entry]);
  const newLen = len + entry.length;
  body[1] = (body[1] & 0xf0) | ((newLen >> 8) & 0x0f);
  body[2] = newLen & 0xff;

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);

  const assembled = Buffer.concat([pkt.subarray(0, s), body, crc]);
  if (assembled.length > TS_PACKET_SIZE) throw new Error('PMT overflow after patch');
  return Buffer.concat([assembled, Buffer.alloc(TS_PACKET_SIZE - assembled.length, 0xff)]);
}

// --- PTS (33-bit, 90 kHz) ---

export function readVideoPts(pkt) {
  const start = payloadStart(pkt);
  if (start < 0) return null;
  const p = pkt.subarray(start);
  if (p.length < 14 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1) return null;
  if (!((p[7] & 0x80) >> 7)) return null; // PTS_DTS_flags has no PTS
  const a = (p[9] >> 1) & 0x07;
  const b = (((p[10] << 8) | p[11]) >>> 1) & 0x7fff;
  const c = (((p[12] << 8) | p[13]) >>> 1) & 0x7fff;
  return a * 2 ** 30 + b * 2 ** 15 + c;
}

function encodePts(pts) {
  const p = Math.floor(pts) % 2 ** 33;
  const hi = Math.floor(p / 2 ** 30) & 0x7;
  const mid = Math.floor(p / 2 ** 15) & 0x7fff;
  const lo = p & 0x7fff;
  return Buffer.from([
    0x20 | (hi << 1) | 1,
    (mid >> 7) & 0xff,
    ((mid & 0x7f) << 1) | 1,
    (lo >> 7) & 0xff,
    ((lo & 0x7f) << 1) | 1,
  ]);
}

// --- PES build + packetize for the data PID ---

// Build a private_stream_1 (0xBD) PES carrying `payload`, optionally with a PTS.
export function buildPes(payload, pts = null, streamId = 0xbd) {
  const opt =
    pts == null
      ? Buffer.from([0x80, 0x00, 0x00])
      : Buffer.concat([Buffer.from([0x80, 0x80, 0x05]), encodePts(pts)]);
  const pesLen = opt.length + payload.length;
  const header = Buffer.alloc(6);
  header[0] = 0x00;
  header[1] = 0x00;
  header[2] = 0x01;
  header[3] = streamId & 0xff;
  header.writeUInt16BE(pesLen <= 0xffff ? pesLen : 0, 4);
  return Buffer.concat([header, opt, payload]);
}

// Slice a PES into 188-byte TS packets for `pid`, continuing from `cc`.
// Returns { packets: Buffer[], cc }.
export function packetizePes(pid, pes, cc) {
  const packets = [];
  let off = 0;
  let first = true;
  while (off < pes.length) {
    const pkt = Buffer.alloc(TS_PACKET_SIZE, 0xff);
    pkt[0] = SYNC_BYTE;
    pkt[1] = (first ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
    pkt[2] = pid & 0xff;
    const remaining = pes.length - off;
    if (remaining >= 184) {
      pkt[3] = 0x10 | (cc & 0x0f);
      pes.copy(pkt, 4, off, off + 184);
      off += 184;
    } else {
      pkt[3] = 0x30 | (cc & 0x0f); // adaptation field + payload
      const afLen = 183 - remaining;
      pkt[4] = afLen;
      if (afLen > 0) pkt[5] = 0x00; // flags byte; remaining af bytes stay 0xff stuffing
      pes.copy(pkt, 5 + afLen, off, off + remaining);
      off += remaining;
    }
    cc = (cc + 1) & 0x0f;
    first = false;
    packets.push(pkt);
  }
  return { packets, cc };
}
