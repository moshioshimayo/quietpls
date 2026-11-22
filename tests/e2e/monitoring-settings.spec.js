const { test, expect } = require("@playwright/test");
const {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
  getWindow,
  getSettingsStore,
  installFakeMic,
  finishCalibration,
  stopFromWidget,
  widgetBounds,
} = require("./helpers");

// Real Electron app, throwaway profile, synthetic voice in place of the mic.
// The flow runs in order: calibrate → louder → silence → Settings → switch
// mic → lose the mic → recover → stop.

test.describe.configure({ mode: "serial" });

test.describe("Trustworthy loudness flow (2.4)", () => {
  let electronApp;
  let page;
  let settingsPage;

  // The pill's word is always the current state, even while details are open.
  const word = () => page.locator("#pillWord");
  const pill = () => page.locator("#compactPill");
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
    await expect(pill()).toBeVisible();
    await expect(word()).toHaveText("Start monitoring");
    await expect(panel()).not.toBeVisible();
    await expect(readout()).not.toHaveText(/\d+\s*dB/);
  });

  test("first start on an uncalibrated mic runs guided calibration", async () => {
    test.setTimeout(90000);
    await pill().click();
    await expect(panel()).toBeVisible();
    await expect(page.locator("#calTitle")).toHaveText(
      "Talk the way you usually do on a call",
    );
    await expect(word()).toHaveText(/^Set normal voice \d+%$/, {
      timeout: 5000,
    });
    // About 10 s of talking completes it; the panel stays open meanwhile.
    await finishCalibration(page);
    // Success collapses on its own after about 3 s.
    await expect(pill()).toBeVisible({ timeout: 6000 });
    await expect(word()).toHaveText("Normal", { timeout: 10000 });
    await expect(pill()).toHaveClass(/zone-normal/);
  });

  test("+11 dB above normal turns the compact pill to Ease your voice", async () => {
    await setLevel(-19);
    await expect(word()).toHaveText("Getting loud", { timeout: 8000 });
    await expect(word()).toHaveText("Ease your voice", { timeout: 10000 });
    await expect(pill()).toHaveClass(/zone-danger/);
    // No alert panel, no resize: the cue is the pill itself.
    await expect(pill()).toBeVisible();
    expect(await widgetBounds(electronApp)).toMatchObject({
      width: 188,
      height: 32,
    });
  });

  test("details show how far above normal, with the bar on the relative scale", async () => {
    await pill().click();
    await expect(panel()).toBeVisible();
    await expect(page.locator("#zoneLabel")).toHaveText("Ease your voice");
    await expect(readout()).toHaveText(/^\+1[012] dB above your normal$/);
    const fill = await page
      .locator("#relFill")
      .evaluate((el) => parseFloat(el.style.width));
    // relativeLevel(+11) = (11 + 10) / 25 * 100 = 84
    expect(fill).toBeGreaterThan(75);
    expect(fill).toBeLessThan(92);
    await expect(page.locator("#micLabel")).toHaveText("Fake Built-in Mic");
    await page.locator("#hideBtn").click();
    await expect(pill()).toBeVisible();
    await expect(word()).toHaveText("Ease your voice");
  });

  test("+7 dB above normal clears to Getting loud (yellow)", async () => {
    await setLevel(-23);
    await expect(word()).toHaveText("Getting loud", { timeout: 12000 });
    await expect(pill()).toHaveClass(/zone-loud/);
  });

  test("silence is Listening, never Speak up", async () => {
    await setLevel(null);
    await expect(word()).toHaveText("Listening", { timeout: 5000 });
    await expect(pill()).toHaveClass(/zone-quiet/);
    await expect(readout()).toHaveText("Listening — say something");
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
      /dB above your normal · (Getting loud|Ease your voice)/,
      { timeout: 12000 },
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
    test.setTimeout(90000);
    await setLevel(-30);
    await settingsPage.locator("#recalibrateBtn").click();
    await expect(word()).toHaveText(/Set normal voice/, { timeout: 5000 });
    await finishCalibration(page);
    await expect(word()).toHaveText("Normal", { timeout: 10000 });
    await expect(settingsPage.locator("#calibrationStatus")).toHaveText(
      /Calibrated/,
    );
  });

  test("choosing another mic in Settings reacquires it (and calibrates it)", async () => {
    test.setTimeout(90000);
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
    await expect(word()).toHaveText(/Set normal voice/, { timeout: 5000 });
    await finishCalibration(page);
    await expect(word()).toHaveText("Normal", { timeout: 10000 });
  });

  test("a lost mic shows Reconnecting, then recovers", async () => {
    await settingsPage.close();
    await page.evaluate(() => window.__fakeMic.endCurrentTrack());
    await expect(word()).toHaveText(/Reconnecting mic/, { timeout: 3000 });
    // No verdict while the mic is gone: dashed, grey, no window resize.
    await expect(pill()).toHaveClass(/is-uncertain/);
    await expect(pill()).not.toHaveClass(/zone-(normal|loud|danger)/);
    await expect(word()).toHaveText(/Normal|Listening/, { timeout: 8000 });
    await expect(pill()).not.toHaveClass(/is-uncertain/);
  });

  test("stopping returns to the idle pill", async () => {
    await stopFromWidget(page);
    await expect(pill()).toBeVisible();
    await expect(word()).toHaveText("Start monitoring");
  });
});
