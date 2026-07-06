#!/usr/bin/env node
// control-server: a tiny HTTP control plane for the demo. Lets the player page
// start/stop the whole processing pipeline (HLS publisher + SRT gateway push +
// RTMP publish to NMS) with one button. Binds to localhost; nginx proxies
// /api/* to it.
//
//   GET  /api/status -> { hls, srt, rtmp, processing }
//   POST /api/start   -> start HLS + SRT + RTMP, returns status
//   POST /api/stop    -> stop them, returns status
//   POST /api/restart -> stop then start (re-align video+data to tip-off)

import http from 'node:http';
import fs from 'node:fs';
import { exec, spawn } from 'node:child_process';

const PORT = Number(process.env.CONTROL_PORT ?? 8090);
// These four default to the luke.moqcdn.net deployment. A second deployment on a
// shared box (e.g. origin.moqcdn.net, coexisting with another app) overrides them
// via the systemd unit so one codebase serves both hosts:
//   REPO     working copy dir            HLS_DIR  webroot hls dir (wiped on start)
//   SRT_GW   where srt-publish is sent   SRT_KILL substring identifying the SRT
//            (a shared caller gateway on          sender proc to kill on stop
//            luke; a local listener on origin,    (must NOT match the snapshot
//            self-contained, so it can't step      puller — luke: the gw port,
//            on the gateway edge/luke share)        origin: 'mode=listener')
const REPO = process.env.REPO ?? '/home/ubuntu/hawkeye-data-stream';
const VIDEO = process.env.VIDEO ?? '/home/ubuntu/capture_03.mp4';
const HLS_DIR = process.env.HLS_DIR ?? '/var/www/html/hls';
const GW = process.env.SRT_GW ?? 'srt://54.69.119.129:20887?mode=caller&latency=200';
const SRT_KILL = process.env.SRT_KILL ?? '20887';
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

// Stop the generators and the SRT push sender (identified by SRT_KILL). Leave the
// SRT pull-loop and NMS (shared infrastructure) running. The [b]racket trick keeps
// each pattern from self-matching the pkill command line; we build the same guard
// for SRT_KILL so it works whether it's a port ('20887') or 'mode=listener'.
async function stop() {
  const srtKill = `[${SRT_KILL[0]}]${SRT_KILL.slice(1)}`;
  await sh(`pkill -f '[b]in/hls-publish.js'; pkill -f '[b]in/srt-publish.js'; pkill -f '[b]in/rtmp-publish.js'; pkill -f '${srtKill}'; true`);
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
    } else if (req.url === '/api/restart' && req.method === 'POST') {
      // Re-align: kill the publishers and relaunch them, so the video restarts from
      // tip-off and the pose tap reconnects from tipoff at the same wall-clock moment.
      await stop();
      await new Promise((r) => setTimeout(r, 1000));
      await start();
      await new Promise((r) => setTimeout(r, 1500));
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
