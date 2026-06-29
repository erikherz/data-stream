#!/usr/bin/env node
// rtmp-publish: the Phase-2 live publisher.
//
// ffmpeg(adena.mp4 -> FLV) -> forward tags over RTMP to Node-Media-Server, and
// interleave onHawkeye data(18) messages from the live feed, timestamped to the
// current video clock. NMS relays both to its http-flv subscribers.
//
// Usage: node bin/rtmp-publish.js [app=live] [stream=hawkeye]

import { spawn } from 'node:child_process';
import { DataTap } from '../lib/data-tap.js';
import { RtmpPublisher } from '../lib/rtmp-publish.js';
import { FlvDemux, FLV_TAG_VIDEO } from '../lib/flv.js';

const VIDEO = process.env.VIDEO ?? '/home/ubuntu/adena.mp4';
const app = process.argv[2] ?? 'live';
const stream = process.argv[3] ?? 'hawkeye';
const log = (...a) => console.error('[rtmp-publish]', ...a);

const pub = new RtmpPublisher({ host: '127.0.0.1', port: 1935, app, stream });
const demux = new FlvDemux();
const pending = [];
let lastVideoTs = 0;
let ffmpeg = null;

const tap = new DataTap();
tap.on('open', () => log(`feed connected: ${tap.url}`));
tap.on('error', (err) => log(`feed error: ${err.message}`));
tap.on('frame', (f) => {
  if (pending.length > 240) pending.shift();
  pending.push(f.raw);
});

pub.on('error', (e) => { log(`rtmp error: ${e.message}`); shutdown(); });
pub.on('close', () => { log('rtmp closed'); shutdown(); });

pub.on('ready', async () => {
  log(`published rtmp://127.0.0.1/${app}/${stream}; starting ffmpeg + feed`);
  await tap.start();
  ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-re', '-stream_loop', '-1', '-i', VIDEO,
    '-an', '-c:v', 'copy',
    '-f', 'flv', '-flvflags', 'no_duration_filesize', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });

  ffmpeg.stdout.on('data', (chunk) => {
    for (const tag of demux.feed(chunk)) {
      pub.forwardTag(tag);
      if (tag.type === FLV_TAG_VIDEO) {
        lastVideoTs = tag.timestamp;
        while (pending.length) pub.sendHawkeye(pending.shift(), lastVideoTs);
      }
    }
  });
  ffmpeg.on('exit', (code) => { log(`ffmpeg exited (${code})`); shutdown(); });
});

const statsTimer = setInterval(() => {
  log(`dataSent=${pub.dataSent} queue=${pending.length} lastVideoTs=${lastVideoTs}ms`);
}, 2000);

function shutdown() {
  clearInterval(statsTimer);
  tap.stop();
  try { ffmpeg?.kill('SIGTERM'); } catch { /* ignore */ }
  pub.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

pub.start();
log(`connecting to rtmp://127.0.0.1:1935/${app} …`);
