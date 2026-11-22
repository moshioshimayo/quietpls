const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { getWidgetWindow } = require("./helpers");

test("current calibration survives repeated launches; legacy calibration is removed", async ({}, testInfo) => {
  const userData = testInfo.outputPath("profile");
  fs.mkdirSync(userData, { recursive: true });
  const current = { version: 3, baselineDb: -30, deviceId: "built-in" };
  fs.writeFileSync(path.join(userData, "quietpls-app-state.json"),
    JSON.stringify({ onboardingComplete: true }));
  fs.writeFileSync(path.join(userData, "quietpls-calibrations.json"),
    JSON.stringify({ calibrations: {
      "built-in": current,
      usb: { version: 2, baselineDb: -25, deviceId: "usb" },
    } }));

  for (let launch = 0; launch < 2; launch++) {
    const app = await electron.launch({
      executablePath: require("electron"),
      args: [path.resolve(__dirname, "../../main.js")],
      env: {
        ...process.env,
        QUIETPLS_E2E_TEST: "1",
        QUIETPLS_USER_DATA: userData,
        NODE_ENV: "test",
      },
    });
    try {
      const page = await getWidgetWindow(app);
      await page.waitForLoadState("domcontentloaded");
      expect(await page.evaluate(() => window.electronAPI.getCalibration("built-in")))
        .toEqual(current);
      expect(await page.evaluate(() => window.electronAPI.getCalibration("usb")))
        .toBeNull();
    } finally {
      await app.close();
    }
  }
});
