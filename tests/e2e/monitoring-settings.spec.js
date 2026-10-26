const { test, expect } = require("@playwright/test");
const {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
  getWindow,
  getSettingsStore,
  installFakeMic,
} = require("./helpers");

// Real Electron app, throwaway profile, synthetic voice in place of the mic.
// The flow runs in order: calibrate → louder → silence → Settings → switch
// mic → lose the mic → recover → stop.

test.describe.configure({ mode: "serial" });

test.describe("Trustworthy loudness flow (2.1)", () => {
  let electronApp;
  let page;
  let settingsPage;

  const label = () => page.locator("#zoneLabel");
  const readout = () => page.locator("#dbReadout");
  const panel = () => page.locator("#expandedPanel");
  const setLevel = (db) =>
    page.evaluate((d) => window.__fakeMic.setLevelDb(d), db);

  test.beforeAll(async () => {
    const { app } = await launchApp();
    electronApp = app;
    await dismissOnboardingIfNeeded(electronApp);
    page = await getWidgetWindow(electronApp, 10000);
    await page.waitForLoadState("domcontentloaded");
    await installFakeMic(page);
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  test("starts idle with no fake dB readout", async () => {
    await expect(page.locator("#compactPill")).toBeVisible();
    await expect(panel()).not.toBeVisible();
    await expect(readout()).not.toHaveText(/\d+\s*dB/);
  });

  test("first start on an uncalibrated mic runs guided calibration", async () => {
    await page.locator("#compactPill").click();
    await expect(panel()).toBeVisible();
    await expect(label()).toHaveText(/Calibrating/, { timeout: 5000 });
    await expect(readout()).toHaveText("Talk normally");
    // ~3 s of detected speech completes it; the panel stays open meanwhile.
    await expect(label()).toHaveText(/Normal/, { timeout: 12000 });
    await expect(panel()).toHaveClass(/zone-normal/);
  });

  test("+11 dB above normal shows Too loud (red)", async () => {
    await setLevel(-19);
    await expect(label()).toHaveText(/Too loud/, { timeout: 5000 });
    await expect(readout()).toHaveText(/^\+1[01] dB$/);
    await expect(panel()).toHaveClass(/zone-danger/);
  });

  test("+7 dB above normal shows Getting loud (yellow)", async () => {
    await setLevel(-23);
    await expect(label()).toHaveText(/Getting loud/, { timeout: 5000 });
    await expect(panel()).toHaveClass(/zone-loud/);
  });

  test("silence is Not speaking, never Speak up", async () => {
    await setLevel(null);
    await expect(label()).toHaveText(/Not speaking/, { timeout: 5000 });
    await expect(readout()).toHaveText("—");
    await expect(page.locator("body")).not.toContainText("Speak up");
  });

  test("Settings shows the actual mic, its calibration and the live decision", async () => {
    await setLevel(-19);
    await page.evaluate(() => window.electronAPI.openSettings());
    settingsPage = await getWindow(electronApp, "Settings");
    await settingsPage.waitForLoadState("domcontentloaded");
    await expect(settingsPage.locator("#calibrationDevice")).toHaveText(
      "Fake Built-in Mic",
    );
    await expect(settingsPage.locator("#calibrationStatus")).toHaveText(
      /Calibrated .*dBFS/,
    );
    await expect(settingsPage.locator("#liveLevelText")).toHaveText(
      /dB above your normal · Too loud/,
      { timeout: 5000 },
    );
    // No score sliders any more
    await expect(settingsPage.locator("#quietThreshold")).toHaveCount(0);
  });

  test("sensitivity slider shifts both margins and is saved", async () => {
    const slider = settingsPage.locator("#sensitivity");
    await slider.fill("2");
    await slider.dispatchEvent("input");
    await expect(settingsPage.locator("#marginsDescription")).toHaveText(
      "Yellow at +4 dB and red at +8 dB above your normal voice",
    );
    await expect
      .poll(async () => (await getSettingsStore(electronApp)).sensitivity)
      .toBe(2);
    await slider.fill("0");
    await slider.dispatchEvent("input");
  });

  test("Settings Recalibrate runs calibration live", async () => {
    await setLevel(-30);
    await settingsPage.locator("#recalibrateBtn").click();
    await expect(label()).toHaveText(/Calibrating/, { timeout: 5000 });
    await expect(label()).toHaveText(/Normal/, { timeout: 12000 });
    await expect(settingsPage.locator("#calibrationStatus")).toHaveText(
      /Calibrated/,
    );
  });

  test("choosing another mic in Settings reacquires it (and calibrates it)", async () => {
    const before = await page.evaluate(
      () => window.__fakeMic.gumCalls().length,
    );
    await settingsPage.evaluate(() =>
      window.electronAPI.updateSettings({
        sensitivity: 0,
        audioDeviceId: "fake-headset",
      }),
    );
    await expect
      .poll(() => page.evaluate(() => window.__fakeMic.gumCalls().length))
      .toBeGreaterThan(before);
    const last = await page.evaluate(
      () => window.__fakeMic.gumCalls().slice(-1)[0],
    );
    expect(last.audio.deviceId).toEqual({ exact: "fake-headset" });
    await expect(settingsPage.locator("#calibrationDevice")).toHaveText(
      "Fake Headset",
    );
    // New mic has no calibration yet → guided calibration, then Normal.
    await expect(label()).toHaveText(/Calibrating|Normal/, { timeout: 5000 });
    await expect(label()).toHaveText(/Normal/, { timeout: 12000 });
  });

  test("a lost mic shows Reconnecting, then recovers", async () => {
    await settingsPage.close();
    await page.evaluate(() => window.__fakeMic.endCurrentTrack());
    await expect(label()).toHaveText(/Reconnecting/, { timeout: 3000 });
    await expect(panel()).toHaveClass(/capture-lost/);
    await expect(label()).toHaveText(/Normal|Not speaking/, { timeout: 5000 });
    await expect(panel()).not.toHaveClass(/capture-lost/);
  });

  test("stopping returns to the idle pill", async () => {
    await page.locator("#stopBtn").click();
    await expect(panel()).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator("#compactPill")).toBeVisible();
  });
});
