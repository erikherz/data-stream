#!/usr/bin/env node
// control-server: a tiny HTTP control plane for the demo. Lets the player page
// start/stop the processing pipeline (HLS publisher + SRT gateway push) with a
// button. Binds to localhost; nginx proxies /api/* to it.
//
//   GET  /api/status -> { hls, srt, processing }
//   POST /api/start  -> start HLS + SRT push, returns status
//   POST /api/stop   -> stop them, returns status

import http from 'node:http';
import fs from 'node:fs';
import { exec, spawn } from 'node:child_process';

const PORT = Number(process.env.CONTROL_PORT ?? 8090);
const REPO = '/home/ubuntu/hawkeye-data-stream';
const VIDEO = process.env.VIDEO ?? '/home/ubuntu/capture_12.mp4';
const HLS_DIR = '/var/www/html/hls';
const GW = 'srt://54.69.119.129:20887?mode=caller&latency=200';

const HLS_CMD = `cd ${REPO} && rm -f ${HLS_DIR}/* ; VIDEO=${VIDEO} exec node bin/hls-publish.js ${HLS_DIR} hawkeye`;
const SRT_CMD = `cd ${REPO} && VIDEO=${VIDEO} node bin/srt-publish.js 2>>/tmp/srt-push.log | srt-live-transmit -q file://con "${GW}"`;

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
  return { hls, srt, processing: hls || srt };
}

async function start() {
  const s = await status();
  if (!s.hls) launch(HLS_CMD, '/tmp/hls.log');
  if (!s.srt) launch(SRT_CMD, '/tmp/srt-push.log');
}

// Stop the generators and the push sender (port 20887), leaving any pull-loop alone.
async function stop() {
  await sh("pkill -f '[b]in/hls-publish.js'; pkill -f '[b]in/srt-publish.js'; pkill -f '[2]0887'; true");
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
