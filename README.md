# scrypted-bambu

Scrypted support for Bambu Lab printer cameras.

## printer support

| series                | camera        | how                                                                                                                                                                                                                                               |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1P, P1S, A1, A1 mini | chamber image | the printer pushes JPEG frames over TLS on port 6000 at about 1 fps. the plugin keeps that connection open while something is watching, hands the newest frame back as the snapshot, and has the Rebroadcast plugin transcode the frames to H.264 |
| X1, X1C, X1E, H2, P2  | rtsp          | `rtsps://bblp:<access code>@<ip>:322/streaming/live/1`, handed to Scrypted as a normal RTSP stream. snapshots come from the Rebroadcast prebuffer                                                                                                 |

The RTSP path is written from the published stream URL and has not been tested against real hardware yet. If the stream fails to start, switch the stream's parser to FFmpeg in the camera's Rebroadcast settings and open an issue with the console output.

## setup

1. Put the printer in LAN mode or at least note its IP and the access code from the printer screen (Settings, Network).
2. In Scrypted, add a device of type Bambu Lab Printer. Fill in the IP and access code. Leave Camera on auto: it asks the printer whether port 322 answers and picks rtsp or chamber from that.
3. Enable the extensions you want on the new camera (HomeKit, NVR).

## caveats

A P1S streams to two chamber camera clients at once. Further connections are accepted but get no frames until a slot frees, then the next one in line starts receiving. Bambu Studio, Bambu Handy, the Home Assistant integration's camera, and this plugin each take a slot, and with the prebuffer on this plugin keeps its slot permanently. The plugin logs when it is waiting for one. Measured on a P1S, and [a forum report](https://forum.bambulab.com/t/does-lan-mode-have-a-maximum-number-of-connections/26983) gives the same number for the P1 series, Bambu documents no limit.

## development

```sh
direnv allow          # or nix develop
pnpm install
pnpm lint             # oxfmt --check and oxlint, same as ci
pnpm check            # tsc
pnpm test             # frame parser unit tests
pnpm build            # bundle to out/plugin.zip
pnpm fmt              # oxfmt
```

To interface with printers directly:

```sh
node tools/chamber-probe.mts <ip> <access code>  # grabs frames, saves the first to /tmp/chamber-probe.jpg
node tools/stream-check.mts <ip> <access code>   # runs the exact ffmpeg pipeline for 12s and reports output fps
```

## credits

- [ha-bambulab](https://github.com/greghesp/ha-bambulab), for the port 6000 protocol
