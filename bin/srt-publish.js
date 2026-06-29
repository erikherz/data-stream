#!/usr/bin/env node
// srt-publish: the Phase-1 live publisher.
//
// Pipeline:  ffmpeg(adena.mp4 -> MPEG-TS video)  ->  TsInjector(+data PID from
// the live Hawkeye feed)  ->  stdout.
//
// stdout is the muxed TS; pipe it into a dumb SRT sender, e.g.:
//   node bin/srt-publish.js | srt-live-transmit file://con "srt://:9000?mode=listener"
// or capture it for inspection:
//   node bin/srt-publish.js > live.ts
//
// All logging goes to stderr so it never corrupts the TS on stdout.

import { spawn } from 'node:child_process';
import { DataTap } from '../lib/data-tap.js';
import { TsInjector } from '../lib/ts-inject.js';

const VIDEO = process.env.VIDEO ?? '/home/ubuntu/adena.mp4';
// 0x102, not 0x101: with audio enabled ffmpeg puts AAC on 0x101, so the data
// stream must use the next free PID to avoid colliding with it.
const DATA_PID = Number(process.env.DATA_PID ?? 0x102);

const log = (...a) => console.error('[srt-publish]', ...a);

const ffmpeg = spawn(
  'ffmpeg',
  [
    '-hide_banner', '-loglevel', 'error',
    '-re', '-stream_loop', '-1', '-i', VIDEO,
    '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
    '-pat_period', '0.2',
    '-mpegts_flags', '+resend_headers',
    '-flush_packets', '1',
    '-f', 'mpegts', 'pipe:1',
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);

const injector = new TsInjector({ dataPid: DATA_PID });
ffmpeg.stdout.pipe(injector).pipe(process.stdout);

const tap = new DataTap();
tap.on('open', () => log(`feed connected: ${tap.url}`));
tap.on('error', (err) => log(`feed error: ${err.message}`));
tap.on('frame', (f) => injector.pushFrame(f.raw));
await tap.start();

const statsTimer = setInterval(() => {
  log(`injected=${injector.injected} dropped=${injector.dropped} queue=${injector.pending.length} videoPid=0x${injector.videoPid.toString(16)} pmtPid=0x${injector.pmtPid.toString(16)}`);
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
