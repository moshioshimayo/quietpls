# quietpls

A floating macOS mic-level monitor for calls and meetings — a small
glassmorphic pill that reminds you when you get louder than your comfortable
baseline, in real time, all local.

**v2.0 is local-only.** No account, no cloud, no telemetry. Your audio never
leaves the machine: audio is analyzed in-memory and nothing is ever recorded
or transmitted. Sessions and settings live in a local store on your disk.

## Features

- 💊 **Compact pill widget** — always-on-top, tiny footprint, canvas waveform
- 🎚️ **Level relative to your normal** — "+7 dB above your normal", plus an
  FFT spectrum in the expanded panel
- 🎨 **Zones** — Normal, Getting loud (yellow, +6 dB) and Too loud (red,
  +10 dB) above your calibrated normal voice; a sensitivity slider shifts both.
  Silence is "Not speaking", never "too quiet"
- 🧠 **Guided calibration, once per mic** — talk normally for about 5 seconds;
  only speech counts. Recalibrate any time from Settings or the right-click menu
- 🔌 **Mic health** — follows the mic you pick, notices unplug/fallback and
  shows "Mic unavailable / Reconnecting" instead of stale levels
- 🗣️ **Starts with your calls** — when another app (Zoom, Teams, Meet,
  FaceTime, …) starts using the mic, monitoring starts; it stops ~30s after the
  call releases the mic. On by default (macOS 14+); toggle in Settings
- 📊 **Session scorecard** — after each ≥60s session: duration, insights, and
  how much of your speaking time was too loud (kept locally in History)
- 🚨 **Too-loud alert** with dismissible danger panel
- 🍡 **System tray** — start/stop monitoring, settings, check for updates
- ✨ **Auto-update** — checks GitHub Releases hourly; "Check for Updates…" and
  "Restart to Update" in the tray menu
- ⌨️ **Keyboard shortcuts** — `Cmd+Shift+M` toggle monitoring,
  `Cmd+Shift+S` settings, `Cmd+Shift+D` dev console

## Install

Download the latest DMG for your Mac (Apple Silicon or Intel) from
[Releases](https://github.com/moshioshimayo/quietpls/releases), open it, and
drag quietpls to Applications. Official releases are signed and notarized —
they open on macOS without Gatekeeper workarounds.

> Auto-update only works for the official signed releases (macOS verifies
> update signatures). If you build unsigned yourself, download updates manually.

## Build from source

Requirements: macOS, Node.js 18+, Xcode Command Line Tools.

```bash
npm install
npm start        # run from source
npm test         # unit tests (vitest)
npm run test:e2e # Playwright e2e (launches the real app; needs mic permission)
npm run dist     # package unsigned DMG + ZIP for arm64 and x64
```

### Signed release build (maintainers)

Signing and notarization are env-driven and skip cleanly when unset:

```bash
export MAC_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID"
npm run release   # builds, signs, notarizes, staples, verifies each DMG
```

Artifacts in `dist/`: `quietpls-<version>-<arch>.dmg`, `.zip`, `.blockmap`,
and `latest-mac.yml`. Publish a GitHub Release with tag `v<version>` and
upload those files — that release IS the update feed for the in-app updater.

## How it works

- `main.js` — Electron main process: windows, tray, IPC, settings store,
  updater
- `renderer.js` + `index.html` — the pill widget and monitoring panels
- `capture-controller.js` — owns the mic stream, the device actually
  captured, the audio graph, health and reconnects
- `volume-processor.js` — AudioWorklet (audio rendering thread): 80 Hz
  high-pass, 400 ms RMS in dBFS, clip flag and a simple speech gate
- `level-logic.js` — the one zone decision shared by pill, tray and sessions
- `calibration-manager.js` — guided per-mic calibration
- `meeting-detector.js`, `session-tracker.js`, `session-insights.js` —
  session intelligence, all local
- Sessions history and settings: `~/Library/Application Support/quietpls/`

### What it measures (and doesn't)

quietpls measures your microphone's digital level and compares it with the
level you calibrated as your normal speaking voice on that mic. It does not
measure sound pressure in the room or what other people on the call hear
(meeting apps apply their own gain and noise processing). Keep the mic at a
steady distance and gain, and recalibrate after changing either. The speech
gate tells voice-like sound from silence, hum and clicks, but not _whose_
voice it is: sound from your speakers or people nearby can count as you, so
headphones give the most reliable results.

## Privacy

quietpls records nothing and sends nothing. Microphone audio is analyzed in
real time and discarded; only coarse session summaries (durations, zone
percentages) are stored locally, and you can delete them any time in
Settings → History. The only network traffic is the update check against
github.com (version metadata + signed update download) — no audio, telemetry
or usage data ever leaves your machine.

## License

[MIT](LICENSE)
