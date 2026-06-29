#!/usr/bin/env node
// control-server: a tiny HTTP control plane for the demo. Lets the player page
// start/stop the whole processing pipeline (HLS publisher + SRT gateway push +
// RTMP publish to NMS) with one button. Binds to localhost; nginx proxies
// /api/* to it.
//
//   GET  /api/status -> { hls, srt, rtmp, processing }
//   POST /api/start  -> start HLS + SRT + RTMP, returns status
//   POST /api/stop   -> stop them, returns status

import http from 'node:http';
import fs from 'node:fs';
import { exec, spawn } from 'node:child_process';

const PORT = Number(process.env.CONTROL_PORT ?? 8090);
const REPO = '/home/ubuntu/hawkeye-data-stream';
const VIDEO = process.env.VIDEO ?? '/home/ubuntu/capture_12.mp4';
const HLS_DIR = '/var/www/html/hls';
const GW = 'srt://54.69.119.129:20887?mode=caller&latency=200';
const RTMP_APP = 'live';
const RTMP_NAME = 'hawkeye';

const HLS_CMD = `cd ${REPO} && rm -f ${HLS_DIR}/* ; VIDEO=${VIDEO} exec node bin/hls-publish.js ${HLS_DIR} hawkeye`;
const SRT_CMD = `cd ${REPO} && VIDEO=${VIDEO} node bin/srt-publish.js 2>>/tmp/srt-push.log | srt-live-transmit -q file://con "${GW}"`;
const RTMP_CMD = `cd ${REPO} && VIDEO=${VIDEO} exec node bin/rtmp-publish.js ${RTMP_APP} ${RTMP_NAME}`;

const sh = (cmd) => new Promise((r) => exec(cmd, (e, so) => r((so || '').trim())));

function launch(cmd, log) {
  const out = fs.openSync(log, 'a');
  const child = spawn('setsid', ['bash', '-c', cmd], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
}

// NB: the [b] bracket trick keeps the pattern from matching this very pgrep/pkill
// command line (which would otherwise self-match and skew the result).
async function status() {
  const hls = (await sh("pgrep -f '[b]in/hls-publish.js' || true")) !== '';
  const srt = (await sh("pgrep -f '[b]in/srt-publish.js' || true")) !== '';
  const rtmp = (await sh("pgrep -f '[b]in/rtmp-publish.js' || true")) !== '';
  return { hls, srt, rtmp, processing: hls || srt || rtmp };
}

// RTMP publish needs the local Node-Media-Server listening on :1935; bring it up
// if it isn't already (start-nms.sh is idempotent and detaches itself).
async function ensureNms() {
  const up = (await sh("ss -ltn | grep -q ':1935' && echo up || true")) === 'up';
  if (!up) { await sh(`bash ${REPO}/scripts/start-nms.sh >/tmp/nms-ctl.log 2>&1`); }
}

async function start() {
  const s = await status();
  if (!s.hls) launch(HLS_CMD, '/tmp/hls.log');
  if (!s.srt) launch(SRT_CMD, '/tmp/srt-push.log');
  if (!s.rtmp) { await ensureNms(); launch(RTMP_CMD, '/tmp/pub2.log'); }
}

// Stop the generators and the push sender (port 20887). Leave the SRT pull-loop
// and NMS (shared infrastructure) running.
async function stop() {
  await sh("pkill -f '[b]in/hls-publish.js'; pkill -f '[b]in/srt-publish.js'; pkill -f '[b]in/rtmp-publish.js'; pkill -f '[2]0887'; true");
}

http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.url === '/api/status') {
      res.end(JSON.stringify(await status()));
    } else if (req.url === '/api/start' && req.method === 'POST') {
      await start();
      await new Promise((r) => setTimeout(r, 1500));
      res.end(JSON.stringify(await status()));
    } else if (req.url === '/api/stop' && req.method === 'POST') {
      await stop();
      await new Promise((r) => setTimeout(r, 800));
      res.end(JSON.stringify(await status()));
    } else {
      res.statusCode = 404;
      res.end('{"error":"not found"}');
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, '127.0.0.1', () => console.error(`control-server on 127.0.0.1:${PORT}`));
