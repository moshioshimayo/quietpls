const { test, expect } = require("@playwright/test");
const path = require("path");
const {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
  installFakeMic,
} = require("./helpers");

/**
 * 2.4.1 bug: "Set your normal voice" failed for a person talking nonstop.
 * Real human speech (tests/fixtures/speech-human.wav, LibriVox) loops through
 * the fake mic into the app's real capture, worklet, calibration and UI.
 * 15 dB below the recording's level (a far built-in mic) and at its level,
 * calibration finishes in ~10-15 s of talking.
 */
const HUMAN_WAV = path.join(__dirname, "..", "fixtures", "speech-human.wav");

test.describe("Set your normal voice with real nonstop speech", () => {
  test.describe.configure({ mode: "serial" });
  let app;
  let page;

  test.beforeAll(async () => {
    ({ app } = await launchApp());
    await dismissOnboardingIfNeeded(app);
    page = await getWidgetWindow(app, 10000);
    await page.waitForLoadState("domcontentloaded");
    await installFakeMic(page, { wav: HUMAN_WAV });
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  for (const [i, [levelDb, boundMs]] of [[-15, 17000], [0, 17000]].entries()) {
    test(`talking at ${levelDb} dB finishes calibration within ${boundMs / 1000} s`, async () => {
      test.setTimeout(90000);
      await page.evaluate((d) => window.__fakeMic.setLevelDb(d), levelDb);
      await page.locator("#compactPill").click();
      if (i > 0) await page.locator("#recalibrateBtn").click();
      await expect(page.locator("#calibrationView")).toBeVisible();
      await page.locator("#calPrimaryBtn").click();
      const started = Date.now();
      await expect(page.locator("#calTitle")).toHaveText("Normal voice saved", { timeout: 40000 });
      const elapsedMs = Date.now() - started;
      console.log("E2E REAL SPEECH", JSON.stringify({ levelDb, elapsedMs }));
      expect(elapsedMs).toBeLessThanOrEqual(boundMs);
      if (i === 0) {
        await expect(page.locator("#calText")).toHaveText("Try a slightly louder voice.");
        await page.locator("#calSecondaryBtn").click();
        await expect(page.locator("#calText")).toContainText("Louder check skipped");
      }
      await page.locator("#calSecondaryBtn").click(); // Done
      await expect(page.locator("#compactPill")).toBeVisible();
    });
  }
});
