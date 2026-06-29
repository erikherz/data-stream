#!/usr/bin/env node
// srt-snapshot: read a captured TS (from an SRT pull) and emit a compact JSON
// snapshot of its tracks + a peek at the KLV — for the player's live SRT card.
//
// Usage: node bin/srt-snapshot.js capture.ts   (prints JSON to stdout)

import fs from 'node:fs';
import {
  TS_PACKET_SIZE, SYNC_BYTE, pidOf, pusiOf, payloadStart, parsePat, parsePmtStreams,
} from '../lib/ts.js';
import { klvUnwrap } from '../lib/klv.js';
import { loadMessageType, toNum } from '../lib/data-tap.js';

const TYPES = { 0x1b: 'h264', 0x24: 'hevc', 0x0f: 'aac', 0x03: 'mp3', 0x04: 'mp3', 0x81: 'ac3', 0x15: 'timed_id3', 0x06: 'private' };
const AUDIO = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);
const VIDEO = new Set([0x01, 0x02, 0x1b, 0x24]);
const codecName = (s) =>
  s.streamType === 0x06 && s.reg === 'KLVA' ? 'klv'
  : s.streamType === 0x15 && s.reg === 'ID3' ? 'timed_id3'
  : TYPES[s.streamType] || '0x' + s.streamType.toString(16);

const buf = fs.readFileSync(process.argv[2]);

// An SRT pull joins mid-stream, so the buffer rarely starts on a 188-byte grid.
// Lock onto the first offset with four consecutive sync bytes a packet apart.
function findAlignment(b) {
  for (let o = 0; o < TS_PACKET_SIZE && o + 4 * TS_PACKET_SIZE < b.length; o++) {
    let ok = true;
    for (let k = 0; k < 4; k++) if (b[o + k * TS_PACKET_SIZE] !== SYNC_BYTE) { ok = false; break; }
    if (ok) return o;
  }
  return 0;
}
const align = findAlignment(buf);

let pmtPid = null;
let streams = null;
for (let i = align; i + TS_PACKET_SIZE <= buf.length; i += TS_PACKET_SIZE) {
  if (buf[i] !== SYNC_BYTE) continue;
  const p = buf.subarray(i, i + TS_PACKET_SIZE);
  const id = pidOf(p);
  if (id === 0 && pusiOf(p) && pmtPid === null) pmtPid = parsePat(p)[0]?.pmtPid ?? null;
  else if (id === pmtPid && pusiOf(p) && !streams) streams = parsePmtStreams(p);
  if (streams) break;
}
if (!streams) { console.log(JSON.stringify({ time: Date.now(), error: 'no program found' })); process.exit(0); }

// First complete PES on a PID (drops the PES header).
function firstPes(pid) {
  let cur = null;
  for (let i = align; i + TS_PACKET_SIZE <= buf.length; i += TS_PACKET_SIZE) {
    if (buf[i] !== SYNC_BYTE) continue;
    const p = buf.subarray(i, i + TS_PACKET_SIZE);
    if (pidOf(p) !== pid) continue;
    const st = payloadStart(p);
    if (st < 0) continue;
    if (pusiOf(p)) {
      if (cur) return Buffer.concat(cur);
      const pes = p.subarray(st);
      cur = [Buffer.from(pes.subarray(9 + pes[8]))];
    } else if (cur) cur.push(Buffer.from(p.subarray(st)));
  }
  return cur ? Buffer.concat(cur) : null;
}

let klv = null;
const klvStream = streams.find((s) => codecName(s) === 'klv');
if (klvStream) {
  try {
    const pes = firstPes(klvStream.pid);
    const { key, value } = klvUnwrap(pes);
    const Message = await loadMessageType();
    const f = Message.decode(value).frame;
    klv = {
      ul: key.toString('hex'),
      valueLen: value.length,
      valueHead: value.subarray(0, 10).toString('hex'),
      frame: f ? {
        frameId: toNum(f.frameId),
        captureTs: toNum(f.captureTimestampMs),
        people: f.people?.length ?? 0,
        ball: f.ball ? { x: +f.ball.pos.x.toFixed(2), y: +f.ball.pos.y.toFixed(2), z: +f.ball.pos.z.toFixed(2) } : null,
      } : null,
    };
  } catch (e) { klv = { error: e.message }; }
}

console.log(JSON.stringify({
  time: Date.now(),
  bytes: buf.length,
  streams: streams.map((s, index) => ({
    index, pid: s.pid, tag: s.reg || null, codec: codecName(s),
    kind: VIDEO.has(s.streamType) ? 'video' : AUDIO.has(s.streamType) ? 'audio' : 'data',
  })),
  klv,
}));
