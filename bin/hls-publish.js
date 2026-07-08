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

// Sync-from-tipoff: the video file is trimmed to the VISUAL tip-off, but the pose
// feed's from=tipoff marker begins DATA_OFFSET_S seconds earlier (its tip-off lead-
// in), so a naive wall-clock weld leaves the data trailing the video by that gap.
// Fix: pull the feed, DISCARD the pre-tip lead-in, and start ffmpeg only once the
// data has advanced past the offset — so the video's first frame (the visual tip)
// welds to the data's tip. All this timing lives here in the injector path; ffmpeg
// owns none of it, so no gstreamer needed. DATA_OFFSET_S is the tuning dial.
const DATA_OFFSET_S = Number(process.env.DATA_OFFSET_S ?? 11);
let tipCaptureTs = null;   // first pose capture ts (feed start ≈ visual tip − DATA_OFFSET_S)
let dataAnchorTs = null;   // capture ts of the frame injection begins on (≈ visual tip)
let lastCaptureTs = null;

const tap = createFrameSource();
tap.on('open', () => log(`feed connected: ${tap.url}`));
tap.on('error', (err) => log(`feed error: ${err.message}`));

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
  if (f.captureTs) {
    if (tipCaptureTs == null) tipCaptureTs = f.captureTs;
    lastCaptureTs = f.captureTs;
  }
  // Hold off (and discard the pre-tip lead-in) until the feed has played through
  // the offset window. The frame that crosses it ≈ the video's visual tip, so
  // starting ffmpeg here welds video-tip to data-tip.
  if (!ffmpeg) {
    const buffered = (tipCaptureTs != null && f.captureTs) ? (f.captureTs - tipCaptureTs) / 1000 : 0;
    if (buffered < DATA_OFFSET_S) return; // still in the lead-in — drop it
    dataAnchorTs = f.captureTs;
    log(`data buffered ${buffered.toFixed(1)}s ≥ ${DATA_OFFSET_S}s offset — starting tip-aligned video`);
    startFfmpeg();
  }
  injector.pushFrame(f.raw);
});
await tap.start();

const SYNC_PATH = path.join(outDir, 'sync.json');
function writeSync() {
  const vpts = injector.lastVideoPts;
  const tipVideoPts = injector.firstVideoPts; // exact tip anchor (ffmpeg's first PTS)
  const videoFromTip = tipVideoPts != null ? (vpts - tipVideoPts) / 90000 : null;
  const dataFromTip = (dataAnchorTs != null && lastCaptureTs != null)
    ? (lastCaptureTs - dataAnchorTs) / 1000 : null;
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
