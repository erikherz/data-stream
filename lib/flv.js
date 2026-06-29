// FLV tag demuxer. Used twice: to read ffmpeg's `-f flv` output (so we can
// forward each tag as an RTMP message) and to read NMS's http-flv output back
// for verification. Feed bytes, get whole tags out.

const FLV_HEADER_SKIP = 9 + 4; // 9-byte FLV header + first PreviousTagSize(0)

export const FLV_TAG_AUDIO = 8;
export const FLV_TAG_VIDEO = 9;
export const FLV_TAG_SCRIPT = 18;

export class FlvDemux {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.headerDone = false;
  }

  // Returns an array of { type, timestamp, data } for whatever completed.
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    let p = 0;

    if (!this.headerDone) {
      if (this.buf.length < FLV_HEADER_SKIP) return out;
      p = FLV_HEADER_SKIP;
      this.headerDone = true;
    }

    while (this.buf.length - p >= 11) {
      const type = this.buf[p];
      const size = this.buf.readUIntBE(p + 1, 3);
      const ts =
        ((this.buf[p + 4] << 16) | (this.buf[p + 5] << 8) | this.buf[p + 6] | (this.buf[p + 7] << 24)) >>> 0;
      if (this.buf.length - p < 11 + size + 4) break; // wait for full tag + PreviousTagSize
      out.push({ type, timestamp: ts, data: Buffer.from(this.buf.subarray(p + 11, p + 11 + size)) });
      p += 11 + size + 4;
    }

    this.buf = this.buf.subarray(p);
    return out;
  }
}
