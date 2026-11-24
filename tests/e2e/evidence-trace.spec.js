// Machine-readable evidence for the judge panel's pleasantness items (one coherent
// setup, honest practice result, recovery). Real Electron with the recorded speech
// mic; macOS access is stubbed in main as in setup-window.spec.js. Each test asserts
// its item and records what it measured; afterAll writes evidence-trace.json to
// QP_EVIDENCE_DIR (default test-results/).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { test, expect } = require("@playwright/test");
const H = require("./helpers");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = process.env.QP_EVIDENCE_DIR || path.join(ROOT, "test-results");
const FAKE_MEDIA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
const MIC = { kind: "audioinput", deviceId: "fake-builtin", groupId: "g-builtin", label: "MacBook Pro Microphone" };
const git = (...a) => { try { return execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).trim(); } catch { return null; } };
const evidence = {
  version: require(path.join(ROOT, "package.json")).version,
  sha: git("rev-parse", "HEAD"),
  generatedAt: new Date().toISOString(),
  note: "Times are wall-clock ms from launch and include the scripted clicks and the recorded speech (about 10 s of talking).",
  items: {},
};

test.describe.configure({ mode: "serial" });
test.afterAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "evidence-trace.json"), JSON.stringify(evidence, null, 2) + "\n");
});

// getMediaAccessStatus → status; askForMediaAccess switches it to `after`.
const stubMic = (app, status, after = "granted") =>
  app.evaluate(({ systemPreferences }, [s, a]) => {
    globalThis.__mic = { status: s, after: a };
    systemPreferences.getMediaAccessStatus = () => globalThis.__mic.status;
    systemPreferences.askForMediaAccess = async () => {
      globalThis.__mic.status = globalThis.__mic.after;
      return globalThis.__mic.status === "granted";
    };
  }, [status, after]);

// Count every message box main opens (and answer it, so nothing blocks the run).
const countDialogs = (app) =>
  app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    for (const k of ["showMessageBox", "showMessageBoxSync", "showErrorBox"]) {
      dialog[k] = (...args) => {
        const o = args.find((x) => x && typeof x === "object" && !x.webContents) || {};
        globalThis.__dialogs.push(o.message || o.title || k);
        return k === "showMessageBox" ? Promise.resolve({ response: 1 }) : 1;
      };
    }
  });
const dialogs = (app) => app.evaluate(() => globalThis.__dialogs);

// Widget side: how often the in-panel setup opens and every step label it shows.
const watchPanel = (w) =>
  w.evaluate(() => {
    const view = document.getElementById("calibrationView");
    const step = document.getElementById("calStep");
    window.__panel = { activations: view.hidden ? 0 : 1, steps: [] };
    let shown = !view.hidden;
    new MutationObserver(() => {
      if (!view.hidden && !shown) window.__panel.activations++;
      shown = !view.hidden;
      const s = step.hidden ? "" : step.textContent;
      if (s && window.__panel.steps.at(-1) !== s) window.__panel.steps.push(s);
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
const panel = (w) => w.evaluate(() => window.__panel);

async function setupWindow(app) {
  for (let i = 0; i < 50; i++) {
    for (const w of app.windows()) if ((await w.url()).includes("onboarding.html")) return w;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("setup window not found");
}

/** Setup window → Set normal voice → panel setup, measured from launch. */
async function setupRoute(status) {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const { app, userData } = await H.launchApp({ onboarding: true, args: FAKE_MEDIA });
  const marks = {};
  try {
    await stubMic(app, status);
    await countDialogs(app);
    const setupPages = new Set();
    app.on("window", async (p) => { if ((await p.url()).includes("onboarding.html")) setupPages.add(p); });
    const win = await setupWindow(app);
    setupPages.add(win);
    const w = await H.getWidgetWindow(app, 10000);
    await H.installFakeMic(w, { devices: [MIC], wav: H.SPEECH_WAV });
    await watchPanel(w);
    const setupSteps = [];
    const noteStep = async () => {
      const s = await win.locator("#stepCount").textContent();
      if (setupSteps.at(-1) !== s) setupSteps.push(s);
    };
    await win.waitForLoadState("domcontentloaded");
    await noteStep();
    await win.getByRole("button", { name: "Get started" }).click();
    await noteStep();
    if (status !== "granted") {
      await win.getByRole("button", { name: "Continue" }).click();
      await noteStep();
    }
    await expect(win.locator("#hearLabel")).toHaveText("Mic is responding", { timeout: 15000 });
    marks.firstMicInputMs = ms();
    await noteStep();
    await win.locator("#setVoiceBtn").click();
    const start = w.locator("#calPrimaryBtn").filter({ hasText: /^Start$/ });
    if (await start.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) await start.click();
    await expect(w.locator("#calTitle")).toHaveText("Normal voice saved", { timeout: 60000 });
    marks.normalVoiceSavedMs = ms();
    // Louder from now on: the 8 s louder check that follows sees it at once (a slow VM
    // can otherwise let that window pass before the test reacts).
    await w.evaluate(() => window.__fakeMic.setLevelDb(8));
    await expect(w.locator("#calTitle")).toHaveText("That's the cue you'll see on calls", { timeout: 15000 });
    marks.firstRehearsalCueMs = ms();
    const p = await panel(w);
    return {
      ...marks,
      setupWindowOpened: setupPages.size,
      setupWindowSteps: setupSteps,
      panelSetupActivations: p.activations,
      panelStepLabels: p.steps,
      dialogs: await dialogs(app),
    };
  } finally {
    await H.closeApp(app);
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

/** Panel setup on a returning user's mic with no normal voice yet: talk until the louder check. */
async function toLouderCheck() {
  const { app, userData } = await H.launchApp();
  const w = await H.getWidgetWindow(app, 10000);
  await H.installFakeMic(w, { devices: [MIC], wav: H.SPEECH_WAV });
  await countDialogs(app);
  await w.locator("#compactPill").click();
  const start = w.locator("#calPrimaryBtn").filter({ hasText: /^Start$/ });
  await start.click();
  return { app, userData, w };
}

// ---- Capture (beta) with the e2e fakes: no real mic, system audio or whisper ----
const ZOOM = "4242\tus.zoom.xos\n";
const TEAMS = "4343\tcom.microsoft.teams2\n";
function captureLaunch() {
  const folder = fs.mkdtempSync(path.join(require("os").tmpdir(), "quietpls-trace-notes-"));
  execFileSync("git", ["-C", folder, "init", "-q"]);
  return H.launchApp({
    files: { "capture-settings.json": { enabled: true, folder }, "models/ggml-base.en.bin": "fake" },
    env: { QUIETPLS_CAPTURE_FAKES: "1" },
  });
}
const setMicUsers = (app, out) => app.evaluate((_e, o) => { globalThis.__quietplsFakeMicUsers = o; }, out);
const readCaptureSettings = (userData) => JSON.parse(fs.readFileSync(path.join(userData, "capture-settings.json"), "utf8"));
const bannerState = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    const b = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/banner.html"));
    return b ? { visible: b.isVisible() } : { visible: false };
  });
async function bannerText(app) {
  const b = await H.findWindowByUrl(app, "banner.html", 5000);
  return b.evaluate(() => ({
    title: document.getElementById("title").innerText,
    warn: document.getElementById("warn").hidden ? "" : document.getElementById("warn").innerText,
    accept: document.getElementById("accept").innerText,
  }));
}
// The detector polls every 2 s and smooths gaps under 8 s (one call); wait for the banner to settle.
const CALL_END_MS = 12000;
async function settleBanner(app, visible, timeout = 15000) {
  await expect.poll(async () => (await bannerState(app)).visible, { timeout }).toBe(visible);
}
const meeting = (app, detected, apps = ["Zoom"]) =>
  app.evaluate(({ BrowserWindow }, d) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("meeting-detection-changed", d);
  }, { detected, apps: detected ? apps : [] });
const monitoring = (w) => w.locator("#compactPill").evaluate((p) => p.classList.contains("monitoring"));

test.describe("Evidence trace (judge pleasantness items)", () => {
  test("one coherent setup: fresh and pre-granted routes, timings and activations", async () => {
    test.setTimeout(180000);
    for (const [route, status] of [["fresh", "not-determined"], ["preGranted", "granted"]]) {
      const r = await setupRoute(status);
      evidence.items[`setup.${route}`] = r;
      expect(r.setupWindowOpened).toBe(1);
      expect(r.panelSetupActivations).toBe(1);
      // One counted sequence: the setup window's "n of 3"; the panel names its steps.
      expect(r.setupWindowSteps.every((s) => /^\d of 3$/.test(s))).toBe(true);
      expect(r.panelStepLabels.some((s) => /\d+ of \d+/.test(s))).toBe(false);
      expect(r.dialogs).toEqual([]);
    }
  });

  test("calibration progress stays put while nothing is heard (3 s at −80 dB)", async () => {
    test.setTimeout(90000);
    const { app, userData, w } = await toLouderCheck();
    try {
      await expect(w.locator("#calText")).toHaveText(/^[3-6] of 10 seconds heard/, { timeout: 30000 });
      await w.evaluate(() => window.__fakeMic.setLevelDb(-80));
      await w.waitForTimeout(600); // the speech gate's hangover
      const samples = [];
      for (let i = 0; i < 13; i++) {
        samples.push(await w.evaluate(() => ({
          t: Math.round(performance.now()),
          pill: document.getElementById("pillWord").textContent,
          text: document.getElementById("calText").textContent,
          bar: document.getElementById("calProgressFill").style.width,
        })));
        await w.waitForTimeout(250);
      }
      const distinct = new Set(samples.map((s) => `${s.pill}|${s.text}|${s.bar}`));
      evidence.items.silenceProgress = { samples, distinctStates: distinct.size };
      expect(distinct.size).toBe(1);
    } finally {
      await H.closeApp(app);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test("practice outcomes: user Skip and no-cue timeout both say the check was skipped", async () => {
    test.setTimeout(180000);
    const outcome = async (how) => {
      const { app, userData, w } = await toLouderCheck();
      try {
        await expect(w.locator("#calText")).toHaveText("Try a slightly louder voice.", { timeout: 60000 });
        const t = Date.now();
        await w.evaluate(() => window.__fakeMic.setLevelDb(0)); // normal voice, no cue
        if (how === "skip") await w.locator("#calSecondaryBtn").filter({ hasText: "Skip check" }).click();
        await expect(w.locator("#calText")).toHaveText(/Louder check skipped/, { timeout: 15000 });
        return {
          title: await w.locator("#calTitle").textContent(),
          text: await w.locator("#calText").textContent(),
          button: await w.locator("#calSecondaryBtn").textContent(),
          afterMs: Date.now() - t,
        };
      } finally {
        await H.closeApp(app);
        fs.rmSync(userData, { recursive: true, force: true });
      }
    };
    const skip = await outcome("skip");
    const timeout = await outcome("timeout");
    evidence.items.practice = { userSkip: skip, noCueTimeout: timeout };
    for (const r of [skip, timeout]) {
      expect(r.title).toBe("Normal voice saved");
      expect(r.text).toBe("Louder check skipped. Your normal voice is saved.");
      expect(r.button).toBe("Done");
    }
    // timeout.afterMs is recorded, not asserted: it counts from when the test noticed the
    // prompt, not from when the 8 s countdown began. No click was made on that path.
  });

  test("Capture boundary: Never for an app, its reversal in Settings, and a mixed call", async () => {
    test.setTimeout(240000);
    const { app, userData } = await captureLaunch();
    try {
      const r = {};
      await setMicUsers(app, ZOOM);
      await settleBanner(app, true);
      r.asked = await bannerText(app);
      const banner = await H.findWindowByUrl(app, "banner.html", 5000);
      await banner.locator("#never").click();
      await settleBanner(app, false);
      r.neverAppsAfterNever = readCaptureSettings(userData).neverApps;
      await setMicUsers(app, "");
      await new Promise((res) => setTimeout(res, CALL_END_MS)); // that call ended
      await setMicUsers(app, ZOOM); // the next Zoom call
      await new Promise((res) => setTimeout(res, 8000));
      r.zoomCallAfterNever = await bannerState(app);
      await setMicUsers(app, "");
      await new Promise((res) => setTimeout(res, CALL_END_MS));

      // Mixed call: the Never app plus one that may be recorded.
      await setMicUsers(app, ZOOM + TEAMS);
      await settleBanner(app, true);
      r.mixedCall = await bannerText(app);
      await setMicUsers(app, "");
      await settleBanner(app, false, CALL_END_MS + 5000);

      // Reversal: Capture settings → Zoom → Ask.
      await app.evaluate(({ ipcMain }) => ipcMain.emit("open-settings", {}));
      const settings = await H.findWindowByUrl(app, "settings.html", 10000);
      await settings.evaluate(() => window.electronAPI.openTranscripts("settings"));
      const main = await H.findWindowByUrl(app, "main.html", 10000);
      await main.locator('[data-app="Zoom"][data-never="0"]').click();
      await expect.poll(() => readCaptureSettings(userData).neverApps).toEqual([]);
      r.neverAppsAfterReversal = readCaptureSettings(userData).neverApps;
      await setMicUsers(app, ZOOM);
      await settleBanner(app, true);
      r.zoomCallAfterReversal = await bannerText(app);
      evidence.items.captureNever = r;

      expect(r.neverAppsAfterNever).toEqual(["Zoom"]);
      expect(r.zoomCallAfterNever.visible).toBe(false);
      expect(r.mixedCall.accept).toBeTruthy();
      expect(r.zoomCallAfterReversal.title).toBe("Record a call in Zoom?");
    } finally {
      await H.closeApp(app);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test("calls and manual runs: a manual Stop holds for that call; a call ending never stops a manual run", async () => {
    test.setTimeout(120000);
    const { app, userData } = await H.launchApp();
    try {
      const w = await H.getWidgetWindow(app, 10000);
      await H.installFakeMic(w, { devices: [MIC], wav: H.SPEECH_WAV });
      await w.locator("#compactPill").click();
      await H.finishCalibration(w); // a manual run, now monitoring
      const r = { manualRun: {}, autoRun: {} };
      r.manualRun.beforeCall = await monitoring(w);
      await meeting(app, true);
      await w.waitForTimeout(1500);
      await meeting(app, false);
      await w.waitForTimeout(2000);
      r.manualRun.afterCallEnded = await monitoring(w);
      expect(r.manualRun.afterCallEnded).toBe(true);

      await H.stopFromWidget(w);
      await meeting(app, true); // a call starts: monitoring starts by itself
      await expect.poll(() => monitoring(w), { timeout: 10000 }).toBe(true);
      r.autoRun.startedByCall = true;
      await H.stopFromWidget(w); // the user stops it during the call
      await meeting(app, true); // the same call is still detected on the next poll
      await w.waitForTimeout(3000);
      r.autoRun.afterManualStopSameCall = await monitoring(w);
      await meeting(app, false);
      await meeting(app, true); // the next call
      await expect.poll(() => monitoring(w), { timeout: 10000 }).toBe(true);
      r.autoRun.nextCallStarts = true;
      evidence.items.callRuns = r;
      expect(r.manualRun.beforeCall).toBe(true);
      expect(r.autoRun.afterManualStopSameCall).toBe(false);
    } finally {
      await H.closeApp(app);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test("access off during a call: the pending start ends with the call; a grant mid-call resumes that call's run", async () => {
    test.setTimeout(120000);
    const { app, userData } = await H.launchApp();
    try {
      const w = await H.getWidgetWindow(app, 10000);
      await H.installFakeMic(w, { devices: [MIC], wav: H.SPEECH_WAV });
      await w.locator("#compactPill").click();
      await H.finishCalibration(w);
      await H.stopFromWidget(w);
      const access = async (status) => {
        await H.setMicAccess(app, status);
        await w.evaluate((s) => window.__fakeMic.setDenied(s !== "granted"), status);
        await app.evaluate(({ app: a }) => a.emit("browser-window-focus")); // main re-broadcasts access
      };
      const r = {};
      // 1) Denied automatic call; the call ends; access comes back later.
      await access("denied");
      await meeting(app, true);
      await expect(w.locator("#pillWord")).toHaveText("Mic access off", { timeout: 10000 });
      await meeting(app, false);
      await w.waitForTimeout(1000);
      await access("granted");
      await w.waitForTimeout(3000);
      r.grantAfterCallEnded = { monitoring: await monitoring(w) };
      expect(r.grantAfterCallEnded.monitoring).toBe(false);
      // 2) Denied automatic call; access comes back during the call: that call's run resumes and ends with it.
      await access("denied");
      await meeting(app, true);
      await expect(w.locator("#pillWord")).toHaveText("Mic access off", { timeout: 10000 });
      await access("granted");
      await expect.poll(() => monitoring(w), { timeout: 10000 }).toBe(true);
      r.grantDuringCall = { monitoring: true };
      await meeting(app, false);
      await expect.poll(() => monitoring(w), { timeout: 10000 }).toBe(false);
      r.grantDuringCall.stoppedWithCall = true;
      evidence.items.permissionResume = r;
    } finally {
      await H.closeApp(app);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test("a Capture settings change that can't be saved is visible", async () => {
    test.setTimeout(60000);
    const { app, userData } = await captureLaunch();
    const file = path.join(userData, "capture-settings.json");
    try {
      await app.evaluate(({ ipcMain }) => ipcMain.emit("open-settings", {}));
      const settings = await H.findWindowByUrl(app, "settings.html", 10000);
      await settings.evaluate(() => window.electronAPI.openTranscripts("settings"));
      const main = await H.findWindowByUrl(app, "main.html", 10000);
      fs.chmodSync(file, 0o444);
      await main.evaluate(() => window.qpc.setSettings({ keepAudio: true }));
      await expect(main.locator("#alerts")).toContainText("Couldn’t save Capture settings", { timeout: 10000 });
      evidence.items.failedSettingsSave = { alert: await main.locator("#alerts").innerText() };
    } finally {
      fs.chmodSync(file, 0o644);
      await H.closeApp(app);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test("recovery: repeated denial and a repeatedly lost mic stay in one place, no stacked dialogs", async () => {
    test.setTimeout(120000);
    const { app, userData } = await H.launchApp();
    try {
      await countDialogs(app);
      const w = await H.getWidgetWindow(app, 10000);
      await H.setMicAccess(app, "denied");
      await H.installFakeMic(w, { devices: [MIC], deny: true });
      const pill = w.locator("#compactPill");
      for (let i = 0; i < 3; i++) {
        await pill.click();
        await w.waitForTimeout(800);
      }
      const denied = {
        attempts: 3,
        dialogs: await dialogs(app),
        accessOffPanels: await w.locator("#expandedPanel:visible").count(),
        pill: await w.locator("#pillWord").textContent(),
        windows: app.windows().length,
      };

      // Access back on, monitoring on a saved voice, then the mic drops three times.
      await H.setMicAccess(app, "granted");
      await w.reload();
      await w.waitForLoadState("domcontentloaded");
      await H.installFakeMic(w, { devices: [MIC], wav: H.SPEECH_WAV });
      await w.locator("#compactPill").click();
      await H.finishCalibration(w);
      await expect(w.locator("#pillWord")).toHaveText(/Listening|Normal/, { timeout: 15000 });
      for (let i = 0; i < 3; i++) {
        await w.evaluate(() => window.__fakeMic.endCurrentTrack());
        await w.waitForTimeout(1500);
      }
      const lost = {
        drops: 3,
        dialogs: await dialogs(app),
        pill: await w.locator("#pillWord").textContent(),
        windows: app.windows().length,
      };
      evidence.items.recovery = { repeatedDenial: denied, repeatedMicLoss: lost };
      expect(denied.dialogs).toEqual([]);
      expect(denied.accessOffPanels).toBeLessThanOrEqual(1);
      expect(denied.pill).toBe("Mic access off");
      expect(lost.dialogs).toEqual([]);
      expect(lost.windows).toBe(denied.windows);
    } finally {
      await H.closeApp(app);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
