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
import { DataTap } from '../lib/data-tap.js';
import { TsInjector } from '../lib/ts-inject.js';
import { HlsSegmenter } from '../lib/hls-segmenter.js';
import { buildId3 } from '../lib/id3.js';
import { ID3_REGISTRATION_DESCRIPTOR } from '../lib/ts.js';

const VIDEO = process.env.VIDEO ?? '/home/ubuntu/adena.mp4';
const META_PID = Number(process.env.META_PID ?? 0x102);
const outDir = process.argv[2] ?? '/tmp/hls';
const name = process.argv[3] ?? 'hawkeye';
const log = (...a) => console.error('[hls-publish]', ...a);

const injector = new TsInjector({
  dataPid: META_PID,
  streamType: 0x15, // metadata carried in PES
  esDescriptor: ID3_REGISTRATION_DESCRIPTOR, // tag the stream as 'ID3 '
  wrapPayload: (raw) => buildId3(raw), // each frame -> one ID3 tag (PRIV)
});
const segmenter = new HlsSegmenter({ dir: outDir, name });
injector.on('data', (d) => segmenter.feed(d));

const tap = new DataTap();
tap.on('open', () => log(`feed connected: ${tap.url}`));
tap.on('error', (err) => log(`feed error: ${err.message}`));
tap.on('frame', (f) => injector.pushFrame(f.raw));
await tap.start();

const ffmpeg = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error',
  '-re', '-stream_loop', '-1', '-i', VIDEO,
  '-an',
  '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23',
  '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
  '-force_key_frames', 'expr:gte(t,n_forced*2)',
  '-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-pat_period', '0.2', 'pipe:1',
], { stdio: ['ignore', 'pipe', 'inherit'] });

ffmpeg.stdout.pipe(injector);
log(`writing HLS to ${outDir}/${name}.m3u8 (metadata PID 0x${META_PID.toString(16)})`);

const statsTimer = setInterval(() => {
  log(`segments=${segmenter.seq} window=${segmenter.window.length} injected=${injector.injected} queue=${injector.pending.length}`);
}, 2000);

function shutdown() {
  clearInterval(statsTimer);
  tap.stop();
  try { ffmpeg.kill('SIGTERM'); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
ffmpeg.on('exit', (code) => { log(`ffmpeg exited (${code})`); shutdown(); });
