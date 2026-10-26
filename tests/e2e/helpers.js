const { _electron: electron } = require("@playwright/test");
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

/**
 * Replace the microphone in `page` with a scripted synthetic voice: a 400 Hz
 * sawtooth in 150 ms syllables (speech-like for the gate), at a level the
 * test controls. Also fakes the input devices (two by default; pass
 * options.devices / options.defaultId to choose). Exposes window.__fakeMic,
 * whose setDevices(devices, defaultId) simulates a mic (dis)connecting.
 */
async function installFakeMic(page, options = {}) {
  await page.evaluate((opts) => {
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
    osc.connect(syllables).connect(level);
    osc.start();
    lfo.start();

    const state = { gumCalls: [], tracks: [] };
    const setLevelDb = (db) => {
      level.gain.setValueAtTime(
        db === null ? 0 : Math.pow(10, db / 20),
        ctx.currentTime,
      );
    };
    setLevelDb(-30);

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
  }, options);
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
  installFakeMic,
  setFakeTransports,
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
  setSettingsStore,
  getSettingsStore,
  getWindow,
};
