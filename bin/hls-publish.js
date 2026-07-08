#!/usr/bin/env node
// hls-publish: the Phase-3 live publisher.
//
// ffmpeg(adena.mp4, fixed 2s GOP -> MPEG-TS) -> TsInjector(adds an ID3 metadata
// PID carrying each Hawkeye frame, PTS-synced) -> HlsSegmenter(keyframe-split
// segments + sliding-window playlist). Serve the output dir over HTTP to play
// or to run bin/hls-extract.js against.
//
// Usage: node bin/hls-publish.js [outDir=/tmp/hls] [name=hawkeye]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createFrameSource } from '../lib/frame-source.js';
import { TsInjector } from '../lib/ts-inject.js';
import { HlsSegmenter } from '../lib/hls-segmenter.js';
import { buildId3 } from '../lib/id3.js';
import { ID3_REGISTRATION_DESCRIPTOR } from '../lib/ts.js';

const VIDEO = process.env.VIDEO ?? '/home/ubuntu/adena.mp4';
const META_PID = Number(process.env.META_PID ?? 0x102);
// DVR window: how many segments the playlist keeps live. ~10 × 2s ≈ 20s of buffer
// headroom so the player can sit well back from the live edge and ride out jitter.
const HLS_WINDOW = Number(process.env.HLS_WINDOW ?? 10);
const outDir = process.argv[2] ?? '/tmp/hls';
const name = process.argv[3] ?? 'hawkeye';
const log = (...a) => console.error('[hls-publish]', ...a);

const injector = new TsInjector({
  dataPid: META_PID,
  streamType: 0x15, // metadata carried in PES
  esDescriptor: ID3_REGISTRATION_DESCRIPTOR, // tag the stream as 'ID3 '
  wrapPayload: (raw) => buildId3(raw), // each frame -> one ID3 tag (PRIV)
});
const segmenter = new HlsSegmenter({ dir: outDir, name, windowSize: HLS_WINDOW });
injector.on('data', (d) => segmenter.feed(d));

// Sync-from-tipoff: the video file is trimmed to start at tip-off and the pose
// feed connects from=tipoff, so both begin at tip. Track each stream's elapsed-
// from-tip from a MONOTONIC signal that doesn't stop for dead balls — the video
// PTS (file position) and the pose capture wall-clock — and publish the delta so
// the player can show it (and later apply it as a render offset). Anchored to the
// first sample of each, captured at process start = this tip-off.
let tipCaptureTs = null;  // first pose capture ts seen (≈ tip)
let lastCaptureTs = null;

const tap = createFrameSource();
tap.on('open', () => log(`feed connected: ${tap.url}`));
tap.on('error', (err) => log(`feed error: ${err.message}`));

// Start the video encoder ONLY once the first pose frame is in hand, so video
// content-0 (tip-off) welds to data content-0 (tip-off). The injector welds each
// pose to the CURRENT video PTS as it drains; if ffmpeg ran ahead during the
// feed's connect+roster+first-frame latency, that first pose would weld to an
// already-advanced PTS and the data would trail the video by that gap (the ~11s
// startup skew). Gating the encoder on the first frame makes both begin together.
let ffmpeg = null;
function startFfmpeg() {
  // VIDEO_LOOP=0 plays the source once (from tip-off) and stops; the default loops.
  // Looping re-runs the ~9 min clip and drifts out of sync with the continuous pose feed.
  const LOOP = (process.env.VIDEO_LOOP ?? '1') !== '0' ? ['-stream_loop', '-1'] : [];
  ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-re', ...LOOP, '-i', VIDEO,
    '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-pat_period', '0.2', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  ffmpeg.stdout.pipe(injector);
  ffmpeg.on('exit', (code) => { log(`ffmpeg exited (${code})`); shutdown(); });
  log(`writing HLS to ${outDir}/${name}.m3u8 (metadata PID 0x${META_PID.toString(16)})`);
}

tap.on('frame', (f) => {
  injector.pushFrame(f.raw);
  if (f.captureTs) {
    if (tipCaptureTs == null) tipCaptureTs = f.captureTs;
    lastCaptureTs = f.captureTs;
  }
  if (!ffmpeg) { log('first pose frame in hand — starting tip-aligned video'); startFfmpeg(); }
});
await tap.start();

const SYNC_PATH = path.join(outDir, 'sync.json');
function writeSync() {
  const vpts = injector.lastVideoPts;
  const tipVideoPts = injector.firstVideoPts; // exact tip anchor (ffmpeg's first PTS)
  const videoFromTip = tipVideoPts != null ? (vpts - tipVideoPts) / 90000 : null;
  const dataFromTip = (tipCaptureTs != null && lastCaptureTs != null)
    ? (lastCaptureTs - tipCaptureTs) / 1000 : null;
  const delta = (videoFromTip != null && dataFromTip != null)
    ? Number((videoFromTip - dataFromTip).toFixed(2)) : null;   // + = video ahead
  const snap = {
    updatedAt: Date.now(),
    videoFromTip: videoFromTip != null ? Number(videoFromTip.toFixed(2)) : null,
    dataFromTip: dataFromTip != null ? Number(dataFromTip.toFixed(2)) : null,
    delta,
  };
  try { fs.writeFileSync(SYNC_PATH, JSON.stringify(snap)); } catch (e) { log(`sync: ${e.message}`); }
}
const syncTimer = setInterval(writeSync, 1000);

const statsTimer = setInterval(() => {
  log(`segments=${segmenter.seq} window=${segmenter.window.length} injected=${injector.injected} queue=${injector.pending.length}`);
}, 2000);

function shutdown() {
  clearInterval(statsTimer);
  clearInterval(syncTimer);
  tap.stop();
  try { ffmpeg?.kill('SIGTERM'); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
