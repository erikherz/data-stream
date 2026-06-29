# hawkeye-data-stream

Transport simulated live Hawkeye basketball tracking data over streaming
protocols: **SRT (in MPEG-TS)**, **RTMP (Enhanced RTMP data track)**, and
**HLS (in-band timed metadata)**. The same raw protobuf frame is the payload in
every container — only the envelope changes — so the data round-trips bit-for-bit
and downstream tooling sees a standards-conformant metadata track.

## Source

`wss://brian.moqcdn.net/feed` — binary Protocol Buffers (schema:
`vendor/tracking.proto`, package `hawkeye.tracking.v1`). One `StreamMeta` on
connect, then `Frame`s at ~60 Hz (~10 KB/frame, ~4.8 Mbps). The host only
resolves from the project server.

The wire envelope is a `oneof`:

```proto
message Message {            // every WebSocket binary frame is one of these
  oneof payload {
    StreamMeta meta  = 1;    // once, on connect
    Frame      frame = 2;    // ~60 Hz thereafter
  }
}

message Frame {
  uint64           frame_id             = 1;
  int64            capture_timestamp_ms = 2;   // unix epoch ms
  repeated Person  people               = 4;   // up to 13 (10 players + 3 officials)
  Ball             ball                 = 5;
}
```

Each `Person` carries 29 3D skeletal joints (`Vec3` in meters, right-handed,
court-relative). One `Frame` is ~10 KB on the wire.

## Layout

- `lib/data-tap.js` — shared source: decode the feed, emit frames, preserve raw
  protobuf bytes for re-embedding.
- `lib/extract-verify.js` — shared proof: pull bytes back out of a container and
  assert they re-decode to a valid `Frame` (embed-and-inspect verification).
- `lib/ts.js` — MPEG-TS primitives (PAT/PMT parse + patch, PES build/packetize,
  PTS read, CRC-32, registration descriptors).
- `lib/ts-inject.js` — `TsInjector`, the in-flight TS remuxer that splices the
  data PID into ffmpeg's output.
- `lib/klv.js` — SMPTE ST 336 KLV encode/decode (SRT path).
- `lib/id3.js` — ID3v2.4 PRIV build/parse (HLS path).
- `lib/hls-segmenter.js` — keyframe segmenter + sliding-window playlist.
- `bin/tap-stats.js` — confirm the tap (rate / size / bitrate).
- `vendor/tracking.proto` — vendored copy of the feed schema.

---

## How the Hawkeye data is pulled

`lib/data-tap.js` (`DataTap`) is the single source every muxer shares:

1. Connect to `wss://brian.moqcdn.net/feed` (Node ≥ 22 global `WebSocket`,
   `binaryType = 'arraybuffer'`).
2. Decode each binary message as `hawkeye.tracking.v1.Message` with protobufjs.
3. Re-emit a clean event stream — but **keep the original wire bytes** on every
   frame as `f.raw`. That is the key move: muxers re-embed `f.raw` verbatim, so
   there is never a decode→re-encode round-trip and the bytes that come back out
   downstream are identical to what the feed sent.

```js
const tap = new DataTap();
tap.on('frame', (f) => injector.pushFrame(f.raw)); // f.raw = exact protobuf bytes
await tap.start();
```

The muxers do **not** touch video/audio encoding. ffmpeg owns the A/V; the Node
side only adds one extra elementary stream carrying `f.raw`, time-stamped to the
video clock. Everything below is about that one extra track.

---

## How it's mixed into MPEG-TS / SRT  (Phase 1)

`bin/srt-publish.js` runs ffmpeg to produce a standard MPEG-TS
(ISO/IEC 13818-1), then pipes it through `TsInjector` (`lib/ts-inject.js`), a
`Transform` that rewrites the transport stream **in flight** to add a private
data PID. The video and audio are `-c:v copy` / `-c:a aac` — never re-muxed by
us; we only parse the 188-byte packet grid and splice.

### Program / PID map

ffmpeg lays the program out as below; `TsInjector` auto-detects the PMT and video
PIDs from the PAT/PMT (so it survives ffmpeg layout changes) and appends the data
PID. These are the live values (confirm with `ffprobe` or the player's SRT card):

| PID      | Stream type        | Contents                         | Owner    |
|----------|--------------------|----------------------------------|----------|
| `0x0000` | —                  | PAT                              | ffmpeg   |
| `0x1000` | —                  | PMT                              | ffmpeg   |
| `0x0100` | `0x1B` H.264/AVC   | video (PCR usually rides here)   | ffmpeg   |
| `0x0101` | `0x0F` AAC (ADTS)  | audio                            | ffmpeg   |
| `0x0102` | `0x06` PES private | **Hawkeye KLV** (one triplet/PES)| injector |

> The data PID is `0x102`, not `0x101`: once audio is enabled ffmpeg claims
> `0x101` for AAC, so the data stream takes the next free PID to avoid a
> collision. (A PID collision here silently corrupts both streams — it was a real
> bug, caught by the round-trip verifier.)

### PMT patching

When a PMT packet (PUSI set, on the PMT PID) passes through, `patchPmt()`
(`lib/ts.js`) appends one elementary-stream entry for the data PID:

- `stream_type = 0x06` — *PES packets containing private data*.
- An **ES-level registration descriptor** (tag `0x05`) with
  `format_identifier = 'KLVA'` (`0x4B4C5641`). This is what makes
  ffmpeg / GStreamer / MISB tooling recognize the stream as KLV and demux it as
  codec `klv` — `ffmpeg -i srt://… -map 0:d:0 -c copy -f data out.klv` extracts
  it cleanly. The section's CRC-32 (poly `0x04C11DB7`, MPEG-2 systems) is
  recomputed after the splice.

### KLV envelope — SMPTE ST 336, carried per MISB ST 1402

Each Hawkeye frame becomes one **KLV triplet** (`lib/klv.js`):

```
┌──────────────── 16-byte Universal Label ────────────────┐┌─ BER len ─┐┌─ value ─┐
06 0E 2B 34 01 01 01 0F  56 49 56 4F 48 48 4B 31            82 27 25     <protobuf>
└── SMPTE UL designator ──┘└──── 'VIVOHHK1' (private) ───┘
```

- **Key** — a 16-byte SMPTE Universal Label (SMPTE ST 336 / registry RP 224).
  The leading `06 0E 2B 34` is the SMPTE UL designator; the trailing eight bytes
  spell `VIVOHHK1`, an org-private identifier. (For production you'd register a
  UL with SMPTE and publish the key + `.proto` so consumers can interpret the
  value. Demuxers key off the PMT `KLVA` descriptor regardless of this label; the
  label only drives *semantics*.)
- **Length** — BER (ITU-T X.690): short form for `< 128`, otherwise
  `0x80 | n` followed by `n` big-endian length bytes. A ~10 KB frame yields a
  3-byte long-form length, e.g. `82 27 25`.
- **Value** — the raw protobuf `Message` bytes (`f.raw`), untouched.

### Synchronous carriage (PES + PTS)

"Synchronous" (MISB ST 1402) means each KLV unit sits in its own PES and is
time-stamped to the media clock so a player can align metadata to a video frame:

- Each triplet is wrapped in a PES with `stream_id = 0xBD` (`private_stream_1`)
  by `buildPes()`, carrying a 33-bit, 90 kHz **PTS** set to the most recent video
  PTS. `TsInjector` reads the video PTS from the H.264 PID and drains queued
  frames at each video PUSI (keyframe/frame boundary), so the data lands ~aligned
  with the picture it describes.
- `packetizePes()` slices the PES into 188-byte packets on the data PID with
  correct continuity counters and an adaptation field for stuffing on the final
  packet.

### Transport

ffmpeg flags chosen for clean live remuxing and mid-stream SRT joins:
`-pat_period 0.2` (PSI 5×/s so a late joiner finds PAT/PMT fast),
`-mpegts_flags +resend_headers`, `-flush_packets 1`. The muxed TS on stdout goes
to a dumb SRT sender (`srt-live-transmit`), which knows nothing about the data —
it just ships bytes.

```sh
# Publish the muxed TS over SRT (listener on :9000):
node bin/srt-publish.js | srt-live-transmit file://con "srt://:9000?mode=listener&latency=120"

# Verify the round-trip end-to-end:
bash scripts/srt-loopback-test.sh
```

`bin/ts-extract.js file.ts [--pid 0x102] [--klv]` pulls the data PID out of any
captured TS, unwraps the KLV (`--klv`), and asserts each value re-decodes to a
valid `Frame`. It self-aligns to the 188-byte grid (four consecutive sync bytes)
because a live SRT capture starts mid-stream. `bin/srt-snapshot.js` does the same
on a short capture and emits a compact JSON snapshot (streams + a KLV peek) that
the browser player's "Live SRT pull" card renders every 5 s
(`scripts/srt-snapshot-loop.sh`).

---

## How it's mixed into HLS  (Phase 3)

`bin/hls-publish.js` reuses the **same** `TsInjector`, but swaps the envelope to
Apple-style **timed ID3 metadata** and adds a keyframe segmenter. Here ffmpeg
*does* re-encode video, because HLS needs a fixed, predictable GOP to cut clean
segments:

```
-c:v libx264 -g 60 -keyint_min 60 -sc_threshold 0 \
-force_key_frames expr:gte(t,n_forced*2)      # a keyframe every 2 s
-c:a aac -ac 2 -b:a 128k
```

### Metadata PID

| PID      | Stream type            | Contents                          |
|----------|------------------------|-----------------------------------|
| `0x0102` | `0x15` metadata in PES | **Hawkeye ID3** (one tag per PES) |

The PMT entry for the metadata PID is `stream_type = 0x15` (*Metadata carried in
PES packets*) with a registration descriptor `format_identifier = 'ID3 '`
(`0x49443320`). ffprobe then reports the stream as `timed_id3`, and
hls.js / Safari parse it natively (`FRAG_PARSING_METADATA` /
`HTMLTrackElement` cues).

### ID3 envelope

Each frame becomes one **ID3v2.4 tag** containing a single **PRIV frame**
(`lib/id3.js`):

- Owner identifier `com.vivoh.hawkeye\0`, then the raw protobuf bytes (`f.raw`).
- Tag/frame sizes are ID3 "synchsafe" (7 usable bits/byte).
- The tag is the payload of the metadata PES; its **PTS** (set by `TsInjector`
  from the video clock) places it on the media timeline.

### Segmenter

`lib/hls-segmenter.js` consumes the injected TS and:

- splits a new segment at each video keyframe (adaptation-field
  `random_access_indicator`), respecting a `minSegSec` floor;
- prepends the cached PAT/PMT to every segment so each `.ts` is independently
  decodable;
- writes a sliding-window `EXT-X` media playlist (RFC 8216).

Because the ID3 PES is already interleaved and PTS-synced upstream, each frame
lands in the segment covering its timestamp automatically — no per-segment
alignment logic in the segmenter.

```sh
node bin/hls-publish.js /tmp/hls hawkeye   # live HLS with the ID3 metadata PID
bash scripts/hls-loopback-test.sh          # publish + verify ID3 round-trip
```

`bin/hls-extract.js <playlist.m3u8>` reads the segments, unwraps the ID3 PRIV
frames, and verifies each `Frame`.

### Browser player

`web/player.html` plays the HLS with hls.js and **decodes the ID3 timed metadata
back into protobuf in the browser**, rendering the 13 skeletons + ball on a court
in sync with the video clock. It also has an "Analyze segments" card (decodes the
live `.ts` in-browser) and side-by-side "Live SRT pull" / "Live RTMP" cards
showing the parallel SRT/KLV and RTMP/AMF0 tracks (each polled from a server-side
snapshot every ~5 s). A small control-server (`bin/control-server.js`) backs the
Start/Stop button, which starts/stops all three transports (HLS + SRT + RTMP) at
once. `scripts/serve-player.sh` drops the page at the nginx webroot and points the
publisher at `/var/www/html/hls`:

```sh
bash scripts/serve-player.sh   # then open http://<server-ip>/
bash scripts/enable-https.sh   # optional: HTTPS on 443 via the luke.moqcdn.net cert
```

Live demo: **https://luke.moqcdn.net/** (HTTP on port 80 also works).

---

## How it's mixed into RTMP  (Phase 2)

RTMP has no transport-stream PIDs — it carries a sequence of typed **FLV tags**
multiplexed over AMF chunk streams. So the same protobuf frame rides a different
envelope here: a **script-data message** alongside the video and audio tags.
`bin/rtmp-publish.js` is a hand-rolled RTMP publish client
(`lib/rtmp-publish.js`, `lib/amf0.js`, `lib/flv.js`) — no ffmpeg RTMP muxer is
involved in the data path.

### Pipeline

```
ffmpeg(-f flv)  ->  FlvDemux  ->  RtmpPublisher  ->  NMS (:1935)  ->  http-flv (:8000)
                       │                ▲
            DataTap ───┴── f.raw ──> sendHawkeye() interleaved on each video tag
```

- ffmpeg emits FLV (`-c:v copy`, `-c:a aac`); `FlvDemux` (`lib/flv.js`) cuts it
  into whole tags, and `RtmpPublisher` forwards each over the RTMP chunk stream
  (AMF0 handshake → `connect` → `createStream` → `publish`).
- On every **video tag** the publisher flushes any queued Hawkeye frames via
  `sendHawkeye(raw, lastVideoTs)`, stamping each with the current video
  timestamp so the data interleaves in time order.
- A **stock, unmodified** Node-Media-Server relays everything to its RTMP and
  http-flv subscribers — no NMS plugin or patch.

### FLV track map

| FLV tag type        | Contents                                            |
|---------------------|-----------------------------------------------------|
| `9`  video          | H.264 (codec id `7`)                                |
| `8`  audio          | AAC (sound format `10`)                             |
| `18` script-data    | `onMetaData` (once) **+ `onHawkeye` per frame**     |

### The `onHawkeye` message

Each frame is one AMF0 **data(18)** message built by `lib/amf0.js`:

```
AMF0 string  "onHawkeye"            (type 0x02)
AMF0 string  <base64 of f.raw>      (type 0x02 / long-string 0x0c)
```

- `stream_id` / message type **18** is the standard RTMP/FLV script-data
  channel, so an unmodified NMS relays it as a generic `data` track.
- The protobuf bytes are **base64-encoded** to stay inside an AMF0 string (AMF0
  strings are not binary-safe). A ~10 KB frame → ~13.4 KB base64.
- Enhanced-RTMP typed/multitrack carriage (raw binary, no base64) is a
  follow-on; base64-in-AMF0 is the maximally-compatible path through stock
  tooling today.

> **Why VLC shows no data track:** VLC's media-info lists only *codec* tracks
> (video/audio). `onHawkeye` is FLV **script-data**, not a codec, so players
> ignore it — even though the bytes are flowing. The only way to *see* it is to
> parse the script tags, which is what `bin/flv-extract.js` and the player's
> "Live RTMP" card do.

```sh
bash scripts/start-nms.sh                 # stock NMS: RTMP :1935, http-flv :8000
bash scripts/start-rtmp.sh                # detached publisher (VIDEO=… APP=live NAME=hawkeye)
bash scripts/rtmp-loopback-test.sh        # publish + pull http-flv + verify data
```

The live playback URL from the NMS box (RTMP/1935 is open; http-flv/8000 is
local-only unless opened in the SG):

```
rtmp://18.188.46.242:1935/live/hawkeye
```

`bin/flv-extract.js <url>` pulls the data track back through NMS and verifies
each `Frame` (e.g. *361 onHawkeye tags, 361 valid frames, 0 failed*).
`bin/rtmp-snapshot.js <http-flv-url>` emits a compact JSON snapshot (FLV tracks
+ a decoded `onHawkeye` peek); `scripts/rtmp-snapshot-loop.sh` writes it to the
webroot every ~5 s for the player's "Live RTMP" card.

---

## Standards reference

| Concern                       | Standard                                              |
|-------------------------------|-------------------------------------------------------|
| Transport stream              | ISO/IEC 13818-1 (MPEG-2 Systems / H.222.0)            |
| Video / audio elementary      | ITU-T H.264 (14496-10) · AAC (ISO/IEC 14496-3)        |
| KLV encoding                  | SMPTE ST 336                                          |
| Synchronous KLV in MPEG-TS    | MISB ST 1402                                          |
| KLV Universal Label registry  | SMPTE RP 224 (designator `06 0E 2B 34`)               |
| BER length encoding           | ITU-T X.690                                           |
| Timed ID3 in HLS              | Apple "Timed Metadata for HTTP Live Streaming" · ID3v2.4 |
| HLS playlists                 | RFC 8216                                              |
| SRT transport                 | draft-sharabayko-srt (Haivision SRT)                  |
| RTMP / FLV tags / AMF0        | Adobe RTMP 1.0 · FLV/F4V spec · AMF0 spec             |

## Phases

0. **Foundation** — data-tap + verifier + deploy. ✅
1. **SRT / MPEG-TS** — synchronous SMPTE ST 336 KLV on a private PES (`0x06`,
   `KLVA`). ✅
2. **RTMP** — `onHawkeye` AMF0 data(18) through a stock NMS to http-flv. ✅
3. **HLS** — ID3 PRIV on a metadata PID (`0x15`, `ID3 `) + keyframe segmenter. ✅

## Run / deploy (on the server)

```sh
./deploy.sh                          # rsync + npm install on the server
ssh -i ~/.ssh/brian-may-2026.pem ubuntu@18.188.46.242 \
  'cd hawkeye-data-stream && npm run tap:stats 10'
```
