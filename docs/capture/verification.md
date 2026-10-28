# Capture (beta) — evidence, 2026-10-27

Integration of the meetings-only capture prototype into quietpls as an opt-in mode.
Quick rigor: focused checks only; no packaged/signed build, no review fleet.

## Automated

- `npm test`: 31 files, 620 tests pass (586 pre-existing + 34 capture under `tests/unit/capture/`).
- `npm run capture:verify`: native build, 34 capture unit tests, 3 Playwright specs
  (`tests/e2e/capture.spec.js`, fake mic users / recorder / transcriber; real git, files and IPC):
  - off by default: a mic user raises no banner; Settings shows Capture (beta) off; no settings file written;
  - Settings toggle → call → banner → Record → recording indicator → call ends → saved:
    one commit, `[you]`/`[them]` lines, `audio: deleted`, audio folder empty; transcripts window lists it;
    next call → Not now → nothing recorded; fake `origin` remote → banner says "has a remote",
    accept refuses, no commit, no audio;
  - always-on consent: Start disabled until `ALWAYS ON` is typed exactly; Cancel leaves it idle.
- `npm run test:e2e`: 27 pass, 2 skipped, 1 fails — `meeting-auto-start` "starts with a call and stops
  when it ends" (pill still monitoring 45 s after the ffmpeg call exits). It failed identically on the
  untouched base commit `b165ec1` in this worktree before any change, so it is pre-existing.

## Live simulated meeting (one run)

Unpackaged app, isolated profile (`QUIETPLS_E2E_TEST=1 QUIETPLS_USER_DATA=/tmp/qpl-live/data`), real
capture helper, real whisper.cpp 1.9.5 (`base.en`, downloaded through the real Download button:
147,964,211 bytes), real git. Driven over the dev FIFO (`QUIETPLS_CAPTURE_DEV`), clicking the real
banner button.

- Meeting app: `ffmpeg -f avfoundation -i :0 -f null -`, detected by quietpls's meeting detector as `ffmpeg`.
- Far side: three synthetic `say` lines (Samantha/Daniel) played with `afplay` as system audio.
- Helper: `started` mic 48 kHz mono + tap 48 kHz stereo → 26.9 s 16 kHz stereo WAV,
  `themPeak 0.578`, `youPeak 0.011` (below the 0.02 silence threshold, not transcribed).
  The mic delivered near-silence (a 5 s level-only pre-check read −91 dB; output was muted), so no
  room speech was captured or transcribed. The WAV split into you/them succeeded (it rejects non-stereo).
- Transcript committed as `28785ef` in the scratch repo, audio folder empty afterwards:

  ```text
  _No sound was heard from your microphone._

  [00:00:03] [them] Hi, thanks for joining. Can you walk me through the quarterly budget?
  [00:00:09] [them] Sure, we spent $40,000 on cloud hosting and $12,000 on design.
  [00:00:17] [them] Great, let's cut the design budget next quarter.
  ```

- Remote refusal: `git remote add origin https://example.com/fake/notes.git`, new call → banner
  "Can't record… has a remote", accept → `not recording: …has a remote`; HEAD unchanged, no new file,
  no audio. Remote removed.
- MCP: `npx @modelcontextprotocol/inspector --cli node capture/mcp/server.js /tmp/qpl-live/notes
--method tools/call --tool-name search_transcripts --tool-arg query=hosting --tool-arg limit=1`
  returned the call above as markdown (`isError: false`).

Scratch audio, model, profile and repo were deleted after the run.

## Screenshots (this folder)

Real Electron `capturePage` captures from the live run. `*-menubar-*.png` are drawn from the tray's
actual icon bitmap and title (the menu bar itself isn't capturable from the app).

| File                                                                             | State                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `1-settings-capture.png`                                                         | quietpls Settings → Capture (beta), on, before setup |
| `2-capture-settings.png`                                                         | Capture settings (transcripts window)                |
| `3-consent-banner.png`, `3-menubar-asking.png`                                   | call detected, asking                                |
| `4-recording-indicator.png`, `4-menubar-recording.png`, `4-recording-window.png` | recording                                            |
| `5-saved-indicator.png`, `5-menubar-saved.png`                                   | saved                                                |
| `6-transcripts.png`                                                              | transcripts window with the saved call               |
| `7-always-on-consent.png`                                                        | always-on typed consent (cancelled)                  |
| `8-remote-refused-banner.png`                                                    | banner refusing a repo with a remote                 |

Transcribing finished in under a second, so no live "transcribing" capture exists.

## Not verified

- Packaged/signed app: TCC prompts for the bundled `capture` helper, `NSAudioCaptureUsageDescription`,
  asarUnpacked speaker sidecar, `Resources/capture` path.
- A real person speaking into the mic (the mic channel was silent in this run); a real meeting app.
- Speaker labels in quietpls (ported module + unit test only; the sidecar run was verified in the prototype).
- A live always-on session (consent dialog only, to avoid recording bystanders).
