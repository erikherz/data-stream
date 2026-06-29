#!/usr/bin/env node
// hls-extract: the Phase-3 inspector. Read an HLS playlist + its segments,
// reassemble the ID3 metadata PID, unwrap each ID3 PRIV frame, and assert the
// payload re-decodes to a valid Hawkeye Frame. Proves the data survived being
// muxed into HLS segments as in-band timed metadata.
//
// Usage: node bin/hls-extract.js [dir/name.m3u8] [--pid 0x102]

import fs from 'node:fs';
import path from 'node:path';
import { TS_PACKET_SIZE, SYNC_BYTE, pidOf, pusiOf, payloadStart } from '../lib/ts.js';
import { parseId3Priv } from '../lib/id3.js';
import { makeVerifier } from '../lib/extract-verify.js';

function parseArgs(argv) {
  const args = { m3u8: '/tmp/hls/hawkeye.m3u8', pid: 0x102 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pid') args.pid = Number(argv[++i]);
    else args.m3u8 = argv[i];
  }
  return args;
}

// Reassemble PES payloads on a PID across a (possibly multi-segment) TS buffer.
function* extractPes(buf, dataPid) {
  let cur = null;
  let align = 0;
  while (align < TS_PACKET_SIZE && buf[align] !== SYNC_BYTE) align++;
  for (let i = align; i + TS_PACKET_SIZE <= buf.length; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC_BYTE) { i -= TS_PACKET_SIZE - 1; continue; } // resync
    const pkt = buf.subarray(i, i + TS_PACKET_SIZE);
    if (pidOf(pkt) !== dataPid) continue;
    const start = payloadStart(pkt);
    if (start < 0) continue;
    if (pusiOf(pkt)) {
      if (cur) yield Buffer.concat(cur);
      const pes = pkt.subarray(start);
      cur = [Buffer.from(pes.subarray(9 + pes[8]))]; // skip PES header
    } else if (cur) {
      cur.push(Buffer.from(pkt.subarray(start)));
    }
  }
  if (cur) yield Buffer.concat(cur);
}

const { m3u8, pid } = parseArgs(process.argv.slice(2));
const dir = path.dirname(m3u8);
const segments = fs.readFileSync(m3u8, 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
if (!segments.length) { console.error('no segments in playlist'); process.exit(1); }

const buf = Buffer.concat(segments.map((s) => fs.readFileSync(path.join(dir, s))));
const verify = await makeVerifier();

let total = 0, ok = 0, fail = 0;
const sample = [];
let firstId = null, lastId = null;

for (const pes of extractPes(buf, pid)) {
  total++;
  try {
    const proto = parseId3Priv(pes);
    if (!proto) throw new Error('no PRIV frame in ID3 tag');
    const v = verify(proto);
    ok++;
    if (firstId == null) firstId = v.frameId;
    lastId = v.frameId;
    if (sample.length < 3) sample.push(v);
  } catch (err) {
    fail++;
    if (fail <= 3) console.error(`  decode fail #${total}: ${err.message}`);
  }
}

console.log(`${segments.length} segments, metadata PID 0x${pid.toString(16)}: ${total} ID3 tags, ${ok} valid frames, ${fail} failed`);
for (const v of sample) {
  console.log(`  frameId=${v.frameId} captureTs=${v.captureTs} people=${v.people} ball=${v.hasBall} bytes=${v.bytes}`);
}
if (ok) console.log(`frameId range: ${firstId}..${lastId} (span ${lastId - firstId}, ${ok} carried)`);

process.exit(fail === 0 && ok > 0 ? 0 : 1);
