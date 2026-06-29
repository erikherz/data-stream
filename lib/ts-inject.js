// TsInjector: a Transform that takes ffmpeg's MPEG-TS on input and emits the
// same TS with one extra elementary stream — a private-data PID carrying raw
// Hawkeye protobuf frames, time-stamped to the most recent video PTS.
//
// Design notes:
//  - We let ffmpeg own all video timing (PCR/PTS); we never re-encode video.
//  - PMT/video PIDs are auto-detected from the PAT/PMT so this survives ffmpeg
//    layout changes; defaults match ffmpeg's usual 0x1000 / 0x100.
//  - Frames are queued via pushFrame() and drained at each video frame boundary
//    (PUSI on the video PID), which keeps the data ~aligned with video and the
//    queue bounded under the normal 60 Hz-data / 30 fps-video ratio.

import { Transform } from 'node:stream';
import {
  TS_PACKET_SIZE,
  SYNC_BYTE,
  pidOf,
  pusiOf,
  parsePat,
  parsePmtVideoPid,
  patchPmt,
  readVideoPts,
  buildPes,
  packetizePes,
} from './ts.js';

export class TsInjector extends Transform {
  constructor({ dataPid = 0x101, streamType = 0x06, maxQueue = 240 } = {}) {
    super();
    this.dataPid = dataPid;
    this.streamType = streamType;
    this.maxQueue = maxQueue;
    this.pmtPid = 0x1000;
    this.videoPid = 0x100;
    this._patFound = false;
    this._videoFound = false;
    this.cc = 0;
    this.lastVideoPts = 0;
    this.leftover = Buffer.alloc(0);
    this.pending = [];
    this.injected = 0;
    this.dropped = 0;
  }

  // Enqueue a raw protobuf Message (Uint8Array/Buffer) for embedding.
  pushFrame(raw) {
    if (this.pending.length >= this.maxQueue) {
      this.pending.shift();
      this.dropped++;
    }
    this.pending.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  }

  _drainInto(out) {
    while (this.pending.length) {
      const pes = buildPes(this.pending.shift(), this.lastVideoPts);
      const r = packetizePes(this.dataPid, pes, this.cc);
      this.cc = r.cc;
      for (const p of r.packets) out.push(p);
      this.injected++;
    }
  }

  _transform(chunk, _enc, cb) {
    const buf = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    const out = [];
    let i = 0;
    while (i + TS_PACKET_SIZE <= buf.length) {
      if (buf[i] !== SYNC_BYTE) {
        i++; // resync on garbage
        continue;
      }
      const pkt = buf.subarray(i, i + TS_PACKET_SIZE);
      i += TS_PACKET_SIZE;
      const pid = pidOf(pkt);
      const pusi = pusiOf(pkt);

      if (pid === 0 && pusi && !this._patFound) {
        const progs = parsePat(pkt);
        if (progs.length) {
          this.pmtPid = progs[0].pmtPid;
          this._patFound = true;
        }
      }

      if (pid === this.pmtPid && pusi) {
        if (!this._videoFound) {
          const vpid = parsePmtVideoPid(pkt);
          if (vpid != null) {
            this.videoPid = vpid;
            this._videoFound = true;
          }
        }
        out.push(patchPmt(pkt, this.dataPid, this.streamType));
        continue;
      }

      out.push(Buffer.from(pkt));

      if (pid === this.videoPid && pusi) {
        const pts = readVideoPts(pkt);
        if (pts != null) this.lastVideoPts = pts;
        this._drainInto(out);
      }
    }
    this.leftover = buf.subarray(i);
    cb(null, out.length ? Buffer.concat(out) : Buffer.alloc(0));
  }
}
