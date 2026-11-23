const { _electron: electron, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..", "..");

// Resolve the electron binary from the project's node_modules
const electronPath = require("electron");

/**
 * Launch the Electron app.
 * options.onboarding: start at first-run onboarding instead of past it.
 * options.args: extra command-line switches.
 * options.generalSettings: initial quietpls-general-settings.json contents.
 */
async function launchApp(options = {}) {
  // Fresh profile per launch: never reads or writes the real app's data.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "quietpls-e2e-"));
  // Past first-run onboarding, like a returning user.
  fs.writeFileSync(
    path.join(userData, "quietpls-app-state.json"),
    JSON.stringify({ onboardingComplete: !options.onboarding }),
  );
  if (options.generalSettings) {
    fs.writeFileSync(
      path.join(userData, "quietpls-general-settings.json"),
      JSON.stringify(options.generalSettings),
    );
  }
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(APP_ROOT, "main.js"), ...(options.args || [])],
    env: {
      ...process.env,
      QUIETPLS_E2E_TEST: "1",
      QUIETPLS_USER_DATA: userData,
      NODE_ENV: "test",
    },
  });

  // The shipped runtime: the supported Electron line (spec A5).
  expect(await app.evaluate(() => process.versions.electron)).toBe("43.8.12");

  // Wait for the first window (main pill window)
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  return { app, window };
}

/**
 * Get the main widget window (index.html) by URL, since the title "quietpls"
 * also appears in the onboarding window title "Welcome to quietpls".
 */
async function getWidgetWindow(electronApp, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const windows = electronApp.windows();
    for (const win of windows) {
      const url = await win.url();
      if (url.includes("index.html")) {
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Widget window (index.html) not found within ${timeoutMs}ms`);
}

/**
 * Dismiss first-launch onboarding through the real UI (Skip, or Start
 * Monitoring on the last step) so the widget is in its post-onboarding state.
 * No-op when onboarding is already complete.
 */
async function dismissOnboardingIfNeeded(electronApp, timeoutMs = 5000) {
  const onboarding = await findWindowByUrl(
    electronApp,
    "onboarding.html",
    2000,
  ).catch(() => null);
  if (!onboarding) return false;

  const skip = onboarding.locator("#skipBtn");
  const start = onboarding.locator("#startMonitoringBtn");
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  } else if (await start.isVisible().catch(() => false)) {
    await start.click();
  } else {
    // Wait for the step to render its nav buttons, then retry once
    await onboarding.waitForTimeout(1000);
    if (await skip.isVisible().catch(() => false)) await skip.click();
    else await start.click();
  }

  // Wait for the onboarding window to close
  const startWait = Date.now();
  while (Date.now() - startWait < timeoutMs) {
    const stillThere = await findWindowByUrl(
      electronApp,
      "onboarding.html",
      100,
    ).catch(() => null);
    if (!stillThere) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Onboarding window did not close");
}

async function findWindowByUrl(electronApp, urlSubstring, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const windows = electronApp.windows();
    for (const win of windows) {
      const url = await win.url();
      if (url.includes(urlSubstring)) {
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Window with URL containing "${urlSubstring}" not found within ${timeoutMs}ms`,
  );
}

/**
 * Reset the settings store in the main process to the given values.
 * Uses dynamic import — the Electron 40 main process is ESM and has no require().
 */
async function setSettingsStore(app, values) {
  await app.evaluate(
    async (electron, { vals }) => {
      const { default: Store } = await import("electron-store");
      const store = new Store({ name: "quietpls-settings" });
      for (const [key, value] of Object.entries(vals)) {
        store.set(key, value);
      }
    },
    { vals: values },
  );
}

/**
 * Read the settings store from the main process.
 */
async function getSettingsStore(app) {
  // Read the persisted file directly (the ESM main process has no dynamic
  // import callback inside evaluate()).
  const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
  const file = path.join(userData, "quietpls-settings.json");
  const data = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  return { sensitivity: data.sensitivity, audioDeviceId: data.audioDeviceId };
}

// Recorded speech fixture (S1 commits it; 16 kHz mono 16-bit).
const SPEECH_WAV = path.join(APP_ROOT, "tests", "fixtures", "speech-tts.wav");

/**
 * Replace the microphone in `page` with a scripted voice at a level the test
 * controls. By default a synthetic voice: a 400 Hz sawtooth in 150 ms
 * syllables (speech-like for the gate). With options.wav (a file path) the
 * recorded PCM loops instead: AudioBufferSourceNode -> gain ->
 * MediaStreamDestination, and setLevelDb(0) is the file's own level. Only the
 * physical microphone is replaced; the app's real capture, worklet,
 * calibration and decisions run unchanged.
 * Also fakes the input devices (two by default; pass options.devices /
 * options.defaultId to choose). Exposes window.__fakeMic, whose
 * setDevices(devices, defaultId) simulates a mic (dis)connecting.
 */
async function installFakeMic(page, options = {}) {
  const opts = { ...options };
  if (opts.wav) opts.wav = fs.readFileSync(opts.wav).toString("base64");
  await page.evaluate(async (opts) => {
    if (window.__fakeMic) return;
    const ctx = new AudioContext();
    ctx.resume();
    let devices = opts.devices || [
      {
        kind: "audioinput",
        deviceId: "fake-builtin",
        groupId: "g-builtin",
        label: "Fake Built-in Mic",
      },
      {
        kind: "audioinput",
        deviceId: "fake-headset",
        groupId: "g-headset",
        label: "Fake Headset",
      },
    ];
    let defaultId = opts.defaultId || devices[0].deviceId;
    const systemDefault = () =>
      devices.find((d) => d.deviceId === defaultId) || devices[0];
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 400;
    const syllables = ctx.createGain();
    syllables.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = "square";
    lfo.frequency.value = 3.33;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.5;
    lfo.connect(lfoDepth).connect(syllables.gain);
    const level = ctx.createGain();
    if (opts.wav) {
      const bytes = Uint8Array.from(atob(opts.wav), (c) => c.charCodeAt(0));
      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(bytes.buffer);
      source.loop = true;
      source.connect(level);
      source.start();
    } else {
      osc.connect(syllables).connect(level);
      osc.start();
      lfo.start();
    }

    const state = { gumCalls: [], tracks: [] };
    const setLevelDb = (db) => {
      level.gain.setValueAtTime(
        db === null ? 0 : Math.pow(10, db / 20),
        ctx.currentTime,
      );
    };
    setLevelDb(opts.wav ? 0 : -30);

    navigator.mediaDevices.enumerateDevices = async () => [
      {
        kind: "audioinput",
        deviceId: "default",
        groupId: systemDefault().groupId,
        label: "Default - " + systemDefault().label,
      },
      ...devices,
    ];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      state.gumCalls.push(JSON.parse(JSON.stringify(constraints)));
      const exact =
        constraints.audio &&
        constraints.audio.deviceId &&
        constraints.audio.deviceId.exact;
      const dev = exact
        ? devices.find((d) => d.deviceId === exact)
        : systemDefault();
      if (!dev) {
        const err = new Error("Requested device not found");
        err.name = "NotFoundError";
        throw err;
      }
      const dest = ctx.createMediaStreamDestination();
      level.connect(dest);
      const track = dest.stream.getAudioTracks()[0];
      track.getSettings = () => ({
        deviceId: exact ? dev.deviceId : "default",
        groupId: dev.groupId,
      });
      Object.defineProperty(track, "label", {
        value: exact ? dev.label : "Default - " + dev.label,
      });
      state.tracks.push(track);
      return dest.stream;
    };

    window.__fakeMic = {
      setLevelDb,
      setDevices: (next, nextDefault) => {
        devices = next;
        defaultId = nextDefault || next[0].deviceId;
        navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
      },
      gumCalls: () => state.gumCalls,
      endCurrentTrack: () => {
        const t = state.tracks[state.tracks.length - 1];
        t.dispatchEvent(new Event("ended"));
      },
    };
  }, opts);
}

/**
 * Read-only observers for the loudness journey. In the widget page, wrap the
 * real decision tracker so each update still runs the original and records
 * frames, audio ms, talking ms (decision.speaking) and the latest
 * decision in window.__obs. In the main process, add a second level-update /
 * set-monitoring listener next to the real handlers. Nothing is replaced.
 * Call before monitoring starts.
 */
async function installObservers(app, page) {
  await page.evaluate(() => {
    const LL = window.LevelLogic;
    const obs = (window.__obs = {
      trackers: 0,
      frames: 0,
      audioMs: 0,
      acceptedMs: 0,
      decision: null,
      opts: null,
      changes: [], // { zone, audioMs, acceptedMs, wallMs } on each zone change
    });
    const create = LL.createDecisionTracker;
    LL.createDecisionTracker = (o) => {
      const t = create(o);
      obs.trackers++;
      obs.opts = o;
      return {
        ...t,
        update(frame, ctx) {
          const d = t.update(frame, ctx);
          if (frame) {
            obs.frames++;
            obs.audioMs += frame.frameMs || 0;
            if (d.speaking) obs.acceptedMs += frame.frameMs || 0;
          }
          if (!obs.decision || obs.decision.zone !== d.zone) {
            obs.changes.push({
              zone: d.zone,
              audioMs: obs.audioMs,
              acceptedMs: obs.acceptedMs,
              wallMs: Date.now(),
            });
            if (obs.changes.length > 500) obs.changes.shift();
          }
          obs.decision = d;
          return d;
        },
      };
    };
  });
  await app.evaluate(({ ipcMain }) => {
    globalThis.__obsMain = { level: null, monitoring: null };
    ipcMain.on("level-update", (_e, u) => (globalThis.__obsMain.level = u));
    ipcMain.on(
      "set-monitoring",
      (_e, v) => (globalThis.__obsMain.monitoring = v),
    );
  });
}

/** Snapshot of the page and main-process observations. */
async function observations(app, page) {
  const obs = await page.evaluate(() => ({ ...window.__obs }));
  obs.main = await app.evaluate(() => ({ ...globalThis.__obsMain }));
  return obs;
}

/**
 * Wait until guided calibration has heard about 10 s of talking, Skip the
 * louder/normal rehearsal (the saved normal is already stored), then press
 * Done on "This is your normal" so the widget is compact again.
 */
async function finishCalibration(page, timeout = 45000) {
  await expect(page.locator("#calTitle")).toHaveText(/a bit louder/, {
    timeout,
  });
  await page.locator("#calSecondaryBtn").click(); // Skip
  await expect(page.locator("#calTitle")).toHaveText("This is your normal");
  await page.locator("#calSecondaryBtn").click(); // Done
  await expect(page.locator("#compactPill")).toBeVisible();
}

/** Stop from the widget: open details if compact, then press its Stop. */
async function stopFromWidget(page) {
  const pill = page.locator("#compactPill");
  if (await pill.isVisible()) await pill.click();
  await page
    .locator("#stopBtn:visible, #calSecondaryBtn:visible")
    .filter({ hasText: /^Stop$/ })
    .click();
  await expect(page.locator("#expandedPanel")).not.toBeVisible({
    timeout: 5000,
  });
}

/** The native widget window's content bounds (main process). */
async function widgetBounds(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((b) =>
      b.webContents.getURL().includes("index.html"),
    );
    return w.getContentBounds();
  });
}

/**
 * CoreAudio transport types the main process reports instead of the real
 * Mac's (input-transports.js): [{ name, transport, isDefault }].
 */
async function setFakeTransports(app, inputs) {
  await app.evaluate((_electron, list) => {
    globalThis.__quietplsFakeTransports = list ? { inputs: list } : null;
  }, inputs);
}

/**
 * Get a BrowserWindow page by its title substring.
 * Waits up to timeoutMs for the window to appear.
 */
async function getWindow(electronApp, titleSubstring, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const windows = electronApp.windows();
    for (const win of windows) {
      const title = await win.title();
      if (title.includes(titleSubstring)) {
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Window with title containing "${titleSubstring}" not found within ${timeoutMs}ms`,
  );
}

module.exports = {
  SPEECH_WAV,
  installFakeMic,
  installObservers,
  observations,
  finishCalibration,
  stopFromWidget,
  widgetBounds,
  setFakeTransports,
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
  setSettingsStore,
  getSettingsStore,
  getWindow,
};
