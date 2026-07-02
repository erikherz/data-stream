#!/usr/bin/env node
// spatial-verify: prove the SSE pose feed normalizes to a valid Hawkeye Frame.
// Normalizes N pose payloads (from the offline fixture by default, or the live
// SSE with --live) and asserts each re-decodes via the shared verifier — the
// same "embed + inspect" proof the transports use, minus the container.
//
// Usage: node bin/spatial-verify.js [n=5] [--live]

import { makeSpatialNormalizer } from '../lib/spatial-normalize.js';
import { makeVerifier } from '../lib/extract-verify.js';
import { SpatialTap } from '../lib/spatial-tap.js';

const FIXTURE = 'https://experiencematters.cloud/spatial-feed/sample-frames.jsonl';
const args = process.argv.slice(2);
const live = args.includes('--live');
const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);

const norm = await makeSpatialNormalizer();
const verify = await makeVerifier();
console.log(`normalizer ready (roster ${norm.rosterSize} players)`);

function report(payload, i) {
  const raw = norm.normalize(payload);
  const v = verify(raw);              // throws if not a decodable Frame
  const m = raw.length;
  console.log(`#${i} frame=${v.frameId} people=${v.people} ball=${v.hasBall} protobuf=${m}B (from ~${JSON.stringify(payload).length}B JSON)`);
  return v;
}

if (live) {
  let i = 0;
  const tap = new SpatialTap();
  tap.on('open', (u) => console.log(`live SSE: ${u}`));
  tap.on('frame', (f) => {
    if (i >= n) return;
    try { report(f.payload, ++i); } catch (e) { console.error(`  FAIL #${i}: ${e.message}`); process.exit(1); }
    if (i >= n) { tap.stop(); console.log('OK — all live frames normalized + verified'); process.exit(0); }
  });
  await tap.start();
  setTimeout(() => { console.error('timeout waiting for live frames'); process.exit(1); }, 15000);
} else {
  const res = await fetch(FIXTURE);
  const text = await res.text();
  const lines = text.split('\n').filter(Boolean).slice(0, n);
  let i = 0;
  for (const line of lines) {
    const payload = JSON.parse(line).payload;
    try { report(payload, ++i); } catch (e) { console.error(`  FAIL #${i}: ${e.message}`); process.exit(1); }
  }
  console.log(`OK — ${i} fixture frames normalized + verified`);
}
