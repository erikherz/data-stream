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

0. **Foundation** — data-tap + verifier + deploy. ← current
1. **SRT / MPEG-TS** — TS muxer (video PID + private data PID) over SRT.
2. **RTMP** — FLV muxer publishing video + AMF data messages to Node-Media-Server.
3. **HLS** — in-band ID3 timed metadata in TS segments.
