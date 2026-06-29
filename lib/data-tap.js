// data-tap: the single shared source for every protocol muxer.
//
// Connects to the simulated Hawkeye feed (binary protobuf over WebSocket),
// decodes the envelope, and re-emits a clean stream of frames. The original
// protobuf bytes are preserved on every frame as `raw` so downstream muxers can
// re-embed the exact wire payload into a container (TS / FLV / ID3) without a
// re-encode round-trip.

import protobuf from 'protobufjs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROTO_PATH = join(__dirname, '..', 'vendor', 'tracking.proto');
export const DEFAULT_FEED_URL = process.env.HAWKEYE_FEED ?? 'wss://brian.moqcdn.net/feed';

// protobufjs returns Long objects for 64-bit fields; coerce to a JS number.
export const toNum = (v) =>
  v == null ? 0 : typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);

let cachedMessageType = null;

// Load (and cache) the top-level `Message` type from the vendored .proto.
export async function loadMessageType(protoPath = PROTO_PATH) {
  if (cachedMessageType && protoPath === PROTO_PATH) return cachedMessageType;
  const root = await protobuf.load(protoPath);
  const Message = root.lookupType('hawkeye.tracking.v1.Message');
  if (protoPath === PROTO_PATH) cachedMessageType = Message;
  return Message;
}

export class DataTap extends EventEmitter {
  constructor({ url = DEFAULT_FEED_URL, reconnectMs = 1500 } = {}) {
    super();
    this.url = url;
    this.reconnectMs = reconnectMs;
    this.Message = null;
    this.ws = null;
    this.meta = null;
    this._closed = false;
  }

  // Events: 'open', 'meta' (StreamMeta, raw), 'frame' ({frameId, captureTs, frame, raw}),
  //         'close', 'error' (Error).
  async start() {
    this.Message = await loadMessageType();
    this._connect();
    return this;
  }

  _connect() {
    if (this._closed) return;
    // Node >= 22 ships a global WebSocket — no extra dependency needed.
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => this.emit('open');
    ws.onerror = (ev) => {
      this.emit('error', ev?.error ?? new Error('WebSocket error'));
      try { ws.close(); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      this.emit('close');
      if (!this._closed) setTimeout(() => this._connect(), this.reconnectMs);
    };
    ws.onmessage = (ev) => {
      const raw = new Uint8Array(ev.data);
      let msg;
      try {
        msg = this.Message.decode(raw);
      } catch (err) {
        this.emit('error', err);
        return;
      }
      if (msg.meta) {
        this.meta = msg.meta;
        this.emit('meta', msg.meta, raw);
      } else if (msg.frame) {
        this.emit('frame', {
          frameId: toNum(msg.frame.frameId),
          captureTs: toNum(msg.frame.captureTimestampMs),
          frame: msg.frame,
          raw,
        });
      }
    };
  }

  stop() {
    this._closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
