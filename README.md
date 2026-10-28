# quietpls

A floating macOS mic-level monitor for calls and meetings — a small
glassmorphic pill that reminds you when you get louder than your comfortable
baseline, in real time, all local.

**v2.0 is local-only.** No account, no cloud, no telemetry. Your audio never
leaves the machine: monitoring analyzes audio in memory and never records or
transmits it. Sessions and settings live in a local store on your disk.

quietpls also has an optional [Capture (beta)](#capture-beta) mode that records
and transcribes calls you approve. It is off by default and separate from
monitoring.

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
- 📝 **Capture (beta), off by default** — asks at the start of each call,
  records only the calls you approve, transcribes them on this Mac. See below

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

npm run capture:verify  # Capture (beta): native build, unit tests, e2e with fake audio
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
- `capture/` — Capture (beta), see below; monitoring does not use it
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

## Capture (beta)

An opt-in mode that turns calls you approve into text transcripts. It is off
by default. Monitoring works the same whether it is on or off.

**What happens when it is on**

- When another app starts using the mic, quietpls shows a banner: _A call
  started in Zoom — Record this call / Not now / Never for Zoom_. Nothing is
  recorded unless you click Record for that call.
- While recording, the menu bar shows a red dot and the elapsed time, and a
  small REC indicator with a Stop button stays on screen. The pill stays the
  monitoring pill.
- It records two channels: your mic ("you") and the call's audio from the
  system audio output ("them"). The mic also hears anyone else in the room;
  their speech is labeled "you".
- When the call app releases the mic (or you click Stop), the recording is
  transcribed on this Mac with [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
- The transcript is saved as one markdown file per call and committed to a
  local git repo in a folder you choose. A folder whose repo has a git remote
  is refused, both when you pick it and before every recording and save, so
  transcripts can't be pushed by accident.
- The audio is deleted after transcription by default. You can choose to keep
  it for a number of days instead; kept audio is never put in the git repo.

**Turning it on**: Settings → Capture (beta) → Record and transcribe calls.
Then open _Capture settings…_ to finish setup:

1. Install speech-to-text: `brew install whisper-cpp`.
2. Download a speech model. The size is shown before you download (75 MB to
   1.6 GB; the default `base.en` is 142 MB). Models come from Hugging Face and
   are stored in `~/Library/Application Support/quietpls/models`.
3. Choose the transcript folder.

macOS asks for microphone and System Audio Recording permission the first
time you record. Needs macOS 14.4 or later.

**View transcripts** (Settings or the menu bar) opens a window that lists,
searches and shows your transcripts.

**Speaker labels (optional)** split the far side into Speaker 1, Speaker 2…
using a local ONNX model. Setup downloads the 26 MB model into the same models
folder and Python dependencies via [uv](https://docs.astral.sh/uv/)
(`brew install uv`); labeling then runs offline. Labels are estimates and can
split one person into two; click a label to rename it.

**Always-on (optional)** records beyond calls. It needs a separate consent
where you type `ALWAYS ON`, shows a persistent red ALWAYS ON indicator, and
lasts only for the current session: it never starts at launch, even if it was
on when you quit. It records in 10-minute chunks with short gaps while each
chunk is transcribed. Always-on transcripts go to `ambient/` inside the
transcript folder, are excluded from git (never committed, so they don't stay
in git history) and are deleted after 24 hours. No always-on audio is kept.

### Transcript format

```markdown
---
title: "Zoom call"
start: 2026-10-27T22:42:44-04:00
end: 2026-10-27T22:43:31-04:00
duration: "00:00:47"
duration_seconds: 47
apps: ["Zoom"]
channels: { you: microphone, them: system audio }
transcriber: "whisper.cpp base.en"
audio: deleted
---

# Zoom call — Oct 27, 2026, 10:42 PM

[00:00:03] [them] Hi, thanks for joining. Can you walk me through the quarterly budget?
[00:00:08] [you] Sure, we spent $40,000 on cloud hosting and $12,000 on design.
```

### For agents: quietpls-mcp

`capture/mcp/server.js` is a read-only [MCP](https://modelcontextprotocol.io)
server over a transcripts folder. It speaks stdio, opens no port and never
writes to the folder. One tool: `search_transcripts({ query, from?, to?, limit? })`
returns matching transcript lines with context as markdown (every query word
must appear; an empty query returns recent transcripts; `from`/`to` are ISO
dates). Always-on transcripts in `ambient/` are included.

```bash
# from a checkout of this repo (Node 18+)
node capture/mcp/server.js ~/Transcripts
# or: npm link, then
quietpls-mcp ~/Transcripts
```

Example MCP client entry:

```json
{
  "mcpServers": {
    "quietpls": {
      "command": "node",
      "args": [
        "/path/to/quietpls/capture/mcp/server.js",
        "/Users/you/Transcripts"
      ]
    }
  }
}
```

### Known limits

- Echo cancellation is off (with macOS voice processing on, the system audio
  tap goes silent). On laptop speakers the mic also hears the far side; mic
  lines that repeat a nearby "them" line are dropped. Headphones avoid this.
- Call detection means "another app is using the mic"; it can't tell a call
  from, say, a voice memo. That is why every call asks first.
- Speech-to-text runs from your Homebrew `whisper-cli`; it is not bundled.

## Privacy

Monitoring records nothing and sends nothing. Microphone audio is analyzed in
real time and discarded; only coarse session summaries (durations, zone
percentages) are stored locally, and you can delete them any time in
Settings → History.

Capture (beta), only if you turn it on, records the calls you approve. Their
audio and transcripts stay on this Mac: audio in
`~/Library/Application Support/quietpls/capture-audio` until it is transcribed
(or for the days you chose to keep it), transcripts in the folder you chose.

Network traffic: the update check against github.com (version metadata +
signed update download), and, only when you start them from Capture settings,
the speech model download (Hugging Face) and the speaker-label setup (model
from GitHub, Python packages via uv). No audio, transcripts, telemetry or usage
data ever leave your machine.

## License

[MIT](LICENSE)
