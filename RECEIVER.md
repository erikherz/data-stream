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
