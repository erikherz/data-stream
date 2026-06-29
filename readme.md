# hawkeye-data-stream

Transport simulated live Hawkeye basketball tracking data over streaming
protocols: **SRT (in MPEG-TS)**, **RTMP (Enhanced RTMP data track)**, and
**HLS (in-band timed metadata)**.

## Source

`wss://brian.moqcdn.net/feed` — binary Protocol Buffers (schema:
`vendor/tracking.proto`, package `hawkeye.tracking.v1`). One `StreamMeta` on
connect, then `Frame`s at ~60 Hz (~10 KB/frame, ~4.8 Mbps). The host only
resolves from the project server.

## Layout

- `lib/data-tap.js` — shared source: decode the feed, emit frames, preserve raw
  protobuf bytes for re-embedding.
- `lib/extract-verify.js` — shared proof: pull bytes back out of a container and
  assert they re-decode to a valid `Frame` (embed-and-inspect verification).
- `bin/tap-stats.js` — confirm the tap (rate / size / bitrate).
- `vendor/tracking.proto` — vendored copy of the feed schema.

## Run (on the server)

```sh
./deploy.sh                          # rsync + npm install on the server
ssh -i ~/.ssh/brian-may-2026.pem ubuntu@18.188.46.242 \
  'cd hawkeye-data-stream && npm run tap:stats 10'
```

## Phases

0. **Foundation** — data-tap + verifier + deploy. ✅
1. **SRT / MPEG-TS** — splice a private-data PID (raw protobuf, PTS-synced) into
   ffmpeg's TS, ship over SRT. ✅ (`lib/ts.js`, `lib/ts-inject.js`,
   `bin/srt-publish.js`, `bin/ts-extract.js`; `scripts/srt-loopback-test.sh`)
2. **RTMP** — custom RTMP publish client sends video + `onHawkeye` AMF data(18)
   messages to a stock Node-Media-Server, which relays both to http-flv. ✅
   (`lib/amf0.js`, `lib/flv.js`, `lib/rtmp-publish.js`, `bin/rtmp-publish.js`,
   `bin/flv-extract.js`; `scripts/{start-nms,rtmp-loopback-test}.sh`)
3. **HLS** — carry each frame as an ID3 PRIV frame on a metadata PID
   (`stream_type 0x15`, tagged `ID3 `); a keyframe segmenter writes the live
   playlist. ✅ (`lib/id3.js`, `lib/hls-segmenter.js`, `bin/hls-publish.js`,
   `bin/hls-extract.js`; `scripts/hls-loopback-test.sh`). ffprobe sees the
   stream as `timed_id3`, so hls.js/Safari parse it natively. `emsg` for
   CMAF/LL-HLS is a follow-on.

## Phase 3 — run (on the server)

```sh
node bin/hls-publish.js /tmp/hls hawkeye   # live HLS with ID3 metadata PID
bash scripts/hls-loopback-test.sh          # publish + verify ID3 round-trip
# optional playback: (cd /tmp/hls && python3 -m http.server 8081) then load
#   http://<host>:8081/hawkeye.m3u8 in hls.js / Safari
```

`bin/hls-extract.js <playlist.m3u8>` reads the segments, unwraps the ID3 PRIV
frames, and verifies each `Frame`.

## Phase 2 — run (on the server)

```sh
bash scripts/start-nms.sh                 # stock NMS: RTMP :1935, http-flv :8000
node bin/rtmp-publish.js live hawkeye     # publish video + onHawkeye data messages
bash scripts/rtmp-loopback-test.sh        # publish + pull http-flv + verify data
```

`onHawkeye` rides as a standard AMF0 data(18) message (base64 payload), so a
stock NMS relays it unmodified; it shows up as a `data` track in the http-flv.
Enhanced-RTMP typed/multitrack carriage (raw binary, no base64) is a follow-on.
`bin/flv-extract.js <url>` pulls the data track and verifies each `Frame`.

## Phase 1 — run (on the server)

```sh
# Publish the muxed TS over SRT (listener on :9000):
node bin/srt-publish.js | srt-live-transmit file://con "srt://:9000?mode=listener"

# Verify the round-trip end-to-end:
bash scripts/srt-loopback-test.sh
```

`bin/ts-extract.js file.ts [--pid 0x101]` pulls the data PID out of any captured
TS and asserts each payload re-decodes to a valid `Frame`.
