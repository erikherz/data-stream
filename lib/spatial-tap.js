// spatial-tap: SSE client for the experiencematters.cloud basketball pose feed.
//
// This is the spatial-feed analog of lib/data-tap.js (which taps the Hawkeye
// protobuf-over-WebSocket feed). Here the source is Server-Sent Events: a
// long-lived text/event-stream HTTP response carrying one JSON pose frame per
// event (~60 Hz), with an incrementing `id:` used for Last-Event-ID resume.
//
// The upstream URL is built exactly as the app's bundle builds it (function vT):
//   `${proxyBase}/api/trackingfeed/latest/${gameId}-${streamName}-?${query}`
//
// Each emitted 'frame' preserves the raw JSON text (`raw`) so a downstream muxer
// can re-embed the exact wire payload without a re-encode round-trip.

import { EventEmitter } from 'node:events';

export const SPATIAL_BASE = process.env.SPATIAL_BASE ?? 'https://experiencematters.cloud/replay';
export const SPATIAL_GAME = process.env.SPATIAL_GAME ?? '0042500405';
export const SPATIAL_STREAM = process.env.SPATIAL_STREAM ?? 'live.pose.clean';
export const SPATIAL_QUERY = process.env.SPATIAL_QUERY ?? 'from=tipoff&mode=metronome';

export function spatialUrl({ base = SPATIAL_BASE, game = SPATIAL_GAME, stream = SPATIAL_STREAM, query = SPATIAL_QUERY } = {}) {
  const q = query ? `?${query}` : '';
  return `${base}/api/trackingfeed/latest/${game}-${stream}-${q}`;
}

export const DEFAULT_SPATIAL_URL = spatialUrl();

// Pull the players + ball out of a pose payload (samples.people / samples.ball).
export function summarizeFrame(payload) {
  const s = payload?.samples ?? {};
  const people = Array.isArray(s.people) ? s.people.length : 0;
  const ball = Array.isArray(s.ball) && s.ball[0]?.pos ? s.ball[0].pos : null;
  return { people, ball };
}

export class SpatialTap extends EventEmitter {
  constructor({ url = DEFAULT_SPATIAL_URL, reconnectMs = 1500 } = {}) {
    super();
    this.url = url;
    this.reconnectMs = reconnectMs;
    this.lastEventId = null;
    this._closed = false;
    this._controller = null;
  }

  // Events: 'open' (url), 'frame' ({frameId, id, payload, envelope, raw}),
  //         'error' (Error), 'parseError' (Error, rawText), 'close'.
  async start() {
    this._connect();
    return this;
  }

  stop() {
    this._closed = true;
    try { this._controller?.abort(); } catch { /* ignore */ }
    this.emit('close');
  }

  async _connect() {
    if (this._closed) return;
    const controller = new AbortController();
    this._controller = controller;
    const headers = { Accept: 'text/event-stream' };
    // Replay feed: do NOT resume via Last-Event-ID. After the metronome replay
    // ends, resuming past its last id yields an empty stream (endless dry
    // reconnect). Reconnecting without it restarts from tipoff, i.e. loops.
    try {
      const res = await fetch(this.url, { headers, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      this.emit('open', this.url);
      await this._readStream(res.body);
    } catch (err) {
      if (!this._closed) this.emit('error', err);
    }
    if (!this._closed) setTimeout(() => this._connect(), this.reconnectMs); // resume via Last-Event-ID
  }

  async _readStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let eventId = null;
    const dataLines = [];

    const dispatch = () => {
      if (!dataLines.length) return;
      const raw = dataLines.join('\n');
      dataLines.length = 0;
      if (raw === '') return;
      if (eventId != null) this.lastEventId = eventId;
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { this.emit('parseError', e, raw); eventId = null; return; }
      const payload = msg.payload ?? msg;
      this.emit('frame', {
        frameId: payload?.sequences?.frame ?? payload?.feedNumber?.frame ?? null,
        id: eventId,
        payload,
        envelope: msg, // full message incl. pipeline latency stamps
        raw,
      });
      eventId = null;
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') { dispatch(); continue; } // blank line terminates an event
        if (line.startsWith(':')) continue; // comment / keep-alive
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let val = colon < 0 ? '' : line.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'data') dataLines.push(val);
        else if (field === 'id') eventId = val;
        else if (field === 'retry') { const n = Number(val); if (!Number.isNaN(n)) this.reconnectMs = n; }
      }
    }
  }
}
