// A minimal RTMP publish client. Does a simple handshake, connect/createStream/
// publish, then forwards FLV tags as RTMP audio/video/data messages and injects
// our own onHawkeye data(18) messages. Deliberately lean: we only parse enough
// of the server's replies (by scanning for status strings) to sequence the
// publish handshake; we never need to play back, so a full chunk reader isn't
// required.

import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { encode, encodeString, encodeLongString, encodeNumber, encodeNull } from './amf0.js';

const HANDSHAKE_SIZE = 1536;
const OUT_CHUNK_SIZE = 0x100000; // 1 MiB — every realistic message fits in one chunk

// RTMP message type ids
const TYPE_SET_CHUNK_SIZE = 1;
const TYPE_AUDIO = 8;
const TYPE_VIDEO = 9;
const TYPE_DATA = 18;
const TYPE_INVOKE = 20;

// chunk stream ids (all < 64 → 1-byte basic header)
const CSID_CONTROL = 2;
const CSID_INVOKE = 3;
const CSID_DATA = 4;
const CSID_AUDIO = 7;
const CSID_VIDEO = 6;

function writeMessage(csid, typeId, msgStreamId, timestamp, payload, chunkSize) {
  const ts = timestamp >>> 0;
  const ext = ts >= 0xffffff;
  const h = Buffer.alloc(12);
  h[0] = (0 << 6) | (csid & 0x3f); // fmt 0
  h.writeUIntBE(ext ? 0xffffff : ts, 1, 3);
  h.writeUIntBE(payload.length, 4, 3);
  h[7] = typeId;
  h.writeUInt32LE(msgStreamId, 8);
  const parts = [h];
  const extBuf = Buffer.alloc(4);
  extBuf.writeUInt32BE(ts, 0);
  if (ext) parts.push(extBuf);

  let off = Math.min(payload.length, chunkSize);
  parts.push(payload.subarray(0, off));
  while (off < payload.length) {
    parts.push(Buffer.from([(3 << 6) | (csid & 0x3f)])); // fmt 3 continuation
    if (ext) parts.push(extBuf);
    const n = Math.min(payload.length - off, chunkSize);
    parts.push(payload.subarray(off, off + n));
    off += n;
  }
  return Buffer.concat(parts);
}

export class RtmpPublisher extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 1935, app = 'live', stream = 'hawkeye' } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.app = app;
    this.stream = stream;
    this.streamId = 1; // NMS returns 1 for the first createStream
    this.chunkSize = OUT_CHUNK_SIZE;
    this.ready = false;
    this.sock = null;
    this._inbound = Buffer.alloc(0);
    this._sawConnect = false;
    this.dataSent = 0;
  }

  start() {
    this.sock = net.connect(this.port, this.host, () => this._handshake());
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('error', (e) => this.emit('error', e));
    this.sock.on('close', () => this.emit('close'));
    return this;
  }

  _handshake() {
    const c0 = Buffer.from([0x03]);
    const c1 = Buffer.concat([Buffer.alloc(8, 0), crypto.randomBytes(HANDSHAKE_SIZE - 8)]);
    this.sock.write(Buffer.concat([c0, c1]));
    this._hsState = 'await_s0s1s2';
  }

  _send(buf) { this.sock.write(buf); }

  _onData(chunk) {
    if (this._hsState === 'await_s0s1s2') {
      this._inbound = Buffer.concat([this._inbound, chunk]);
      if (this._inbound.length < 1 + HANDSHAKE_SIZE * 2) return;
      const s1 = this._inbound.subarray(1, 1 + HANDSHAKE_SIZE);
      this._send(s1); // C2 = echo S1 (simple handshake)
      const rest = this._inbound.subarray(1 + HANDSHAKE_SIZE * 2);
      this._inbound = Buffer.alloc(0);
      this._hsState = 'rtmp';
      this._afterHandshake();
      if (rest.length) this._scan(rest);
      return;
    }
    this._scan(chunk);
  }

  _afterHandshake() {
    // Declare our outgoing chunk size, then connect.
    this._send(writeMessage(CSID_CONTROL, TYPE_SET_CHUNK_SIZE, 0, 0,
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(this.chunkSize, 0); return b; })(), 128));
    const tcUrl = `rtmp://${this.host}:${this.port}/${this.app}`;
    const connect = encode('connect', 1, {
      app: this.app, type: 'nonprivate', flashVer: 'FMLE/3.0 (compatible; Hawkeye)',
      tcUrl, fpad: false, capabilities: 15, audioCodecs: 4071, videoCodecs: 252, videoFunction: 1,
    });
    this._send(writeMessage(CSID_INVOKE, TYPE_INVOKE, 0, 0, connect, this.chunkSize));
  }

  // We only need to detect two status strings to sequence the publish; scanning
  // the inbound byte stream for them is robust enough on a single connection.
  _scan(chunk) {
    this._inbound = Buffer.concat([this._inbound, chunk]).subarray(-8192);
    const s = this._inbound.toString('latin1');
    if (!this._sawConnect && s.includes('NetConnection.Connect.Success')) {
      this._sawConnect = true;
      const createStream = encode('createStream', 2, null);
      this._send(writeMessage(CSID_INVOKE, TYPE_INVOKE, 0, 0, createStream, this.chunkSize));
      const publish = Buffer.concat([
        encodeString('publish'), encodeNumber(3), encodeNull(),
        encodeString(this.stream), encodeString('live'),
      ]);
      this._send(writeMessage(CSID_INVOKE, TYPE_INVOKE, this.streamId, 0, publish, this.chunkSize));
    }
    if (!this.ready && s.includes('NetStream.Publish.Start')) {
      this.ready = true;
      this.emit('ready');
    }
  }

  // Forward a demuxed FLV tag as the matching RTMP message.
  forwardTag({ type, timestamp, data }) {
    if (!this.ready) return;
    const csid = type === TYPE_AUDIO ? CSID_AUDIO : type === TYPE_VIDEO ? CSID_VIDEO : CSID_DATA;
    this._send(writeMessage(csid, type, this.streamId, timestamp, data, this.chunkSize));
  }

  // Inject one Hawkeye frame as an AMF0 data message: ["onHawkeye", <base64>].
  sendHawkeye(raw, timestamp) {
    if (!this.ready) return;
    const payload = Buffer.concat([
      encodeString('onHawkeye'),
      encodeLongString(Buffer.from(raw).toString('base64')),
    ]);
    this._send(writeMessage(CSID_DATA, TYPE_DATA, this.streamId, timestamp, payload, this.chunkSize));
    this.dataSent++;
  }

  close() {
    try { this.sock?.end(); } catch { /* ignore */ }
  }
}
