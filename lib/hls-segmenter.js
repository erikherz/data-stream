// A small live HLS segmenter. It consumes the injected MPEG-TS (video + the ID3
// metadata PID), splits into segments at video keyframes, and writes a sliding-
// window playlist. Because the ID3 metadata is already interleaved into the TS
// (PTS-synced upstream), each Hawkeye frame lands in the segment that covers its
// timestamp automatically — no per-segment alignment logic needed here.

import fs from 'node:fs';
import path from 'node:path';
import {
  TS_PACKET_SIZE, SYNC_BYTE, pidOf, pusiOf,
  readVideoPts, hasRandomAccess, parsePat, parsePmtVideoPid,
} from './ts.js';

export class HlsSegmenter {
  constructor({ dir, name = 'stream', windowSize = 6, minSegSec = 1.0 } = {}) {
    this.dir = dir;
    this.name = name;
    this.windowSize = windowSize;
    this.minSegTicks = minSegSec * 90000;
    this.leftover = Buffer.alloc(0);
    this.pmtPid = 0x1000;
    this.videoPid = null;
    this.lastPat = null;
    this.lastPmt = null;
    this.cur = [];
    this.segStartPts = null;
    this.seq = 0;
    this.window = [];
    this.maxDur = 1;
    fs.mkdirSync(dir, { recursive: true });
  }

  feed(chunk) {
    const buf = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    let i = 0;
    while (i + TS_PACKET_SIZE <= buf.length) {
      if (buf[i] !== SYNC_BYTE) { i++; continue; }
      this._packet(Buffer.from(buf.subarray(i, i + TS_PACKET_SIZE)));
      i += TS_PACKET_SIZE;
    }
    this.leftover = buf.subarray(i);
  }

  _packet(pkt) {
    const pid = pidOf(pkt);
    if (pid === 0) {
      this.lastPat = pkt;
      const progs = parsePat(pkt);
      if (progs.length) this.pmtPid = progs[0].pmtPid;
      return; // PAT is prepended to each segment, not stored in the body
    }
    if (pid === this.pmtPid) {
      this.lastPmt = pkt;
      if (this.videoPid == null) this.videoPid = parsePmtVideoPid(pkt);
      return; // ditto for PMT
    }

    if (pid === this.videoPid && pusiOf(pkt)) {
      const pts = readVideoPts(pkt);
      if (pts != null && hasRandomAccess(pkt) && this.lastPat && this.lastPmt) {
        if (this.cur.length && this.segStartPts != null && pts - this.segStartPts >= this.minSegTicks) {
          this._closeSegment(pts);
        }
        if (this.segStartPts == null || this.cur.length === 0) this.segStartPts = pts;
      }
    }

    if (this.segStartPts != null) this.cur.push(pkt); // drop any leading junk before first keyframe
  }

  _closeSegment(endPts) {
    const dur = Math.max(0.001, (endPts - this.segStartPts) / 90000);
    const file = `${this.name}${String(this.seq).padStart(5, '0')}.ts`;
    fs.writeFileSync(path.join(this.dir, file), Buffer.concat([this.lastPat, this.lastPmt, ...this.cur]));
    this.window.push({ seq: this.seq, file, dur });
    this.maxDur = Math.max(this.maxDur, dur);
    this.seq++;
    this.cur = [];
    while (this.window.length > this.windowSize) {
      const old = this.window.shift();
      fs.rmSync(path.join(this.dir, old.file), { force: true });
    }
    this._writePlaylist();
  }

  _writePlaylist() {
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(this.maxDur)}`,
      `#EXT-X-MEDIA-SEQUENCE:${this.window[0].seq}`,
    ];
    for (const s of this.window) {
      lines.push(`#EXTINF:${s.dur.toFixed(3)},`, s.file);
    }
    const tmp = path.join(this.dir, `.${this.name}.m3u8.tmp`);
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, path.join(this.dir, `${this.name}.m3u8`));
  }
}
