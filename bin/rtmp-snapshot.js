#!/usr/bin/env node
// rtmp-snapshot: pull NMS's http-flv for a moment, tally the FLV tracks, and
// decode one onHawkeye AMF0 data(18) message — emitting a compact JSON snapshot
// for the player's "Live RTMP" card. This is the RTMP analogue of
// bin/srt-snapshot.js. It exists partly to make the point that VLC's media-info
// only lists codec tracks (video/audio): the Hawkeye data rides as FLV
// script-data (AMF), which players ignore, so the only way to *see* it is to
// parse the script tags — which is exactly what this does.
//
// Usage: node bin/rtmp-snapshot.js [http-flv-url] [grabMs]

import http from 'node:http';
import { FlvDemux, FLV_TAG_AUDIO, FLV_TAG_VIDEO, FLV_TAG_SCRIPT } from '../lib/flv.js';
import { decodeAll } from '../lib/amf0.js';
import { loadMessageType, toNum } from '../lib/data-tap.js';

const url = process.argv[2] ?? 'http://127.0.0.1:8000/live/hawkeye.flv';
const grabMs = Number(process.argv[3] ?? 2500);

// FLV codec ids: video tag low nibble, audio tag high nibble.
const VIDEO_CODEC = { 7: 'h264', 12: 'hevc' };
const AUDIO_CODEC = { 10: 'aac', 2: 'mp3', 0: 'pcm' };
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };

const Message = await loadMessageType();
const demux = new FlvDemux();
const counts = { video: 0, audio: 0, script: 0, onHawkeye: 0 };
let meta = null;
let vCodec = null;
let aCodec = null;
let lastHawk = null;

function handleTag(tag) {
  if (tag.type === FLV_TAG_VIDEO) {
    counts.video++;
    if (vCodec == null && tag.data.length) vCodec = tag.data[0] & 0x0f;
  } else if (tag.type === FLV_TAG_AUDIO) {
    counts.audio++;
    if (aCodec == null && tag.data.length) aCodec = (tag.data[0] >> 4) & 0x0f;
  } else if (tag.type === FLV_TAG_SCRIPT) {
    counts.script++;
    let values;
    try { values = decodeAll(tag.data).values; } catch { return; }
    if (values[0] === 'onMetaData') { meta = values[1] || null; return; }
    if (values[0] !== 'onHawkeye') return;
    counts.onHawkeye++;
    try {
      const bytes = Buffer.from(values[1], 'base64');
      const f = Message.decode(bytes).frame;
      lastHawk = {
        amfKey: 'onHawkeye',
        encoding: 'AMF0 data(18) · base64',
        base64Len: values[1].length,
        valueLen: bytes.length,
        valueHead: bytes.subarray(0, 10).toString('hex'),
        tsMs: tag.timestamp,
        frame: f ? {
          frameId: toNum(f.frameId),
          captureTs: toNum(f.captureTimestampMs),
          people: f.people?.length ?? 0,
          ball: f.ball ? { x: +f.ball.pos.x.toFixed(2), y: +f.ball.pos.y.toFixed(2), z: +f.ball.pos.z.toFixed(2) } : null,
        } : null,
      };
    } catch { /* keep prior */ }
  }
}

const req = http.get(url, (res) => {
  if (res.statusCode !== 200) out({ time: Date.now(), error: `http ${res.statusCode} from NMS` });
  res.on('data', (c) => { for (const t of demux.feed(c)) handleTag(t); });
});
req.on('error', (e) => out({ time: Date.now(), error: e.message }));

setTimeout(() => {
  req.destroy();
  if (!counts.video && !counts.audio && !counts.onHawkeye) {
    out({ time: Date.now(), error: 'no FLV data pulled (is the RTMP publisher running?)' });
  }
  const streams = [];
  if (counts.video) {
    streams.push({
      kind: 'video', codec: VIDEO_CODEC[vCodec] || (vCodec != null ? `vc${vCodec}` : 'video'),
      detail: meta && meta.width ? `${meta.width | 0}x${meta.height | 0}` : null,
    });
  }
  if (counts.audio) streams.push({ kind: 'audio', codec: AUDIO_CODEC[aCodec] || (aCodec != null ? `ac${aCodec}` : 'audio'), detail: null });
  streams.push({ kind: 'data', codec: 'onHawkeye', tag: 'AMF0', detail: `${counts.onHawkeye} msg / ${(grabMs / 1000).toFixed(1)}s` });
  out({ time: Date.now(), url, tags: counts, streams, hawkeye: lastHawk });
}, grabMs);
