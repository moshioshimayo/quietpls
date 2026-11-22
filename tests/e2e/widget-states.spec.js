const { test, expect } = require("@playwright/test");
const {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
  installFakeMic,
  finishCalibration,
  widgetBounds,
} = require("./helpers");

/**
 * E2E test: Widget States for the quietpls Electron app (2.4.0).
 *
 *   - compact:         a <button> pill with one status word and mark (188x32)
 *   - expanded:        details or "set your normal voice", fixed 320x240
 *   - sessionComplete: summary shown after Stop (sessions >= 60 s)
 *
 * There is no alert state: "Ease your voice" is the compact pill itself.
 */

let electronApp;
let mainWindow;

test.beforeEach(async () => {
  const { app } = await launchApp();
  electronApp = app;
  await dismissOnboardingIfNeeded(electronApp);
  // The main widget is identified by URL (index.html), not title.
  mainWindow = await getWidgetWindow(electronApp, 10000);
  await mainWindow.waitForLoadState("domcontentloaded");
  // Deterministic synthetic voice instead of whatever the real mic hears
  await installFakeMic(mainWindow);
  await mainWindow.waitForTimeout(500);
});

test.afterEach(async () => {
  if (electronApp) {
    await electronApp.close();
    electronApp = null;
    mainWindow = null;
  }
});

test.describe("Widget State Transitions", () => {
  test("app launches compact: a readable status button, no alert panel", async () => {
    const compactPill = mainWindow.locator("#compactPill");
    await expect(compactPill).toBeVisible();
    expect(await compactPill.evaluate((el) => el.tagName)).toBe("BUTTON");
    await expect(compactPill).toHaveText(/^\s*○\s*Start monitoring\s*$/);
    await expect(compactPill).toHaveAttribute(
      "aria-label",
      "quietpls: Start monitoring. Show details",
    );
    expect(await widgetBounds(electronApp)).toMatchObject({
      width: 188,
      height: 32,
    });
    const box = await compactPill.boundingBox();
    expect(box).toMatchObject({ width: 188, height: 32 });

    await expect(mainWindow.locator("#expandedPanel")).not.toBeVisible();
    await expect(mainWindow.locator("#sessionCompletePanel")).not.toBeVisible();
    // 2.4.0 deletes the alert panel and its Dismiss button.
    await expect(mainWindow.locator("#alertPanel")).toHaveCount(0);
    await expect(mainWindow.locator("#alertDismissBtn")).toHaveCount(0);
  });

  test("compact -> expanded on click opens 'set your normal voice' at 320x240", async () => {
    const compactPill = mainWindow.locator("#compactPill");
    const expandedPanel = mainWindow.locator("#expandedPanel");

    await compactPill.click();
    await expect(expandedPanel).toBeVisible();
    await expect(compactPill).not.toBeVisible();

    // A fresh profile has no normal voice for this mic yet.
    await expect(mainWindow.locator("#calibrationView")).toBeVisible();
    await expect(mainWindow.locator("#calStep")).toHaveText(
      /Step 1 of 2 · Set your normal voice/i,
    );
    await expect(mainWindow.locator("#calText")).toHaveText(
      /of 10 seconds of talking heard · Mic: Fake Built-in Mic/,
    );
    await expect(mainWindow.locator("#calSecondaryBtn")).toHaveText("Stop");
    await expect
      .poll(() => widgetBounds(electronApp))
      .toMatchObject({ width: 320, height: 240 });
    expect(await expandedPanel.boundingBox()).toMatchObject({
      x: 0,
      y: 0,
      width: 320,
      height: 240,
    });
  });

  test("Stop during calibration returns to the idle pill (nothing recorded)", async () => {
    const compactPill = mainWindow.locator("#compactPill");
    await compactPill.click();
    await expect(mainWindow.locator("#calibrationView")).toBeVisible();

    await mainWindow.locator("#calSecondaryBtn").click(); // Stop
    await expect(compactPill).toBeVisible();
    await expect(compactPill).toHaveText(/Start monitoring/);
    await expect(mainWindow.locator("#expandedPanel")).not.toBeVisible();
    await expect(mainWindow.locator("#sessionCompletePanel")).not.toBeVisible();
    await expect
      .poll(() => widgetBounds(electronApp))
      .toMatchObject({ width: 188, height: 32 });
  });

  test("Escape and Hide return to the compact pill without stopping", async () => {
    const compactPill = mainWindow.locator("#compactPill");
    await compactPill.click();
    await expect(mainWindow.locator("#calibrationView")).toBeVisible();

    await mainWindow.keyboard.press("Escape");
    await expect(compactPill).toBeVisible();
    // Still calibrating: the pill shows its progress, monitoring continues.
    await expect(mainWindow.locator("#pillWord")).toHaveText(
      /Set normal voice \d+%/,
    );
    await expect(compactPill).toHaveClass(/monitoring/);

    // Enter on the focused pill opens it again.
    await compactPill.focus();
    await mainWindow.keyboard.press("Enter");
    await expect(mainWindow.locator("#expandedPanel")).toBeVisible();
  });

  test("long session shows sessionComplete summary after stop", async () => {
    test.slow(); // needs a real >=60s monitoring session for the summary
    const compactPill = mainWindow.locator("#compactPill");
    const expandedPanel = mainWindow.locator("#expandedPanel");
    const sessionCompletePanel = mainWindow.locator("#sessionCompletePanel");

    await compactPill.click();
    // Calibration and its rehearsal are not session time.
    await finishCalibration(mainWindow);
    await expect(compactPill).toBeVisible({ timeout: 6000 }); // auto-collapse
    await expect(mainWindow.locator("#pillWord")).toHaveText("Normal", {
      timeout: 10000,
    });
    await mainWindow.waitForTimeout(62_000);

    // Open details (Enter on the pill) and Stop.
    await compactPill.click();
    await expect(expandedPanel).toBeVisible();
    await expect(mainWindow.locator("#detailsView")).toBeVisible();
    await mainWindow.locator("#stopBtn").click();

    await expect(sessionCompletePanel).toBeVisible();
    // Summary speaks in speaking-time terms, never acoustic dB
    await expect(mainWindow.locator("#insightList")).toContainText(
      /ease your voice|speaking time/i,
    );
    await expect(mainWindow.locator("#insightList")).not.toContainText(
      /Too loud|lawn|80 dB/,
    );
    await expect(expandedPanel).not.toBeVisible();
    await expect(compactPill).not.toBeVisible();

    // sessionComplete -> compact (via close)
    await mainWindow.locator("#sessionCloseBtn").click();
    await expect(compactPill).toBeVisible();
    await expect(sessionCompletePanel).not.toBeVisible();
  });

  test("context menu opens on right-click", async () => {
    const compactPill = mainWindow.locator("#compactPill");
    await expect(compactPill).toBeVisible();

    // Listen for the 'show-context-menu' IPC event in the main process.
    // The renderer's contextmenu handler calls window.electronAPI.showContextMenu()
    // which sends this IPC. We cannot intercept electronAPI directly because
    // contextBridge.exposeInMainWorld creates read-only properties.
    // On macOS menu.popup() is modal and blocks the main process until the
    // menu closes, which made this test hang/flake. Record the popup instead.
    await electronApp.evaluate(({ ipcMain, Menu }) => {
      global.__contextMenuReceived = false;
      global.__contextMenuLabels = null;
      ipcMain.on("show-context-menu", () => {
        global.__contextMenuReceived = true;
      });
      Menu.prototype.popup = function () {
        global.__contextMenuLabels = this.items.map((i) => i.label);
      };
    });

    // Perform a native right-click via Playwright
    await compactPill.click({ button: "right" });

    await expect
      .poll(() => electronApp.evaluate(() => global.__contextMenuReceived))
      .toBe(true);
    const labels = await electronApp.evaluate(() => global.__contextMenuLabels);
    expect(labels).toContain("Recalibrate");
  });
});
