// KlvTsSource: a Writable that consumes an inbound MPEG-TS (as received over SRT
// from the main publisher) and emits the raw Hawkeye protobuf carried in its
// synchronous-KLV stream — one 'frame' event per KLV triplet.
//
// This is the receiver-side inverse of lib/ts-inject.js + lib/klv.js on the
// publisher: the publisher wraps each protobuf frame as a KLV triplet in a
// private-data PES (stream_type 0x06, 'KLVA' registration descriptor); here we
// locate that PID off the PMT, reassemble each PES, and klvUnwrap it back to the
// bytes the player already knows how to decode. The extracted frames are then
// re-injected as ID3 timed-metadata by bin/srt-receive.js so the unchanged HLS
// player can read them.
//
// An SRT pull joins mid-stream, so we never assume packet alignment on the first
// byte — we resync on the 0x47 sync byte like the rest of the pipeline.

import { Writable } from 'node:stream';
import {
  TS_PACKET_SIZE, SYNC_BYTE, pidOf, pusiOf, payloadStart,
  parsePat, parsePmtStreams,
} from './ts.js';
import { klvUnwrap } from './klv.js';

export class KlvTsSource extends Writable {
  constructor() {
    super();
    this.leftover = Buffer.alloc(0);
    this.pmtPid = null;
    this.klvPid = null;
    this.cur = null;      // accumulating PES payload buffers for the KLV PID
    this.frames = 0;
    this.errors = 0;
  }

  _write(chunk, _enc, cb) {
    const buf = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    let i = 0;
    while (i + TS_PACKET_SIZE <= buf.length) {
      if (buf[i] !== SYNC_BYTE) { i++; continue; } // resync on garbage
      this._packet(buf.subarray(i, i + TS_PACKET_SIZE));
      i += TS_PACKET_SIZE;
    }
    this.leftover = buf.subarray(i);
    cb();
  }

  _packet(pkt) {
    const pid = pidOf(pkt);
    const pusi = pusiOf(pkt);

    if (pid === 0 && pusi && this.pmtPid === null) {
      this.pmtPid = parsePat(pkt)[0]?.pmtPid ?? null;
      return;
    }
    if (pid === this.pmtPid && pusi) {
      // Re-read on every PMT: PIDs can shift if the publisher restarts mid-run.
      const klv = parsePmtStreams(pkt).find(
        (s) => s.streamType === 0x06 && (s.reg === 'KLVA' || s.reg === 'KLV'),
      );
      if (klv) this.klvPid = klv.pid;
      return;
    }
    if (this.klvPid == null || pid !== this.klvPid) return;

    const st = payloadStart(pkt);
    if (st < 0) return;
    if (pusi) {
      if (this.cur) this._flush(Buffer.concat(this.cur));
      const pes = pkt.subarray(st);
      // Skip the PES header: 6-byte start + 3 fixed + PES_header_data_length (pes[8]).
      const hdr = 9 + pes[8];
      this.cur = [Buffer.from(pes.subarray(hdr))];
    } else if (this.cur) {
      this.cur.push(Buffer.from(pkt.subarray(st)));
    }
  }

  _flush(pes) {
    try {
      const { value } = klvUnwrap(pes);
      if (value && value.length) {
        this.frames++;
        this.emit('frame', Buffer.from(value));
      }
    } catch {
      this.errors++; // partial/truncated PES at stream join — ignore, keep going
    }
  }

  // Flush any trailing PES when the input ends.
  _final(cb) {
    if (this.cur) { this._flush(Buffer.concat(this.cur)); this.cur = null; }
    cb();
  }
}
