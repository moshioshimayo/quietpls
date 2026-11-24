// Setup window (S5, B2–B4): real Electron, first-run profile, Chromium's
// fake capture device. macOS access is stubbed in the main process so every
// access state is reachable without touching the guest's privacy settings.
const path = require("path");
const { test, expect } = require("@playwright/test");
const { launchApp } = require("./helpers");

const FAKE_MEDIA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];

async function setupWindow(app) {
  for (let i = 0; i < 50; i++) {
    for (const w of app.windows()) if ((await w.url()).includes("onboarding.html")) return w;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("setup window not found");
}

// getMediaAccessStatus → status; askForMediaAccess counts and switches to `after`.
function stubMic(app, status, after = "granted") {
  return app.evaluate(({ systemPreferences }, [s, a]) => {
    globalThis.__mic = { status: s, after: a, asks: 0 };
    systemPreferences.getMediaAccessStatus = () => globalThis.__mic.status;
    systemPreferences.askForMediaAccess = async () => {
      globalThis.__mic.asks++;
      globalThis.__mic.status = globalThis.__mic.after;
      return globalThis.__mic.status === "granted";
    };
  }, [status, after]);
}
const asks = (app) => app.evaluate(() => globalThis.__mic.asks);
const setMic = (app, s) => app.evaluate((_e, v) => { globalThis.__mic.status = v; }, s);
const regainFocus = (app) => app.evaluate(({ app: a }) => { a.emit("browser-window-focus"); });

async function start(status, after) {
  const { app } = await launchApp({ onboarding: true, args: FAKE_MEDIA });
  await stubMic(app, status, after);
  const win = await setupWindow(app);
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}

const heading = (win) => win.locator("[data-panel]:not([hidden]) h1");
const step = (win) => win.locator("#stepCount");

test.describe("Setup window (S5)", () => {
  test("first run starts at Welcome; the macOS prompt comes only after Continue", async () => {
    const { app, win } = await start("not-determined", "granted");
    try {
      await expect(heading(win)).toHaveText("Notice when your voice gets louder on calls.");
      await expect(step(win)).toHaveText("1 of 3");
      await expect(step(win)).toHaveAttribute("aria-valuenow", "1");
      const [bounds] = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes("onboarding"))
          .map((w) => ({ width: w.getContentSize()[0], onTop: w.isAlwaysOnTop() })));
      expect(bounds).toEqual({ width: 580, onTop: false });

      await win.getByRole("button", { name: "Get started" }).click();
      await expect(heading(win)).toHaveText("Check your voice level.");
      await expect(step(win)).toHaveText("2 of 3");
      await expect(win.getByText("macOS asks for microphone access next.")).toBeVisible();
      expect(await asks(app)).toBe(0);

      await win.getByRole("button", { name: "Continue" }).click();
      await expect(heading(win)).toHaveText("Say a few words.");
      await expect(step(win)).toHaveText("3 of 3");
      expect(await asks(app)).toBe(1);
      await expect(win.locator("#micName")).not.toBeEmpty();
      await expect(win.locator("#hearLabel")).toHaveText(/Mic is responding|Waiting for input/);

      // Back returns through step 2, which was shown.
      await win.getByRole("button", { name: "Back" }).click();
      await expect(step(win)).toHaveText("2 of 3");
    } finally {
      await app.close();
    }
  });

  test("granted access skips step 2; Back goes to Welcome", async () => {
    const { app, win } = await start("granted");
    try {
      await win.getByRole("button", { name: "Get started" }).click();
      await expect(heading(win)).toHaveText("Say a few words.");
      await expect(step(win)).toHaveText("3 of 3");
      await win.locator("[data-panel=check] [data-back]").click();
      await expect(step(win)).toHaveText("1 of 3");
      expect(await asks(app)).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("a saved normal voice is kept: step 3 offers Start monitoring and starts with it (AC-I7)", async () => {
    const { app, win } = await start("granted");
    try {
      const { CALIBRATION_VERSION } = require("../../calibration-manager");
      // A valid saved normal voice for whichever mic is in use.
      await app.evaluate(({ ipcMain }, version) => {
        globalThis.__recalibrations = 0;
        ipcMain.removeHandler("get-calibration");
        ipcMain.handle("get-calibration", () => ({ version, baselineDb: -30, calibratedAt: Date.now() }));
        ipcMain.on("request-recalibration", () => globalThis.__recalibrations++);
      }, CALIBRATION_VERSION);
      await win.getByRole("button", { name: "Get started" }).click();
      await expect(heading(win)).toHaveText("Say a few words.");
      const action = win.locator("#setVoiceBtn");
      await expect(action).toHaveText("Start monitoring");
      await expect(win.locator("#checkText")).toHaveText("Your normal voice for this mic is saved.");
      await action.click();
      await expect.poll(async () => {
        for (const w of app.windows()) if ((await w.url()).includes("onboarding.html")) return false;
        return true;
      }).toBe(true);
      const widget = app.windows().find((w) => w.url().includes("index.html"));
      await expect(widget.locator("#compactPill")).toHaveClass(/monitoring/, { timeout: 10000 });
      await expect(widget.locator("#calibrationView")).toBeHidden();
      expect(await app.evaluate(() => globalThis.__recalibrations)).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("access off recovers when quietpls regains focus, without a restart", async () => {
    const { app, win } = await start("denied");
    try {
      await win.getByRole("button", { name: "Get started" }).click();
      await expect(heading(win)).toHaveText("Microphone access is off.");
      const panel = win.locator("[data-panel=off]");
      await expect(panel.getByRole("button", { name: "Open System Settings" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Check again" })).toBeVisible();
      await expect(panel).not.toContainText("Restart");
      await expect(win.getByText("Allow Microphone")).toHaveCount(0);

      await regainFocus(app); // still off: stays put
      await expect(heading(win)).toHaveText("Microphone access is off.");
      await setMic(app, "granted");
      await regainFocus(app);
      await expect(heading(win)).toHaveText("Say a few words.");
      expect(await asks(app)).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("Check again also advances once access is on", async () => {
    const { app, win } = await start("denied");
    try {
      await win.getByRole("button", { name: "Get started" }).click();
      await setMic(app, "granted");
      await win.locator("[data-panel=off]").getByRole("button", { name: "Check again" }).click();
      await expect(heading(win)).toHaveText("Say a few words.");
    } finally {
      await app.close();
    }
  });

  test("managed access offers Close only; Escape closes setup", async () => {
    const { app, win } = await start("restricted");
    try {
      await win.getByRole("button", { name: "Get started" }).click();
      await expect(heading(win)).toHaveText("Microphone access is managed by your organization.");
      const panel = win.locator("[data-panel=managed]");
      await expect(panel.getByRole("button")).toHaveText(["Close"]);
      await expect(win.locator("#skipBtn")).toBeHidden();
      // The window closes while the key event is still being delivered.
      await Promise.all([win.waitForEvent("close"), win.keyboard.press("Escape").catch(() => {})]);
    } finally {
      await app.close();
    }
  });

  test("Return activates the primary button", async () => {
    const { app, win } = await start("not-determined", "denied");
    try {
      await expect(step(win)).toHaveText("1 of 3");
      await win.keyboard.press("Enter");
      await expect(step(win)).toHaveText("2 of 3");
      await win.keyboard.press("Enter");
      await expect(heading(win)).toHaveText("Microphone access is off.");
      expect(await asks(app)).toBe(1);
    } finally {
      await app.close();
    }
  });

  // Evidence for the canvas cells P1.S5.* (light + dark). Set QP_SHOTS to a dir.
  test("captures each S5 cell in light and dark", async () => {
    test.skip(!process.env.QP_SHOTS, "set QP_SHOTS to capture");
    const cells = [
      ["default", "granted", []],
      ["first-run", "not-determined", ["Get started"]],
      ["success", "granted", ["Get started"]],
      ["denied", "denied", ["Get started"]],
      ["E-6", "restricted", ["Get started"]],
    ];
    for (const theme of ["light", "dark"]) {
      for (const [cell, status, clicks] of cells) {
        const { app, win } = await start(status);
        try {
          await win.emulateMedia({ colorScheme: null });
          await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
          for (const name of clicks) await win.getByRole("button", { name }).click();
          await win.waitForTimeout(1200);
          await win.screenshot({ path: path.join(process.env.QP_SHOTS, `P1.S5.${cell}.${theme}.png`) });
        } finally {
          await app.close();
        }
      }
    }
  });
});
