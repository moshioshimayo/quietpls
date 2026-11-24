// Judge-panel screenshot harness (quietpls 2.5.0 plan §8, spec §12/§13).
//
// Drives the real app (Playwright Electron, fake mic, the existing e2e hooks)
// to each product-canvas cell and saves <cellId>.<light|dark>.png, plus
// <cellId>~<variant>.<theme>.png for extra states of the same cell and
// <cellId>~screen.<theme>.png full-screen shots for cells that sit over other
// windows. Native-only cells (menus, dialogs, About) are full-screen shots
// named <cellId>.<theme>.png. A cell that cannot reach its 2.5.0 state still
// gets a shot of what the build shows, flagged reached:false in manifest.json
// with what was seen; a cell that needs a missing test hook records the hook.
//
// Run (in the m16 guest only, from Terminal.app for the mic grant):
//   QP_SHOTS_DIR="$HOME/qp25-shots/round-1" npx playwright test tests/e2e/shots.spec.js
// Options: QP_SHOTS_THEMES=light,dark  QP_SHOTS_SCREEN=0|1 (in-guest
// `screencapture -x`, default on macOS)  QP_SHOTS_VIDEO=1 (Playwright window
// recordings)  QP_SHOTS_HOLD_MS=<ms> (Terminal has no Screen Recording grant
// in m16: hold each full-screen state with a HOLD-<file> marker while a
// watcher started through `cua sb exec` (cua-spacesd has the grant) runs
// `screencapture -x <file>` in the shots dir; see the judge README). One cell:
// `-g "P2.S9.E-9"`. Reruns merge into manifest.json.
const { test, expect } = require("@playwright/test");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("./helpers");

const OUT = process.env.QP_SHOTS_DIR;
const THEMES = (process.env.QP_SHOTS_THEMES || "light,dark").split(",");
const SCREEN = process.env.QP_SHOTS_SCREEN
  ? process.env.QP_SHOTS_SCREEN === "1"
  : process.platform === "darwin";
const VIDEO = process.env.QP_SHOTS_VIDEO === "1";
const HOLD_MS = Number(process.env.QP_SHOTS_HOLD_MS || 0);
const APP_ROOT = path.resolve(__dirname, "..", "..");

// Canvas fixtures (spec §10).
const MIC = {
  kind: "audioinput",
  deviceId: "fake-builtin",
  groupId: "g-builtin",
  label: "MacBook Pro Microphone",
};
const USB = {
  kind: "audioinput",
  deviceId: "fake-usb",
  groupId: "g-usb",
  label: "Shure MV7",
};
const ZOOM = "4242\tus.zoom.xos\n";

// ---- manifest ----

const manifest = { build: build(), cells: {} };
function build() {
  const git = (...a) => {
    try {
      return execFileSync("git", ["-C", APP_ROOT, ...a], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  return {
    version: require(path.join(APP_ROOT, "package.json")).version,
    sha: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
    takenAt: new Date().toISOString(),
    themes: THEMES,
  };
}

class MissingHook extends Error {
  constructor(hook, need) {
    super(`missing hook ${hook}: ${need}`);
    this.hook = hook;
    this.need = need;
  }
}

test.afterAll(() => {
  if (!OUT) return;
  const file = path.join(OUT, "manifest.json");
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const sameBuild = old.build && old.build.sha === manifest.build.sha;
  fs.writeFileSync(
    file,
    JSON.stringify(
      { build: manifest.build, cells: { ...(sameBuild ? old.cells : {}), ...manifest.cells } },
      null,
      2,
    ),
  );
});

// ---- context helpers ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pill = (w) => w.getByRole("button", { name: /^quietpls:/ });
const button = (page, name) => page.getByRole("button", { name });

/** Launch for one cell. opts: profile ("warm" | dir), files, env, onboarding, mic. */
async function open(c, opts = {}) {
  const profile = opts.profile === "warm" ? await warmProfile() : opts.profile;
  const launched = await H.launchApp({
    profile,
    files: opts.files,
    env: opts.env,
    onboarding: opts.onboarding,
    recordVideo: VIDEO && {
      dir: path.join(OUT, "recordings", `${c.cell.id}.${c.theme || "all"}`),
    },
  });
  c.app = launched.app;
  c.userData = launched.userData;
  await H.setTheme(c.app, c.theme || THEMES[0]);
  if (opts.onboarding) return c;
  c.w = await H.getWidgetWindow(c.app, 10000);
  await c.w.waitForLoadState("domcontentloaded");
  if (opts.mic !== false) await H.installFakeMic(c.w, { devices: [MIC], ...opts.mic });
  await sleep(500);
  return c;
}

/** Shoot `page` in every theme (one theme for native cells). page null = screen only. */
async function shoot(c, page, variant, { fullScreen = c.cell.screen } = {}) {
  const base = c.cell.id + (variant ? `~${variant}` : "");
  const themes = c.cell.native ? [c.theme] : THEMES;
  for (const theme of themes) {
    if (!c.cell.native) {
      await H.setTheme(c.app, theme);
      await sleep(500);
    }
    if (page) {
      const file = `${base}.${theme}.png`;
      await page.screenshot({ path: path.join(OUT, file), omitBackground: true });
      c.files.push(file);
    }
    if (!page || (fullScreen && (SCREEN || HOLD_MS))) {
      await screen(c, page ? `${base}~screen.${theme}.png` : `${base}.${theme}.png`);
    }
  }
  if (!c.cell.native) await H.setTheme(c.app, THEMES[0]);
}

async function screen(c, file) {
  if (SCREEN) {
    try {
      execFileSync("screencapture", ["-x", "-t", "png", path.join(OUT, file)]);
      c.files.push(file);
      return;
    } catch (e) {
      c.notes.push(`screencapture failed for ${file}: ${e.message.split("\n")[0]}`);
    }
  }
  if (HOLD_MS) {
    const marker = path.join(OUT, `HOLD-${file}`);
    fs.writeFileSync(marker, `cua sb screenshot local:m16 -o ${file}\n`);
    await sleep(HOLD_MS);
    fs.rmSync(marker, { force: true });
    if (fs.existsSync(path.join(OUT, file))) c.files.push(file);
    else c.notes.push(`${file}: held ${HOLD_MS} ms, no screenshot arrived`);
  } else {
    c.notes.push(`${file}: needs a full-screen VM shot (cua sb screenshot local:m16)`);
  }
}

/** Wait until the page's visible text matches; record what was seen if not. */
async function reach(c, page, re, timeout = 10000) {
  let text = "";
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    text = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (re.test(text)) return true;
    await sleep(250);
  }
  c.reached = false;
  c.notes.push(`no ${re} in ${timeout} ms; saw: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
  return false;
}

/** Same, on the pill's accessible name ("quietpls: {state}. Show details"). */
async function reachPill(c, re, timeout = 15000) {
  let name = "";
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    name = (await pill(c.w).getAttribute("aria-label").catch(() => "")) || "";
    if (re.test(name)) return true;
    await sleep(250);
  }
  c.reached = false;
  c.notes.push(`pill never ${re} in ${timeout} ms; last: ${name}`);
  return false;
}

/** Click the first visible candidate (selector string or locator). */
async function clickAny(c, page, candidates, what) {
  for (const cand of candidates) {
    const l = (typeof cand === "string" ? page.locator(cand) : cand).first();
    if (await l.isVisible().catch(() => false)) {
      await l.click();
      return true;
    }
  }
  c.reached = false;
  c.notes.push(`no visible control for ${what}`);
  return false;
}

const shows = (l, timeout = 1500) =>
  l.first().waitFor({ state: "visible", timeout }).then(() => true, () => false);
const level = (c, db) => c.w.evaluate((d) => window.__fakeMic.setLevelDb(d), db);
const mainEmit = (c, channel) =>
  c.app.evaluate(({ ipcMain }, ch) => setTimeout(() => ipcMain.emit(ch, {}), 0), channel);
/** Call globalThis.__quietplsE2E[name](arg) in main, deferred (menus/dialogs block). */
async function hook(c, name, arg, need) {
  const ok = await c.app.evaluate(
    (_e, [n, a]) => {
      const h = globalThis.__quietplsE2E;
      if (!h || typeof h[n] !== "function") return false;
      setTimeout(() => h[n](a), 0);
      return true;
    },
    [name, arg],
  );
  if (!ok) throw new MissingHook(`__quietplsE2E.${name}`, need);
}

/** Click the pill; the 2.5.0 "ready to start" panel then needs Start. */
async function startVoiceSetup(c) {
  await pill(c.w).click();
  if (await shows(button(c.w, /^Start$/))) await button(c.w, /^Start$/).click();
}

/** Saved normal voice: click the pill (starts monitoring, opens details), then collapse. */
async function startMonitoring(c, { collapse = true } = {}) {
  await pill(c.w).click();
  await sleep(800);
  if (collapse) await c.w.keyboard.press("Escape");
  await sleep(300);
}

async function openDetails(c) {
  if (await pill(c.w).isVisible()) await pill(c.w).click();
  await sleep(600);
}

async function stopFromDetails(c) {
  await openDetails(c);
  await clickAny(c, c.w, [button(c.w, /^Stop$/)], "Stop");
}

async function openSettings(c, tab) {
  await mainEmit(c, "open-settings");
  const s = await H.findWindowByUrl(c.app, "settings.html", 10000);
  await s.waitForLoadState("domcontentloaded");
  await sleep(800);
  if (tab) {
    await clickAny(
      c,
      s,
      [s.getByRole("tab", { name: tab }), s.getByRole("button", { name: tab, exact: true }), `[data-tab="${tab.toLowerCase()}"]`],
      `${tab} tab`,
    );
    await sleep(800);
  }
  return s;
}

/** Restart the widget page with mic access reported as `status` (B4). */
async function micAccess(c, status) {
  await H.setMicAccess(c.app, status);
  await c.w.reload();
  await c.w.waitForLoadState("domcontentloaded");
  await H.installFakeMic(c.w, { devices: [MIC], deny: status !== "granted" });
  await sleep(1500);
}

/** Calibration then louder check (2.4.3 calls it the rehearsal). Needs the wav mic. */
async function toLouderCheck(c) {
  await startVoiceSetup(c);
  return reach(c, c.w, /Try the feedback|a bit louder/i, 50000);
}

// A profile with a saved normal voice for MacBook Pro Microphone, made once
// per run through the real calibration path and copied for each cell.
let warmDir = null;
async function warmProfile() {
  if (warmDir) return warmDir;
  const { app, userData } = await H.launchApp();
  try {
    const w = await H.getWidgetWindow(app, 10000);
    await H.installFakeMic(w, { devices: [MIC], wav: H.SPEECH_WAV });
    await pill(w).click();
    if (await shows(button(w, /^Start$/))) await button(w, /^Start$/).click();
    await expect
      .poll(() => w.evaluate(() => window.electronAPI.getCalibration("fake-builtin")), {
        timeout: 60000,
      })
      .toBeTruthy();
  } finally {
    await H.closeApp(app);
  }
  fs.rmSync(path.join(userData, "sessions.json"), { force: true });
  warmDir = userData;
  return warmDir;
}

// History fixture (spec §10): times are local, relative to today.
function sessionsFixture() {
  const day = (back, h, m) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const rows = [
    [day(0, 9, 4), 24, 71, 18, 11, day(0, 9, 21)],
    [day(1, 15, 30), 52, 90, 8, 2],
    [day(1, 11, 0), 31, 96, 4, 0],
    [day(4, 14, 15), 18, 62, 23, 15],
  ];
  const sessions = rows.map(([start, min, n, w, l, peak], i) => {
    const duration = min * 60;
    const speaking = Math.round(duration * 0.55);
    return {
      id: `fixture-${i + 1}`,
      algorithmVersion: 3,
      mic: { deviceId: MIC.deviceId, label: MIC.label },
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + duration * 1000).toISOString(),
      duration,
      coveredTime: duration,
      gapTime: 0,
      speakingTime: speaking,
      zoneTime: {
        silent: duration - speaking,
        normal: (speaking * n) / 100,
        warning: (speaking * w) / 100,
        danger: (speaking * l) / 100,
      },
      tooLoudRatio: l / 100,
      gettingLoudRatio: w / 100,
      volumeSamples: [],
      peakMoments: peak ? [{ timestamp: peak.toISOString(), value: 12 }] : [],
      silenceRatio: (duration - speaking) / duration,
      speakingPace: 4,
      volumeVariance: 6,
      savedAt: new Date(start.getTime() + duration * 1000).toISOString(),
    };
  });
  // A pre-2.1 session (no algorithmVersion): shown as "Before 2.1".
  const legacy = day(12, 10, 15);
  sessions.push({
    id: "fixture-legacy",
    startTime: legacy.toISOString(),
    endTime: new Date(legacy.getTime() + 720000).toISOString(),
    duration: 720,
    zoneTime: { silent: 200, quiet: 100, normal: 380, loud: 40 },
    volumeSamples: [],
    peakMoments: [],
    silenceRatio: 0.28,
    speakingPace: 3,
    volumeVariance: 8,
    savedAt: legacy.toISOString(),
  });
  return sessions;
}

function gitRepo({ remote = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quietpls-shots-notes-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  if (remote)
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.com/fake/notes.git"]);
  return dir;
}

/** Capture (beta) with the e2e fakes: no mic, system audio or whisper. */
function captureOpts({ enabled = true, model = true, remote = false, profile = "warm" } = {}) {
  const files = { "capture-settings.json": { enabled, folder: gitRepo({ remote }) } };
  if (model) files["models/ggml-base.en.bin"] = "fake";
  return { profile, files, env: { QUIETPLS_CAPTURE_FAKES: "1" } };
}
const setMicUsers = (c, out) =>
  c.app.evaluate((_e, o) => {
    globalThis.__quietplsFakeMicUsers = o;
  }, out);

// ---- the cells (canvas/map.json ids) ----
// screen: also a full-screen shot (the cell sits over other windows).
// native: the surface is a native menu/dialog: full-screen shots only, one
// launch per theme so the menu/dialog opens in that appearance.

const CELLS = [
  // S1 floating pill
  {
    id: "P2.S1.first-run",
    screen: true,
    async run(c) {
      await open(c);
      await shoot(c, c.w);
    },
  },
  {
    id: "P2.S1.default",
    screen: true,
    timeout: 120000,
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await level(c, null);
      await shoot(c, c.w, "off", { fullScreen: false });
      await startMonitoring(c);
      if (await reachPill(c, /Listening/)) await shoot(c, c.w, "listening", { fullScreen: false });
      await level(c, 0);
      if (await reachPill(c, /Normal/)) await shoot(c, c.w);
      await level(c, 7);
      if (await reachPill(c, /Getting loud/)) await shoot(c, c.w, "getting-loud", { fullScreen: false });
      await level(c, 12);
      if (await reachPill(c, /Ease your voice/)) await shoot(c, c.w, "ease");
    },
  },
  {
    id: "P2.S1.denied",
    screen: true,
    async run(c) {
      await open(c, { profile: "warm" });
      await micAccess(c, "denied");
      if (!/access/i.test((await pill(c.w).getAttribute("aria-label")) || "")) {
        await pill(c.w).click(); // 2.4.3 only learns it on start
        await sleep(800);
        await c.w.keyboard.press("Escape");
      }
      await reachPill(c, /access/i, 5000);
      await shoot(c, c.w);
    },
  },
  {
    id: "P2.S1.error",
    screen: true,
    timeout: 90000,
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await startMonitoring(c);
      await reachPill(c, /Normal|Listening/);
      await c.w.evaluate(() => {
        window.__fakeMic.setDevices([]);
        window.__fakeMic.endCurrentTrack();
      });
      if (await reachPill(c, /Reconnecting/i, 5000)) await shoot(c, c.w, "reconnecting");
      await reachPill(c, /unavailable/i, 40000);
      await shoot(c, c.w);
    },
  },

  // S2 details panel
  {
    id: "P2.S2.default",
    screen: true,
    timeout: 60000,
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await startMonitoring(c);
      await level(c, 7);
      await reachPill(c, /Getting loud/);
      await openDetails(c);
      await reach(c, c.w, /dB/);
      await shoot(c, c.w);
    },
  },
  {
    id: "P2.S2.loading",
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await level(c, null);
      await startMonitoring(c, { collapse: false });
      await reach(c, c.w, /Listening/);
      await sleep(1500);
      await shoot(c, c.w);
    },
  },
  {
    id: "P2.S2.denied",
    async run(c) {
      await open(c, { profile: "warm" });
      await micAccess(c, "denied");
      await openDetails(c);
      await reach(c, c.w, /System Settings|access/i);
      await shoot(c, c.w);
    },
  },
  {
    id: "P2.S2.error",
    timeout: 90000,
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await startMonitoring(c);
      await reachPill(c, /Normal|Listening/);
      await c.w.evaluate(() => {
        window.__fakeMic.setDevices([]);
        window.__fakeMic.endCurrentTrack();
      });
      await reachPill(c, /unavailable/i, 40000);
      await openDetails(c);
      await shoot(c, c.w);
    },
  },
  {
    id: "P2.S2.E-1",
    timeout: 60000,
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await startMonitoring(c);
      await reachPill(c, /Normal/);
      await c.w.evaluate((devs) => window.__fakeMic.setDevices(devs, "fake-usb"), [
        { kind: "audioinput", deviceId: "fake-builtin", groupId: "g-builtin", label: "MacBook Pro Microphone" },
        { kind: "audioinput", deviceId: "fake-usb", groupId: "g-usb", label: "Shure MV7" },
      ]);
      await sleep(1500);
      await openDetails(c);
      await reach(c, c.w, /New mic|Shure MV7/, 15000);
      await shoot(c, c.w);
    },
  },

  // S3 voice setup (in the panel)
  {
    id: "P1.S3.default",
    async run(c) {
      await open(c, { mic: { wav: H.SPEECH_WAV } });
      await level(c, null);
      await pill(c.w).click(); // 2.5.0: ready to start; 2.4.3: listening at 0 s
      await reach(c, c.w, /normal voice/i);
      await shoot(c, c.w);
    },
  },
  {
    id: "P1.S3.loading",
    timeout: 60000,
    async run(c) {
      await open(c, { mic: { wav: H.SPEECH_WAV } });
      await startVoiceSetup(c);
      await reach(c, c.w, /\b[3-6] of 10 seconds/, 30000);
      await shoot(c, c.w);
    },
  },
  {
    id: "P1.S3.success",
    timeout: 120000,
    async run(c) {
      await open(c, { mic: { wav: H.SPEECH_WAV } });
      await startVoiceSetup(c);
      await reach(c, c.w, /Normal voice saved|a bit louder/i, 50000);
      if (/a bit louder/i.test(await c.w.evaluate(() => document.body.innerText))) {
        // 2.4.3 says "saved" only after its rehearsal.
        await level(c, 8);
        await reach(c, c.w, /back to your normal/i, 15000);
        await level(c, 0);
        await reach(c, c.w, /This is your normal/i, 16000);
      }
      await shoot(c, c.w);
    },
  },
  {
    id: "P1.S3.error",
    timeout: 90000,
    async run(c) {
      // Quiet room noise: listened time runs out with no talking accepted.
      await open(c, { mic: { wav: H.SPEECH_WAV } });
      await level(c, -45);
      await startVoiceSetup(c);
      await reach(c, c.w, /Try voice setup again|Try again|didn.t hear|no talking/i, 60000);
      await shoot(c, c.w);
    },
  },
  {
    id: "P1.S3.E-2",
    timeout: 120000,
    async run(c) {
      await open(c, { mic: { wav: H.SPEECH_WAV } });
      await startVoiceSetup(c);
      await reach(c, c.w, /\b[78] of 10 seconds/, 40000);
      await level(c, -45);
      await reach(c, c.w, /Almost there/i, 50000);
      await shoot(c, c.w);
    },
  },
  {
    id: "P1.S3.E-3",
    timeout: 60000,
    async run(c) {
      await open(c, { mic: { steady: true } });
      await level(c, -20);
      await startVoiceSetup(c);
      await reach(c, c.w, /steady noise/i, 25000);
      await shoot(c, c.w);
    },
  },
  {
    id: "P1.S3.E-4",
    timeout: 60000,
    async run(c) {
      await open(c);
      await level(c, 25); // clipping
      await startVoiceSetup(c);
      await reach(c, c.w, /too strong/i, 20000);
      await shoot(c, c.w);
    },
  },

  // S4 louder check
  {
    id: "P1.S4.default",
    timeout: 90000,
    async run(c) {
      await open(c, { mic: { wav: H.SPEECH_WAV } });
      await toLouderCheck(c);
      await sleep(1000);
      await shoot(c, c.w);
    },
  },
  {
    id: "P1.S4.success",
    timeout: 90000,
    async run(c) {
      await open(c, { mic: { wav: H.SPEECH_WAV } });
      await toLouderCheck(c);
      await level(c, 8);
      await reach(c, c.w, /cue you.ll see|read as Getting loud/i, 15000);
      await shoot(c, c.w);
      // AC-P7: after first setup, the one-time tip under the pill.
      if (await shows(button(c.w, /^Done$/), 8000)) {
        await button(c.w, /^Done$/).click();
        await sleep(700);
        await shoot(c, c.w, "tip");
      }
    },
  },
  {
    id: "P1.S4.E-5",
    timeout: 90000,
    async run(c) {
      await open(c, { mic: { wav: H.SPEECH_WAV } });
      await toLouderCheck(c);
      await reach(c, c.w, /check skipped|This is your normal/i, 25000);
      await shoot(c, c.w);
    },
  },

  // S5 setup window
  {
    id: "P1.S5.default",
    async run(c) {
      await open(c, { onboarding: true });
      const o = await H.findWindowByUrl(c.app, "onboarding.html", 10000);
      await reach(c, o, /Welcome|Get started/i);
      await shoot(c, o);
    },
  },
  {
    id: "P1.S5.first-run",
    async run(c) {
      await open(c, { onboarding: true });
      await H.setMicAccess(c.app, "not-determined");
      const o = await H.findWindowByUrl(c.app, "onboarding.html", 10000);
      await o.reload();
      await clickAny(c, o, [button(o, /Get started/i)], "Get started");
      await reach(c, o, /Microphone/i);
      await shoot(c, o);
    },
  },
  {
    id: "P1.S5.success",
    async run(c) {
      await open(c, { onboarding: true });
      await H.setMicAccess(c.app, "granted");
      const o = await H.findWindowByUrl(c.app, "onboarding.html", 10000);
      await o.reload();
      await o.waitForLoadState("domcontentloaded");
      await H.installFakeMic(o, { devices: [MIC], wav: H.SPEECH_WAV });
      await clickAny(c, o, [button(o, /Get started/i)], "Get started");
      // 2.5.0 skips step 2 when access is granted; 2.4.3 shows it.
      const next = button(o, /^(Continue|Allow Microphone)$/i);
      if (await shows(next)) await next.click();
      await reach(c, o, /Mic is responding|Hearing you/i, 15000);
      await shoot(c, o);
    },
  },
  {
    id: "P1.S5.denied",
    async run(c) {
      await open(c, { onboarding: true });
      await H.setMicAccess(c.app, "denied");
      const o = await H.findWindowByUrl(c.app, "onboarding.html", 10000);
      await o.reload();
      await clickAny(c, o, [button(o, /Get started/i)], "Get started");
      await reach(c, o, /access is off|denied/i);
      await shoot(c, o);
    },
  },
  {
    id: "P1.S5.E-6",
    async run(c) {
      await open(c, { onboarding: true });
      await H.setMicAccess(c.app, "restricted");
      const o = await H.findWindowByUrl(c.app, "onboarding.html", 10000);
      await o.reload();
      await clickAny(c, o, [button(o, /Get started/i)], "Get started");
      await reach(c, o, /organization|restricted/i);
      await shoot(c, o);
    },
  },

  // S6 session summary (needs a real >= 60 s session)
  {
    id: "P2.S6.default",
    screen: true,
    timeout: 150000,
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await startMonitoring(c);
      for (const [db, s] of [[0, 30], [7, 15], [12, 18]]) {
        await level(c, db);
        await sleep(s * 1000);
      }
      await level(c, 0);
      await stopFromDetails(c);
      await reach(c, c.w, /summary|speaking time|Done/i);
      await shoot(c, c.w);
    },
  },
  {
    id: "P2.S6.empty",
    timeout: 150000,
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await level(c, null);
      await startMonitoring(c);
      await sleep(63000);
      await stopFromDetails(c);
      await reach(c, c.w, /No talking detected/i, 5000);
      await shoot(c, c.w);
    },
  },

  // S7 menu bar, menus and native dialogs
  {
    id: "P2.S7.default",
    native: true,
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await startMonitoring(c);
      await hook(c, "popUpTrayMenu", undefined, "open the menu-bar menu as a click would (B1)");
      await sleep(800);
      await shoot(c, null);
    },
  },
  {
    id: "P2.S7.success",
    native: true,
    async run(c) {
      await open(c, { profile: "warm" });
      await hook(c, "checkForUpdates", { result: "none" }, "manual update check with a stubbed 'up to date' result, unpackaged");
      await sleep(1200);
      await shoot(c, null);
    },
  },
  {
    id: "P2.S7.E-7",
    native: true,
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await startMonitoring(c);
      await c.app.evaluate(() => {
        const { autoUpdater } = process.mainModule.require("electron-updater");
        setTimeout(() => autoUpdater.emit("update-downloaded", { version: "2.5.1" }), 0);
      });
      await sleep(1200);
      await shoot(c, null); // 2.5.0: no modal while monitoring
      await hook(c, "popUpTrayMenu", undefined, "menu shows Restart to Update (2.5.1)");
      await sleep(800);
      await shoot(c, null, "menu");
    },
  },
  {
    id: "P2.S7.E-8",
    native: true,
    async run(c) {
      await open(c, { profile: "warm" });
      const own = await c.app.evaluate(() => {
        const h = globalThis.__quietplsE2E;
        if (!h || typeof h.showAbout !== "function") return false;
        setTimeout(() => h.showAbout(), 0);
        return true;
      });
      if (!own) await mainEmit(c, "show-about");
      await sleep(1000);
      await shoot(c, null);
    },
  },

  // S8 / S9 Settings
  {
    id: "P2.S8.default",
    async run(c) {
      await open(c, { profile: "warm", mic: { wav: H.SPEECH_WAV } });
      await startMonitoring(c);
      const s = await openSettings(c);
      await reach(c, s, /Microphone|Mic/);
      await shoot(c, s);
    },
  },
  {
    id: "P2.S8.denied",
    async run(c) {
      await open(c, { profile: "warm" });
      await micAccess(c, "denied");
      const s = await openSettings(c);
      await reach(c, s, /access is off|access/i, 5000);
      await shoot(c, s);
    },
  },
  {
    id: "P2.S9.default",
    async run(c) {
      await open(c, { profile: "warm", files: { "sessions.json": sessionsFixture() } });
      const s = await openSettings(c, "History");
      await shoot(c, s);
    },
  },
  {
    id: "P2.S9.empty",
    async run(c) {
      await open(c, { profile: "warm" });
      const s = await openSettings(c, "History");
      await reach(c, s, /No sessions yet|no sessions/i, 5000);
      await shoot(c, s);
    },
  },
  {
    id: "P2.S9.error",
    async run(c) {
      await open(c, { profile: "warm", files: { "sessions.json": "{ not json" } });
      const s = await openSettings(c, "History");
      await reach(c, s, /Couldn.t load history/i, 5000);
      await shoot(c, s);
    },
  },
  {
    id: "P2.S9.E-9",
    async run(c) {
      await open(c, { profile: "warm", files: { "sessions.json": sessionsFixture() } });
      const s = await openSettings(c, "History");
      const row = s.locator("[data-session-id], .session-card").first();
      await row.hover().catch(() => {});
      await clickAny(c, s, [button(s, /Delete session/i), '[data-action="delete"]'], "row delete control");
      await reach(c, s, /Delete this session|delete/i, 5000);
      await shoot(c, s);
    },
  },
  {
    id: "P2.S9.E-10",
    async run(c) {
      await open(c, { profile: "warm", files: { "sessions.json": sessionsFixture() } });
      const s = await openSettings(c, "History");
      await clickAny(c, s, ["[data-session-id]", ".session-card"], "first session row");
      await sleep(800);
      await shoot(c, s);
    },
  },

  // S10 Capture settings
  ...[
    ["P3.S10.default", {}],
    ["P3.S10.first-run", { model: false }],
  ].map(([id, o]) => ({
    id,
    async run(c) {
      await open(c, captureOpts(o));
      const s = await openSettings(c);
      await s.locator("#captureSection, [data-section=capture]").first().scrollIntoViewIfNeeded().catch(() => {});
      await reach(c, s, /Capture/);
      await shoot(c, s);
      if (await clickAny(c, s, [button(s, /Capture settings/i)], "Capture settings…")) {
        const win = await H.findWindowByUrl(c.app, "renderer/main.html", 10000);
        await sleep(1000);
        await shoot(c, win, "window");
      }
    },
  })),

  // S11 call prompt and recording (Capture e2e fakes)
  {
    id: "P3.S11.default",
    screen: true,
    async run(c) {
      await open(c, { ...captureOpts(), mic: { wav: H.SPEECH_WAV } });
      await startMonitoring(c, { collapse: false }); // AC-X10: banner below details
      await setMicUsers(c, ZOOM);
      const b = await H.findWindowByUrl(c.app, "banner.html", 15000);
      await reach(c, b, /Record/);
      await shoot(c, b);
    },
  },
  {
    id: "P3.S11.error",
    async run(c) {
      await open(c, captureOpts({ remote: true }));
      await setMicUsers(c, ZOOM);
      const b = await H.findWindowByUrl(c.app, "banner.html", 15000);
      await reach(c, b, /remote/i);
      await shoot(c, b);
    },
  },
  {
    id: "P3.S11.success",
    screen: true,
    timeout: 90000,
    async run(c) {
      await open(c, captureOpts());
      await setMicUsers(c, ZOOM);
      const b = await H.findWindowByUrl(c.app, "banner.html", 15000);
      await clickAny(c, b, [button(b, /Record this call/i), "#accept"], "Record this call");
      const ind = await H.findWindowByUrl(c.app, "indicator.html", 15000);
      if (await reach(c, ind, /REC|Recording/i)) await shoot(c, ind, "recording");
      await setMicUsers(c, "");
      await reach(c, ind, /saved/i, 40000);
      await shoot(c, ind);
    },
  },
];

// ---- runner ----

test.describe("judge shots", () => {
  test.skip(!OUT, "set QP_SHOTS_DIR");
  test.beforeAll(() => OUT && fs.mkdirSync(OUT, { recursive: true }));

  for (const cell of CELLS) {
    test(cell.id, async () => {
      test.setTimeout((cell.timeout || 45000) * (cell.native ? THEMES.length : 1) + 90000);
      const entry = { reached: true, files: [], notes: [], native: Boolean(cell.native) };
      manifest.cells[cell.id] = entry;
      for (const theme of cell.native ? THEMES : [null]) {
        const c = { cell, theme, files: entry.files, notes: entry.notes, reached: true };
        try {
          await cell.run(c);
        } catch (e) {
          if (!(e instanceof MissingHook)) {
            entry.error = String(e.message || e).split("\n")[0];
            throw e;
          }
          entry.missingHook = { hook: e.hook, need: e.need };
        } finally {
          entry.reached = entry.reached && c.reached;
          if (c.app) await H.closeApp(c.app);
        }
      }
      if (entry.missingHook && !entry.files.length) {
        entry.reached = false;
        test.skip(true, entry.missingHook.hook);
      }
    });
  }
});
