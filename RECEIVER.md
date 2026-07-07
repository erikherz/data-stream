# Rebroadcast station (SRT → HLS)

A companion, **view-only** app that ingests the SRT MPEG-TS produced by the main
publisher and republishes it as HLS with the tracking data carried as ID3
timed-metadata — so a remote client can watch the video and the synced skeletons
without originating any RTMP/SRT of its own. Deployed to **jake.moqcdn.net**.

## Pipeline

```
main app ──SRT──▶ srt-live-transmit (listener :9000) ──raw TS──▶ srt-receive.js (Node)
                                                                    │ tee
                                     ┌──────────────────────────────┴────────────┐
                                     ▼                                            ▼
                          ffmpeg (re-encode video+audio,              KlvTsSource (parse TS,
                          clean 2 s GOP, no data stream)              unwrap KLV → raw protobuf)
                                     │                                            │
                                     ▼                                            │ pushFrame(raw)
                          TsInjector (add ID3 metadata PID) ◀────────────────────┘
                                     ▼
                          HlsSegmenter → /var/www/html/hls/receiver.m3u8
                                     ▼
                          nginx (HTTPS :443, jake cert) → / (view-only player)
```

The source carries the tracking data as **synchronous KLV** (SMPTE ST 336); the
player reads **ID3** PRIV→protobuf, so the receiver transforms the data stream
KLV→ID3 while re-muxing. Everything else (`TsInjector`, `HlsSegmenter`, `id3.js`,
`ts.js`) is shared verbatim with the main publisher.

## Files

- `bin/srt-receive.js` — the receiver process (SRT in → HLS out).
- `lib/klv-ts-source.js` — extracts raw protobuf frames from the inbound KLV stream.
- `web/receiver.html` — view-only player (no RTMP/SRT cards, no start/stop control).
- `systemd/hawkeye-receiver.service` — runs the receiver, `Restart=always`.
- `scripts/receiver-setup.sh` — one-shot server bootstrap (node, nginx, srt-tools, HTTPS, unit).
- `scripts/deploy-receiver.sh` — rsync + refresh code and restart the unit.

## Deploy

```bash
scripts/deploy-receiver.sh              # rsync repo to jake
# first time only, on the server:
ssh … 'cd hawkeye-data-stream && bash scripts/receiver-setup.sh'
```

## Feed it

Point any SRT sender at the listener (caller mode):

```bash
… | srt-live-transmit file://con "srt://jake.moqcdn.net:9000?mode=caller&latency=200"
```

## Receiver-measured sync snapshot

`bin/srt-receive.js` decodes every KLV frame server-side (via `lib/data-tap.js`)
and writes `<outDir>/receiver-sync.json` every 2s — the authoritative view of how
the SRT source's data tracks its video, measured at the transport *before* HLS
buffering (unlike the browser's `data↔video (render)` skew, which is only what
survived into a given player). `web/receiver.html` polls it into a card. Fields:

| field | meaning |
| --- | --- |
| `source` | `connected` (frames <3s old) / `stalled` / `waiting` |
| `latencyMs` | `capture_timestamp_ms` → edge wall-clock (pipeline freshness) |
| `fps`, `maxGapMs` | KLV cadence + worst inter-frame gap (data continuity) |
| `queue` | injector backlog: frames awaiting the current video PTS weld |
| `videoPtsSec` | output video PTS each frame is stamped to |
| `game` | decoded period/clock/score/people/ball |

**Honest scope:** transport alignment + freshness, *not* pixel-vs-data content
sync (which needs OCR of the burned-in clock). A tight `queue`/`latency` with a
mismatched on-screen clock just means the video clip and the data feed are
independent content — the transport is doing its job.

## Playback reliability (not latency)

`web/receiver.html`'s hls.js is tuned for reliability: `lowLatencyMode` is off, so
it sits ~8s back from the live edge with a deep fwd/back buffer, tolerates small
gaps instead of stalling/seeking, and auto-recovers from fatal network/media
errors. `bin/srt-receive.js` widens the DVR window to `HLS_WINDOW` = 10 (~20s) so
there is headroom for that buffer, and the client keeps ~66s of decoded frames so
the overlay always spans the played position. (Same treatment as the origin
player in `web/player.html`.)

## Feeding the receiver: `systemd/origin-gateway-feed.service`

The receiver pulls the gateway egress; something must publish to the gateway
ingress. On the origin box, `origin-gateway-feed.service` runs `srt-publish.js`
piped to a caller-mode `srt-live-transmit` aimed at `:20887`. It coexists with
origin's own local `:9000` publisher. Without it the receiver stays up but its
HLS goes stale.

To pull (caller mode) instead of listen, override the unit's env:
`Environment=SRT_URL=srt://host:port?mode=caller`.

## Required: open the SRT ingress port

The player (HTTPS/443) is reachable, but the SRT listener needs **UDP 9000** open
in the instance's security group (`sg-0df2b0713c6ed4779`, region `us-west-2`).
Prefer scoping to the origin's IP rather than `0.0.0.0/0`:

```bash
aws ec2 authorize-security-group-ingress --region us-west-2 \
  --group-id sg-0df2b0713c6ed4779 --protocol udp --port 9000 --cidr <ORIGIN_IP>/32
```
