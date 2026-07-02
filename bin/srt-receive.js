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
import { TsInjector } from '../lib/ts-inject.js';
import { HlsSegmenter } from '../lib/hls-segmenter.js';
import { KlvTsSource } from '../lib/klv-ts-source.js';
import { buildId3 } from '../lib/id3.js';
import { ID3_REGISTRATION_DESCRIPTOR } from '../lib/ts.js';

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
const klv = new KlvTsSource();
klv.on('frame', (raw) => injector.pushFrame(raw));

// Tee the source TS to both consumers. Guard writes: if ffmpeg dies we still
// want the process to exit cleanly rather than throw EPIPE.
srt.stdout.pipe(ffmpeg.stdin).on('error', (e) => log(`ffmpeg stdin: ${e.message}`));
srt.stdout.pipe(klv);

log(`listening ${SRT_URL}`);
log(`writing HLS to ${outDir}/${name}.m3u8 (metadata PID 0x${META_PID.toString(16)})`);

const statsTimer = setInterval(() => {
  log(`segments=${segmenter.seq} window=${segmenter.window.length} ` +
      `klv=${klv.frames} klvErr=${klv.errors} injected=${injector.injected} ` +
      `queue=${injector.pending.length}`);
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
