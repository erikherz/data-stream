#!/usr/bin/env node
// srt-receive: the companion "rebroadcasting station".
//
// It ingests the SRT MPEG-TS produced by the main publisher (H.264 + AAC + a
// synchronous-KLV data stream) and republishes it as HLS with the Hawkeye
// tracking data carried as ID3 timed-metadata — exactly the shape the existing
// player expects — so a remote, view-only client can watch the video and the
// synced skeletons without any RTMP/SRT origination of its own.
//
// Pipeline:
//   srt-live-transmit(listener)            raw source TS (verbatim bytes)
//        │
//        ├─▶ ffmpeg  (re-encode video + audio to a clean 2s-GOP TS, NO data)
//        │        └─▶ TsInjector(+ID3 metadata PID) ─▶ HlsSegmenter ─▶ outDir
//        │
//        └─▶ KlvTsSource (parse TS, unwrap KLV) ─▶ injector.pushFrame(raw)
//
// The KLV frames arrive on the same real-time-paced stream as the video, so
// stamping each with the current output video PTS keeps data↔video skew small —
// the same design the live publisher (bin/hls-publish.js) uses.
//
// Usage: node bin/srt-receive.js [outDir=/var/www/html/hls] [name=receiver]
// Env:
//   SRT_PORT   listener UDP port (default 9000)
//   SRT_URL    full srt:// URL, overrides SRT_PORT (e.g. a caller-mode pull)
//   SRT_LATENCY  SRT latency ms (default 200)
//
// All logging goes to stderr.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TsInjector } from '../lib/ts-inject.js';
import { HlsSegmenter } from '../lib/hls-segmenter.js';
import { KlvTsSource } from '../lib/klv-ts-source.js';
import { buildId3 } from '../lib/id3.js';
import { ID3_REGISTRATION_DESCRIPTOR } from '../lib/ts.js';
import { loadMessageType, toNum } from '../lib/data-tap.js';

const outDir = process.argv[2] ?? '/var/www/html/hls';
const name = process.argv[3] ?? 'receiver';
const META_PID = Number(process.env.META_PID ?? 0x102);
const SRT_PORT = Number(process.env.SRT_PORT ?? 9000);
const SRT_LATENCY = Number(process.env.SRT_LATENCY ?? 200);
const SRT_URL = process.env.SRT_URL
  ?? `srt://:${SRT_PORT}?mode=listener&latency=${SRT_LATENCY}`;

const log = (...a) => console.error('[srt-receive]', ...a);

// --- HLS output: inject ID3 metadata, segment at keyframes ---
const injector = new TsInjector({
  dataPid: META_PID,
  streamType: 0x15,                           // metadata carried in PES
  esDescriptor: ID3_REGISTRATION_DESCRIPTOR,  // tag the stream as 'ID3 '
  wrapPayload: (raw) => buildId3(raw),        // each frame -> one ID3 tag (PRIV)
});
const segmenter = new HlsSegmenter({ dir: outDir, name });
injector.on('data', (d) => segmenter.feed(d));

// --- SRT receiver: verbatim source TS on stdout ---
const srt = spawn('srt-live-transmit', ['-q', SRT_URL, 'file://con'],
  { stdio: ['ignore', 'pipe', 'inherit'] });

// --- video/audio path: re-encode to a clean, keyframe-aligned TS (no data) ---
const ffmpeg = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error',
  '-fflags', '+genpts', '-i', 'pipe:0',
  '-map', '0:v:0', '-map', '0:a:0?',          // video + audio if present
  '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
  '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23',
  '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
  '-force_key_frames', 'expr:gte(t,n_forced*2)',
  '-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-pat_period', '0.2', 'pipe:1',
], { stdio: ['pipe', 'pipe', 'inherit'] });

ffmpeg.stdout.pipe(injector);

// --- data path: pull KLV frames off the same source TS, re-inject as ID3 ---
// Alongside re-injection we decode each frame server-side to publish a live
// sync snapshot (receiver-sync.json): the authoritative, receiver-measured view
// of how the SRT source's data tracks its video — freshness, cadence, and the
// data↔video muxing backlog, measured here rather than in a browser after HLS
// buffering. Fields we can honestly measure at the transport:
//   latencyMs  source capture_timestamp_ms -> edge wall-clock (pipeline freshness)
//   fps/gap    KLV frame cadence + worst inter-frame gap (data continuity)
//   queue      injector backlog: frames waiting to be welded to the video PTS
//   videoPts   the output video PTS each frame is currently stamped to
//   game       decoded period/clock/score/people (proves content is readable)
const klv = new KlvTsSource();

let Message = null;
loadMessageType().then((M) => { Message = M; }).catch((e) => log(`proto load: ${e.message}`));

const SNAP_PATH = path.join(outDir, 'receiver-sync.json');
const arrivals = [];        // recent frame wall-clock arrival times (rolling)
let lastFrameAt = 0;        // wall-clock of the most recent KLV frame
let latencyMs = null;       // source capture -> edge receive (ms)
let game = null;            // last decoded game state

klv.on('frame', (raw) => {
  injector.pushFrame(raw);
  const now = Date.now();
  lastFrameAt = now;
  arrivals.push(now);
  if (arrivals.length > 240) arrivals.shift();
  if (!Message) return;
  try {
    const msg = Message.decode(raw);
    const f = msg.frame;
    if (!f) return;
    const capTs = toNum(f.captureTimestampMs);
    if (capTs > 0) latencyMs = now - capTs;
    const c = f.clock || {};
    game = {
      frameId: toNum(f.frameId),
      period: c.period ?? null,
      gameClock: c.gameClockSeconds != null ? Number(c.gameClockSeconds.toFixed(1)) : null,
      shotClock: c.shotClockSeconds != null ? Number(c.shotClockSeconds.toFixed(1)) : null,
      running: !!c.running,
      homeScore: f.homeScore ?? 0,
      awayScore: f.awayScore ?? 0,
      people: (f.people || []).length,
      ball: f.ball ? (f.ball.inPossession ? 'held' : 'loose') : null,
    };
  } catch { /* partial PES at stream join — ignore */ }
});

// Rolling cadence: frames-per-second and worst gap over the recent window.
function cadence() {
  const now = Date.now();
  const recent = arrivals.filter((t) => now - t <= 2000);
  const fps = recent.length / 2;
  let maxGapMs = 0;
  for (let i = 1; i < arrivals.length; i++) maxGapMs = Math.max(maxGapMs, arrivals[i] - arrivals[i - 1]);
  return { fps: Number(fps.toFixed(1)), maxGapMs };
}

function writeSnapshot() {
  const now = Date.now();
  const ageMs = lastFrameAt ? now - lastFrameAt : null;
  const { fps, maxGapMs } = cadence();
  const snap = {
    updatedAt: now,
    // "connected" once frames are flowing; "stalled" if none for >3s.
    source: (lastFrameAt && ageMs <= 3000) ? 'connected' : (lastFrameAt ? 'stalled' : 'waiting'),
    klvFrames: klv.frames,
    klvErrors: klv.errors,
    injected: injector.injected,
    segments: segmenter.seq,
    queue: injector.pending.length,
    videoPtsSec: injector.lastVideoPts != null ? Number((injector.lastVideoPts / 90000).toFixed(2)) : null,
    lastFrameAgeMs: ageMs,
    latencyMs,
    fps,
    maxGapMs,
    game,
  };
  try { fs.writeFileSync(SNAP_PATH, JSON.stringify(snap)); } catch (e) { log(`snapshot: ${e.message}`); }
}

// Tee the source TS to both consumers. Guard writes: if ffmpeg dies we still
// want the process to exit cleanly rather than throw EPIPE.
srt.stdout.pipe(ffmpeg.stdin).on('error', (e) => log(`ffmpeg stdin: ${e.message}`));
srt.stdout.pipe(klv);

log(`listening ${SRT_URL}`);
log(`writing HLS to ${outDir}/${name}.m3u8 (metadata PID 0x${META_PID.toString(16)})`);

const statsTimer = setInterval(() => {
  writeSnapshot();
  log(`segments=${segmenter.seq} window=${segmenter.window.length} ` +
      `klv=${klv.frames} klvErr=${klv.errors} injected=${injector.injected} ` +
      `queue=${injector.pending.length} lat=${latencyMs ?? '—'}ms`);
}, 2000);

function shutdown() {
  clearInterval(statsTimer);
  for (const p of [srt, ffmpeg]) { try { p.kill('SIGTERM'); } catch { /* ignore */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
srt.on('exit', (code) => { log(`srt-live-transmit exited (${code})`); shutdown(); });
ffmpeg.on('exit', (code) => { log(`ffmpeg exited (${code})`); shutdown(); });
