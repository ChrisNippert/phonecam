# PhoneCam

Stream your phone's camera to your PC over the local network, with live control of
resolution, frame rate, quality and more from the PC.

No installs, no app on the phone — just Python 3.8+ on the PC and a browser on each end.

## Run

```
python server.py
```

It prints something like:

```
Phone  : https://192.168.1.42:8443/phone
Viewer : http://localhost:8080/viewer
```

1. Open the **Viewer** URL on the PC.
2. Open the **Phone** URL on the phone (same Wi-Fi). It'll warn that the certificate is
   self-signed — that's expected; tap *Advanced → Proceed*. Phones only allow camera access
   on HTTPS pages, which is why the server makes its own certificate.
3. Tap **Start camera** on the phone. The stream shows up on the PC.

Optional: `pip install qrcode` and the server prints a QR code for the phone URL (and the
viewer shows one while waiting).

## Settings (from the viewer)

| Setting | What it does |
|---|---|
| Lens | Pick a specific camera — phones often expose ultrawide / telephoto separately |
| Facing | Back / front |
| Resolution | 480p – 4K (options are limited to what the camera reports it supports) |
| Frame rate | 15 / 24 / 30 / 60 |
| Zoom, Torch | Shown only if the phone supports them (mostly Android Chrome) |
| Quality / Bitrate | Max encoder bitrate, 250 kb/s – 25 Mb/s |
| When limited | If bandwidth runs short: drop resolution to stay smooth, drop frames to stay sharp, or balance |
| Codec | VP8 / VP9 / H264 / AV1 (whatever both browsers support) |
| Audio | Also send the phone's mic |

View-only (don't affect the phone): fit/fill, rotate, mirror, fullscreen, snapshot (PNG),
record (WebM/MP4). Keys: **F** fullscreen, **H** hide panel, **S** snapshot.

## Using it as a webcam (OBS)

Add a *Browser Source* in OBS with URL `http://localhost:8080/viewer?clean` — that's video
only, no UI. Size it to your stream resolution. You can add `&rotate=90` or `&mirror`.
Then use OBS's *Start Virtual Camera* to get it into Zoom/Discord/etc.

Note: only one viewer at a time — opening a new one takes over from the old one.

## How it works

`server.py` (standard library only) serves the pages and relays a few WebSocket messages
so the two browsers can set up a WebRTC connection. The video itself goes straight from
the phone to the PC over WebRTC; it never passes through Python. No STUN/TURN is used,
so it works with no internet, but both devices need to be on the same network.

The phone owns the camera settings. The viewer sends changes; the phone applies them
the cheapest way it can:

- bitrate / framerate cap / degradation → `RTCRtpSender.setParameters` (instant)
- frame rate, zoom, torch → `track.applyConstraints` (instant)
- resolution / lens → reopen the camera and `replaceTrack` (brief hiccup, no reconnect)
- codec / audio → renegotiate the connection (~1 s)

## Troubleshooting

- **Viewer stuck on "Connecting…"** — a firewall is likely blocking WebRTC. On Windows,
  allow Python on *Private* networks when prompted (or in Windows Defender Firewall), and
  make sure your Wi-Fi is set to a Private network. Guest Wi-Fi networks often block
  device-to-device traffic entirely.
- **Wrong IP in the phone URL** (VPN, multiple adapters) — `python server.py --host 192.168.x.x`.
- **Resolution looks portrait** — the phone is held upright; rotate it or use *Rotate* in the viewer.
- **iPhone** — works in Safari; torch and zoom aren't exposed there.
- **Screen turns off** — the page asks for a wake lock, but some phones still sleep; turn
  *Preview* off to save battery and heat while it keeps streaming.
- Other ports: `--port 9443`, `--local-port 0` disables the localhost HTTP viewer.
