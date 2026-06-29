#!/usr/bin/env node
// tap-stats: confirm the shared data-tap works against the live feed.
//
// Usage: node bin/tap-stats.js [durationSeconds=10]
// Prints the StreamMeta, then measured frame rate / size / bitrate.

import { DataTap } from '../lib/data-tap.js';

const durationS = Number(process.argv[2] ?? 10);
const tap = new DataTap();

let frames = 0;
let bytes = 0;
let firstFrameAt = 0;

tap.on('open', () => console.error(`connected: ${tap.url}`));
tap.on('error', (err) => console.error(`tap error: ${err.message}`));

tap.on('meta', (m, raw) => {
  const court = m.courtDimensions;
  console.log(
    'META',
    JSON.stringify({
      streamId: m.streamId,
      venue: m.venue,
      home: m.homeTeam,
      away: m.awayTeam,
      sampleRateHz: m.sampleRateHz,
      jointCount: m.jointCount,
      court: court ? { x: court.x, y: court.y, z: court.z } : null,
    }),
    `(${raw.length} B)`,
  );
});

tap.on('frame', (f) => {
  if (!firstFrameAt) firstFrameAt = Date.now();
  frames += 1;
  bytes += f.raw.length;
});

await tap.start();

setTimeout(() => {
  if (!frames) {
    console.error('no frames received');
    process.exit(1);
  }
  const dt = (Date.now() - firstFrameAt) / 1000;
  const fps = frames / dt;
  const avg = bytes / frames;
  const mbps = (bytes * 8) / dt / 1e6;
  console.log(
    `frames=${frames} over ${dt.toFixed(2)}s => ${fps.toFixed(1)} fps; ` +
      `avg ${avg.toFixed(0)} B/frame; ~${mbps.toFixed(2)} Mbps`,
  );
  tap.stop();
  process.exit(0);
}, durationS * 1000);
