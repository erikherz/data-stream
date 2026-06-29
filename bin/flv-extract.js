#!/usr/bin/env node
// flv-extract: the Phase-2 inspector. Pull NMS's http-flv output, find the
// onHawkeye script(18) tags, base64-decode them, and assert each re-decodes to
// a valid Hawkeye Frame. This proves the data survived: publisher -> RTMP -> NMS
// relay -> http-flv subscriber.
//
// Usage: node bin/flv-extract.js [url] [seconds=6]

import http from 'node:http';
import { FlvDemux, FLV_TAG_SCRIPT } from '../lib/flv.js';
import { decodeAll } from '../lib/amf0.js';
import { makeVerifier } from '../lib/extract-verify.js';

const url = process.argv[2] ?? 'http://127.0.0.1:8000/live/hawkeye.flv';
const seconds = Number(process.argv[3] ?? 6);

const verify = await makeVerifier();
const demux = new FlvDemux();
let total = 0;
let ok = 0;
let fail = 0;
const sample = [];
let firstId = null;
let lastId = null;

function handleTag(tag) {
  if (tag.type !== FLV_TAG_SCRIPT) return;
  let values;
  try { values = decodeAll(tag.data).values; } catch { return; }
  if (values[0] !== 'onHawkeye') return; // skip onMetaData etc.
  total++;
  try {
    const bytes = Buffer.from(values[1], 'base64');
    const v = verify(bytes);
    ok++;
    if (firstId == null) firstId = v.frameId;
    lastId = v.frameId;
    if (sample.length < 3) sample.push({ ...v, ts: tag.timestamp });
  } catch (err) {
    fail++;
    if (fail <= 3) console.error(`  decode fail #${total}: ${err.message}`);
  }
}

const req = http.get(url, (res) => {
  if (res.statusCode !== 200) {
    console.error(`http ${res.statusCode} from ${url}`);
    process.exit(1);
  }
  res.on('data', (chunk) => {
    for (const tag of demux.feed(chunk)) handleTag(tag);
  });
});
req.on('error', (e) => { console.error(`request error: ${e.message}`); process.exit(1); });

setTimeout(() => {
  req.destroy();
  console.log(`onHawkeye tags: ${total}, ${ok} valid frames, ${fail} failed`);
  for (const v of sample) {
    console.log(`  frameId=${v.frameId} captureTs=${v.captureTs} people=${v.people} ball=${v.hasBall} bytes=${v.bytes} flvTs=${v.ts}ms`);
  }
  if (ok) console.log(`frameId range: ${firstId}..${lastId} (span ${lastId - firstId}, ${ok} carried)`);
  process.exit(fail === 0 && ok > 0 ? 0 : 1);
}, seconds * 1000);
