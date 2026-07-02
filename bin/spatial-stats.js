#!/usr/bin/env node
// spatial-stats: connect to the spatial pose SSE feed and report rate / size /
// people / ball — the analog of bin/tap-stats.js for the Hawkeye feed. Proves
// the tap ingests the experiencematters.cloud basketball tracking stream.
//
// Usage: node bin/spatial-stats.js [seconds=10]

import { SpatialTap, summarizeFrame, DEFAULT_SPATIAL_URL } from '../lib/spatial-tap.js';

const seconds = Number(process.argv[2] ?? 10);
const log = (...a) => console.error('[spatial-stats]', ...a);

let count = 0;
let bytes = 0;
let firstId = null;
let lastId = null;
let maxPeople = 0;
const t0 = Date.now();

log(`url: ${DEFAULT_SPATIAL_URL}`);
const tap = new SpatialTap();
tap.on('open', (u) => log(`connected: ${u}`));
tap.on('error', (e) => log(`error: ${e.message}`));
tap.on('parseError', (e) => log(`parse error: ${e.message}`));
tap.on('frame', (f) => {
  count++;
  bytes += Buffer.byteLength(f.raw);
  if (firstId == null) firstId = f.frameId;
  lastId = f.frameId;
  const { people, ball } = summarizeFrame(f.payload);
  if (people > maxPeople) maxPeople = people;
  if (count <= 3) {
    const b = ball ? ball.map((n) => n.toFixed(1)).join(',') : '—';
    log(`frame#${f.frameId} sseId=${f.id} people=${people} ball=[${b}] bytes=${Buffer.byteLength(f.raw)}`);
  }
});

await tap.start();

setTimeout(() => {
  tap.stop();
  const dt = (Date.now() - t0) / 1000;
  const mbps = (bytes * 8) / dt / 1e6;
  console.log(`\n${count} frames in ${dt.toFixed(1)}s → ${(count / dt).toFixed(1)} fps, ` +
    `${count ? (bytes / count) | 0 : 0} B/frame avg, ~${mbps.toFixed(2)} Mbps`);
  console.log(`frameId range ${firstId}..${lastId}, max people/frame ${maxPeople}`);
  process.exit(count > 0 ? 0 : 1);
}, seconds * 1000);
