#!/usr/bin/env node
// ts-extract: the Phase-1 inspector. Read an MPEG-TS (file arg or stdin),
// reassemble the PES on the data PID, and assert every payload re-decodes to a
// valid Hawkeye Frame. This is the "inspect" half of embed-and-inspect.
//
// Usage: node bin/ts-extract.js [file.ts] [--pid 0x101]

import fs from 'node:fs';
import { TS_PACKET_SIZE, SYNC_BYTE, pidOf, pusiOf, payloadStart } from '../lib/ts.js';
import { makeVerifier } from '../lib/extract-verify.js';
import { klvUnwrap } from '../lib/klv.js';

function parseArgs(argv) {
  const args = { file: null, pid: 0x102, klv: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pid') args.pid = Number(argv[++i]);
    else if (argv[i] === '--klv') args.klv = true; // unwrap SMPTE KLV before decoding
    else if (!args.file) args.file = argv[i];
  }
  return args;
}

async function readInput(file) {
  if (file) return fs.readFileSync(file);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

// Find the byte offset of the first TS packet boundary. A live SRT capture can
// start mid-stream, so we can't assume the buffer begins on a 188-byte grid.
function findAlignment(buf) {
  for (let o = 0; o < TS_PACKET_SIZE && o + 4 * TS_PACKET_SIZE < buf.length; o++) {
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (buf[o + k * TS_PACKET_SIZE] !== SYNC_BYTE) { ok = false; break; }
    }
    if (ok) return o;
  }
  return 0;
}

// Reassemble PES payloads on `dataPid` (drops the PES header, keeps the payload).
function* extractPes(buf, dataPid) {
  let cur = null;
  const align = findAlignment(buf);
  for (let i = align; i + TS_PACKET_SIZE <= buf.length; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC_BYTE) { i = findAlignment(buf.subarray(i)) + i - TS_PACKET_SIZE; continue; }
    const pkt = buf.subarray(i, i + TS_PACKET_SIZE);
    if (pidOf(pkt) !== dataPid) continue;
    const start = payloadStart(pkt);
    if (start < 0) continue;
    if (pusiOf(pkt)) {
      if (cur) yield Buffer.concat(cur);
      const pes = pkt.subarray(start);
      const payloadOff = 9 + pes[8]; // 6-byte PES header + 3 fixed + header_data_length
      cur = [Buffer.from(pes.subarray(payloadOff))];
    } else if (cur) {
      cur.push(Buffer.from(pkt.subarray(start)));
    }
  }
  if (cur) yield Buffer.concat(cur);
}

const { file, pid, klv } = parseArgs(process.argv.slice(2));
const buf = await readInput(file);
const verify = await makeVerifier();

let total = 0;
let ok = 0;
let fail = 0;
const sample = [];
let firstId = null;
let lastId = null;

for (const payload of extractPes(buf, pid)) {
  total++;
  try {
    const proto = klv ? klvUnwrap(payload).value : payload;
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

console.log(`data PID 0x${pid.toString(16)}: ${total} PES, ${ok} valid frames, ${fail} failed`);
if (sample.length) {
  console.log('first frames:');
  for (const v of sample) {
    console.log(`  frameId=${v.frameId} captureTs=${v.captureTs} people=${v.people} ball=${v.hasBall} bytes=${v.bytes}`);
  }
  console.log(`frameId range: ${firstId}..${lastId} (span ${lastId - firstId}, ${ok} carried)`);
}

process.exit(fail === 0 && ok > 0 ? 0 : 1);
