# quietpls

A floating macOS audio-level monitor for calls and meetings — a small
glassmorphic pill that shows how loud you are, in real time, all local.

**v2.0 is local-only.** No account, no cloud, no telemetry. Your audio never
leaves the machine: audio is analyzed in-memory and nothing is ever recorded
or transmitted. Sessions and settings live in a local store on your disk.

## Features

- 💊 **Compact pill widget** — always-on-top, tiny footprint, canvas waveform
- 🎚️ **Real-time dB readout + FFT spectrum** in the expanded panel
- 🎨 **Zones with acoustic-research defaults** — Quiet ≤30 dB, Normal ≤50 dB,
  Loud ≤78 dB, Too loud >78 dB (fully adjustable in Settings)
- 🧠 **Auto-calibration** — per-microphone calibration so thresholds match
  your actual input device
- 🗣️ **Meeting detection** — notices when a call is happening and adapts
- 📊 **Session scorecard** — after each ≥60s session: duration, insights, and
  how much of it you spent in each zone (kept locally in History)
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
- `volume-processor.js` — audio analysis in a utility process (out of the UI
  thread)
- `meeting-detector.js`, `session-tracker.js`, `session-grader.js`,
  `session-insights.js` — session intelligence, all local
- `calibration-manager.js` — per-device mic calibration
- Sessions history and settings: `~/Library/Application Support/quietpls/`

## Privacy

quietpls records nothing and sends nothing. Microphone audio is analyzed in
real time and discarded; only coarse session summaries (durations, zone
percentages) are stored locally, and you can delete them any time in
Settings → History. The only network traffic is the update check against
github.com (version metadata + signed update download) — no audio, telemetry
or usage data ever leaves your machine.

## License

[MIT](LICENSE)
