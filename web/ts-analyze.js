// ts-analyze.js — a tiny in-browser MPEG-TS analyzer.
//
// Answers the same question ffprobe does for a segment: which elementary
// streams are inside, their PID, codec, and (for H.264) the resolution parsed
// from the SPS. No external library — it walks the PAT/PMT and one video PES.
// Exposes window.analyzeTsSegment(Uint8Array|ArrayBuffer) -> { pmtPid, streams }.
(function () {
  const TS = 188, SYNC = 0x47;
  const TYPES = {
    0x01: 'mpeg1video', 0x02: 'mpeg2video', 0x03: 'mp3', 0x04: 'mp3',
    0x0f: 'aac', 0x11: 'aac_latm', 0x15: 'timed_id3', 0x1b: 'h264',
    0x24: 'hevc', 0x06: 'private', 0x81: 'ac3', 0x87: 'eac3',
  };
  const AUDIO = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);
  const VIDEO = new Set([0x01, 0x02, 0x1b, 0x24]);

  const pidOf = (p) => ((p[1] & 0x1f) << 8) | p[2];
  const pusi = (p) => (p[1] & 0x40) !== 0;
  function payloadStart(p) {
    const afc = (p[3] >> 4) & 3;
    if (!(afc & 1)) return -1;
    return afc & 2 ? 5 + p[4] : 4;
  }
  const sectionStart = (p) => { const s = payloadStart(p); return s + 1 + p[s]; };

  function parsePAT(p) {
    const s = sectionStart(p), len = ((p[s + 1] & 0x0f) << 8) | p[s + 2], end = s + 3 + len - 4;
    for (let i = s + 8; i + 4 <= end; i += 4) {
      const pn = (p[i] << 8) | p[i + 1];
      if (pn !== 0) return ((p[i + 2] & 0x1f) << 8) | p[i + 3];
    }
    return null;
  }
  function parsePMT(p) {
    const s = sectionStart(p), len = ((p[s + 1] & 0x0f) << 8) | p[s + 2], end = s + 3 + len - 4;
    const pil = ((p[s + 10] & 0x0f) << 8) | p[s + 11];
    let i = s + 12 + pil;
    const out = [];
    while (i + 5 <= end) {
      const streamType = p[i], pid = ((p[i + 1] & 0x1f) << 8) | p[i + 2];
      const esil = ((p[i + 3] & 0x0f) << 8) | p[i + 4];
      let reg = null;
      for (let j = i + 5, de = i + 5 + esil; j + 2 <= de; j += 2 + p[j + 1]) {
        if (p[j] === 0x05 && p[j + 1] >= 4) reg = String.fromCharCode(p[j + 2], p[j + 3], p[j + 4], p[j + 5]).trim();
      }
      out.push({ streamType, pid, reg });
      i += 5 + esil;
    }
    return out;
  }

  // Concatenate the elementary-stream payload of a PID (strip PES headers).
  function collectPid(buf, vpid, max) {
    const parts = [];
    let total = 0;
    for (let i = 0; i + TS <= buf.length && total < max; i += TS) {
      if (buf[i] !== SYNC) continue;
      const p = buf.subarray(i, i + TS);
      if (pidOf(p) !== vpid) continue;
      const st = payloadStart(p);
      if (st < 0) continue;
      let s = st;
      if (pusi(p)) { const pes = p.subarray(st); s = st + 9 + pes[8]; }
      parts.push(buf.subarray(s, i + TS));
      total += i + TS - s;
    }
    const o = new Uint8Array(total);
    let k = 0;
    for (const a of parts) { o.set(a, k); k += a.length; }
    return o;
  }

  function unescapeRbsp(b) {
    const o = [];
    for (let i = 0; i < b.length; i++) {
      if (i + 2 < b.length && b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 3) { o.push(0, 0); i += 2; }
      else o.push(b[i]);
    }
    return new Uint8Array(o);
  }
  function findSps(es) {
    for (let i = 0; i + 4 < es.length; i++) {
      if (es[i] === 0 && es[i + 1] === 0 && (es[i + 2] === 1 || (es[i + 2] === 0 && es[i + 3] === 1))) {
        const start = i + (es[i + 2] === 1 ? 3 : 4);
        if ((es[start] & 0x1f) === 7) {
          let end = es.length;
          for (let j = start + 1; j + 3 < es.length; j++) {
            if (es[j] === 0 && es[j + 1] === 0 && (es[j + 2] === 1 || (es[j + 2] === 0 && es[j + 3] === 1))) { end = j; break; }
          }
          return unescapeRbsp(es.subarray(start + 1, end));
        }
      }
    }
    return null;
  }
  function bitReader(b) {
    let pos = 0;
    const bit = () => (b[pos >> 3] >> (7 - (pos++ & 7))) & 1;
    return {
      u(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bit(); return v >>> 0; },
      ue() { let z = 0; while (bit() === 0 && pos < b.length * 8) z++; let v = 0; for (let i = 0; i < z; i++) v = (v << 1) | bit(); return (1 << z) - 1 + v; },
      se() { const k = this.ue(); return k & 1 ? (k + 1) >> 1 : -(k >> 1); },
    };
  }
  function spsResolution(rbsp) {
    const r = bitReader(rbsp);
    const profile = r.u(8); r.u(8); r.u(8); r.ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const cf = r.ue();
      if (cf === 3) r.u(1);
      r.ue(); r.ue(); r.u(1);
      if (r.u(1)) return null; // scaling matrix present — skip rather than mis-parse
    }
    r.ue();
    const poc = r.ue();
    if (poc === 0) r.ue();
    else if (poc === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
    r.ue(); r.u(1);
    const w = r.ue(), h = r.ue(), fmo = r.u(1);
    if (!fmo) r.u(1);
    r.u(1);
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    const width = (w + 1) * 16 - (cl + cr) * 2;
    const height = (2 - fmo) * (h + 1) * 16 - (ct + cb) * 2;
    return width > 0 && height > 0 && width < 8192 && height < 8192 ? { width, height } : null;
  }

  window.analyzeTsSegment = function (input) {
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    let pmtPid = null, streams = null;
    for (let i = 0; i + TS <= buf.length; i += TS) {
      if (buf[i] !== SYNC) continue;
      const p = buf.subarray(i, i + TS), id = pidOf(p);
      if (id === 0 && pusi(p) && pmtPid === null) pmtPid = parsePAT(p);
      else if (id === pmtPid && pusi(p) && !streams) streams = parsePMT(p);
      if (streams) break;
    }
    if (!streams) return { pmtPid, streams: [] };
    for (const s of streams) {
      if (s.streamType === 0x1b) {
        try { const res = spsResolution(findSps(collectPid(buf, s.pid, 500000))); if (res) { s.width = res.width; s.height = res.height; } } catch (e) { /* ignore */ }
      }
    }
    return {
      pmtPid,
      streams: streams.map((s, index) => ({
        index, pid: s.pid, streamType: s.streamType,
        codec: TYPES[s.streamType] || '0x' + s.streamType.toString(16),
        kind: VIDEO.has(s.streamType) ? 'video' : AUDIO.has(s.streamType) ? 'audio' : 'data',
        detail: s.width ? `${s.width}×${s.height}` : s.reg ? `tag '${s.reg}'` : '',
      })),
    };
  };
})();
