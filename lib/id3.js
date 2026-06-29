// Minimal ID3v2.4 build/parse for HLS timed metadata. Each Hawkeye frame is
// carried as one ID3 tag containing a single PRIV frame: owner identifier +
// the raw protobuf Message bytes. This is the payload of each metadata-PID PES,
// and the PES PTS gives it its position on the media timeline.

const OWNER = 'com.vivoh.hawkeye';

// ID3v2 sizes are "synchsafe": 7 usable bits per byte (top bit always 0).
function synchsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}
function unsynchsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

// Build an ID3v2.4 tag wrapping `data` in a PRIV frame.
export function buildId3(data, owner = OWNER) {
  const ownerBuf = Buffer.concat([Buffer.from(owner, 'latin1'), Buffer.from([0x00])]);
  const frameBody = Buffer.concat([ownerBuf, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
  const frame = Buffer.concat([
    Buffer.from('PRIV', 'latin1'),
    synchsafe(frameBody.length),
    Buffer.from([0x00, 0x00]), // frame flags
    frameBody,
  ]);
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([0x04, 0x00]), // version 2.4.0
    Buffer.from([0x00]), // tag flags
    synchsafe(frame.length),
  ]);
  return Buffer.concat([header, frame]);
}

// Parse an ID3v2 tag and return the PRIV frame payloads after their owner id.
// Returns the first PRIV data buffer (what buildId3 wrote), or null.
export function parseId3Priv(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
  const tagSize = unsynchsafe(buf, 6);
  let pos = 10;
  const end = Math.min(buf.length, 10 + tagSize);
  while (pos + 10 <= end) {
    const id = buf.toString('latin1', pos, pos + 4);
    if (id === '\x00\x00\x00\x00') break; // padding
    const size = unsynchsafe(buf, pos + 4);
    const bodyStart = pos + 10;
    if (id === 'PRIV') {
      const body = buf.subarray(bodyStart, bodyStart + size);
      const nul = body.indexOf(0x00);
      return nul >= 0 ? body.subarray(nul + 1) : body;
    }
    pos = bodyStart + size;
  }
  return null;
}
