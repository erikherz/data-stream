// frame-source: pick the frame source at runtime and expose ONE interface so the
// publishers don't care where frames come from.
//
//   SOURCE=hawkeye (default) -> DataTap: Hawkeye protobuf over WebSocket
//   SOURCE=spatial           -> SpatialTap + normalizer: experiencematters.cloud
//                               pose SSE, converted to the same protobuf Frame
//
// Both expose: .url, .on('open'|'frame'|'error'), .start(), .stop(), and every
// 'frame' carries { raw } = protobuf Message bytes ready to embed.

import { EventEmitter } from 'node:events';
import { DataTap } from './data-tap.js';
import { SpatialTap } from './spatial-tap.js';
import { makeSpatialNormalizer, tsMs } from './spatial-normalize.js';

export function createFrameSource({ source = process.env.SOURCE ?? 'hawkeye' } = {}) {
  if (source === 'spatial') return new SpatialFrameSource();
  return new DataTap(); // already the target interface, emits { raw }
}

// Wraps SpatialTap, normalizing each SSE pose payload into protobuf bytes so the
// rest of the pipeline sees exactly what the Hawkeye path produces.
class SpatialFrameSource extends EventEmitter {
  constructor() {
    super();
    this.tap = new SpatialTap();
    this.url = this.tap.url;
    this._norm = null;
  }

  async start() {
    this._norm = await makeSpatialNormalizer();
    this.tap.on('open', (u) => this.emit('open', u));
    this.tap.on('error', (e) => this.emit('error', e));
    this.tap.on('parseError', (e) => this.emit('error', e));
    this.tap.on('frame', (f) => {
      try {
        const raw = this._norm.normalize(f.payload);
        // captureTs: real capture wall-clock (time.timeUTC) — a monotonic
        // from-tip anchor for sync that, unlike the game clock, never stops.
        this.emit('frame', { raw, frameId: f.frameId, captureTs: tsMs(f.payload) });
      } catch (e) {
        this.emit('error', e);
      }
    });
    await this.tap.start();
    return this;
  }

  stop() {
    this.tap.stop();
  }
}
