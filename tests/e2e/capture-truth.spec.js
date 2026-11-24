// Capture state truth (judge core item): what Capture says in each state, checked in the
// real windows with the e2e capture fakes. With QP_EVIDENCE_DIR it also saves light + dark
// window shots, full-screen shots (HOLD-<file> markers for the m16 screencapture watcher)
// and capture-truth.json.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { test, expect } = require("@playwright/test");
const H = require("./helpers");

const OUT = process.env.QP_EVIDENCE_DIR;
const HOLD_MS = Number(process.env.QP_SHOTS_HOLD_MS || 3000);
const ZOOM = "4242\tus.zoom.xos\n";
const evidence = { items: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.describe.configure({ mode: "serial" });
test.afterAll(() => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "capture-truth.json"), JSON.stringify(evidence, null, 2) + "\n");
});

function launch({ enabled = true, model = true } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "quietpls-truth-notes-"));
  execFileSync("git", ["-C", folder, "init", "-q"]);
  const files = { "capture-settings.json": { enabled, folder } };
  if (model) files["models/ggml-base.en.bin"] = "fake";
  return H.launchApp({ files, env: { QUIETPLS_CAPTURE_FAKES: "1" } });
}
const inMain = (app, fn, arg) => app.evaluate(fn, arg);
const setMicUsers = (app, out) => inMain(app, (_e, o) => { globalThis.__quietplsFakeMicUsers = o; }, out);
const setFault = (app, f) => inMain(app, (_e, v) => { globalThis.__quietplsFakeCapture = v; }, f);
const visible = (app, page) =>
  inMain(app, ({ BrowserWindow }, p) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().endsWith(p));
    return Boolean(w && w.isVisible());
  }, page);
async function captureWindow(app) {
  await inMain(app, ({ ipcMain }) => ipcMain.emit("open-settings", {}));
  const settings = await H.findWindowByUrl(app, "settings.html", 10000);
  await settings.evaluate(() => window.electronAPI.openTranscripts("settings"));
  return { settings, main: await H.findWindowByUrl(app, "main.html", 10000) };
}
const chip = (main) => main.locator("#status-text").innerText();
const alerts = (main) => main.locator("#alerts").innerText();

/** Window shots and full-screen shots in light and dark (evidence runs only). */
async function shoot(app, name, pages) {
  if (!OUT) return [];
  const files = [];
  for (const theme of ["light", "dark"]) {
    await H.setTheme(app, theme);
    await sleep(600);
    for (const [label, page] of Object.entries(pages)) {
      const file = `${name}~${label}.${theme}.png`;
      await page.screenshot({ path: path.join(OUT, file), omitBackground: true });
      files.push(file);
    }
    const file = `${name}~screen.${theme}.png`;
    const marker = path.join(OUT, `HOLD-${file}`);
    fs.writeFileSync(marker, "");
    await sleep(HOLD_MS);
    fs.rmSync(marker, { force: true });
    if (fs.existsSync(path.join(OUT, file))) files.push(file);
  }
  await H.setTheme(app, "light");
  return files;
}

test.describe("Capture state truth", () => {
  test.beforeAll(() => { if (OUT) fs.mkdirSync(OUT, { recursive: true }); });

  test("(a) always-on recording is shown in the indicator, the Capture window and the menu bar", async () => {
    test.setTimeout(120000);
    const { app, userData } = await launch();
    try {
      const { main } = await captureWindow(app);
      await main.locator("#ambient").click();
      const consent = await H.findWindowByUrl(app, "ambient-consent.html", 10000);
      await consent.locator("#confirmation").fill("ALWAYS ON");
      await consent.locator("#start").click();
      await expect(main.locator("#status-text")).toContainText("ALWAYS ON", { timeout: 15000 });
      const indicator = await H.findWindowByUrl(app, "indicator.html", 10000);
      await sleep(2500); // the timer is running
      const r = {
        captureWindowChip: await chip(main),
        captureWindowAction: await main.locator("#status-action").innerText(),
        indicator: await indicator.locator("body").innerText(),
        indicatorVisible: await visible(app, "/indicator.html"),
      };
      r.files = await shoot(app, "a-always-on", { capture: main, indicator });
      evidence.items.alwaysOn = r;
      expect(r.indicatorVisible).toBe(true);
      expect(r.captureWindowAction).toBe("Stop");
      await main.locator("#status-action").click();
    } finally {
      await H.closeApp(app);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test("(b) with call prompts off, a call raises nothing and Capture and Settings say prompts are off", async () => {
    test.setTimeout(90000);
    const { app, userData } = await launch({ enabled: false });
    try {
      const { settings, main } = await captureWindow(app);
      await setMicUsers(app, ZOOM);
      await sleep(8000); // four detector polls
      const r = {
        bannerVisible: await visible(app, "/banner.html"),
        captureWindowChip: await chip(main),
        settingsCaptureSubtitle: await settings.locator("#captureDescription").innerText(),
      };
      r.files = await shoot(app, "b-prompts-off", { capture: main, settings });
      evidence.items.promptsOff = r;
      expect(r.bannerVisible).toBe(false);
      expect(r.captureWindowChip).toBe("Call prompts off");
      expect(r.settingsCaptureSubtitle).toMatch(/^Call prompts off/);
    } finally {
      await H.closeApp(app);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test("(c) lost call audio records the mic only and says so; capture that can't start says why", async () => {
    test.setTimeout(150000);
    const r = {};
    for (const [key, fault] of [["micOnly", { notice: "mic-only" }], ["cantStart", { error: "system-audio-unavailable" }]]) {
      const { app, userData } = await launch();
      try {
        await setFault(app, fault);
        const { main } = await captureWindow(app);
        await setMicUsers(app, ZOOM);
        const banner = await H.findWindowByUrl(app, "banner.html", 15000);
        await expect.poll(() => visible(app, "/banner.html"), { timeout: 15000 }).toBe(true);
        await banner.locator("#accept").click();
        if (key === "micOnly") {
          await expect(main.locator("#alerts")).toContainText("Only your microphone was recorded", { timeout: 10000 });
          const indicator = await H.findWindowByUrl(app, "indicator.html", 10000);
          r[key] = { duringRecording: { captureWindowChip: await chip(main), captureWindowAlert: await alerts(main), indicator: await indicator.locator("body").innerText() } };
          r[key].files = await shoot(app, "c-mic-only", { capture: main, indicator });
        } else {
          await expect(main.locator("#alerts")).toContainText("System audio is unavailable", { timeout: 10000 });
          // The indicator stays up to show the failure, never a running recording.
          const indicator = await H.findWindowByUrl(app, "indicator.html", 10000);
          r[key] = { captureWindowChip: await chip(main), captureWindowAlert: await alerts(main), indicator: await indicator.locator("body").innerText() };
          r[key].files = await shoot(app, "c-cant-start", { capture: main, indicator });
          expect(r[key].indicator).not.toMatch(/Recording \d/);
          expect(r[key].captureWindowChip).not.toMatch(/^Recording/);
        }
      } finally {
        await H.closeApp(app);
        fs.rmSync(userData, { recursive: true, force: true });
      }
    }
    r.note = "Faults injected through the e2e capture helper fake (__quietplsFakeCapture), which sends the real helper's messages: notice mic-only, error system-audio-unavailable. The VM has no working system-audio tap to revoke.";
    evidence.items.systemAudio = r;
  });

  test("(d) setup incomplete: the status says Set up transcripts, not Waiting for a call", async () => {
    test.setTimeout(60000);
    const { app, userData } = await launch({ model: false });
    try {
      const { main } = await captureWindow(app);
      await expect(main.locator("#status-text")).toHaveText("Set up transcripts", { timeout: 10000 });
      const r = { captureWindowChip: await chip(main) };
      r.files = await shoot(app, "d-setup-incomplete", { capture: main });
      evidence.items.setupIncomplete = r;
    } finally {
      await H.closeApp(app);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
