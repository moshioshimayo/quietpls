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

/** What main sends the widget for tray/shortcut/menu/meeting events. */
const sendToWidget = (message, arg) =>
  electronApp.evaluate(
    ({ BrowserWindow }, [message, arg]) =>
      BrowserWindow.getAllWindows()
        .find((b) => b.webContents.getURL().includes("index.html"))
        .webContents.send(message, arg),
    [message, arg],
  );

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

  test("a quick click never leaves the window following the mouse", async () => {
    const before = await widgetBounds(electronApp);
    // A press and release faster than the window-position lookup.
    await mainWindow.evaluate(() => {
      const pill = document.getElementById("compactPill");
      const at = { bubbles: true, button: 0, screenX: 0, screenY: 0 };
      pill.dispatchEvent(new MouseEvent("mousedown", at));
      pill.dispatchEvent(new MouseEvent("mouseup", at));
    });
    await mainWindow.waitForTimeout(300);
    // Moving with no button held must not drag the window.
    await mainWindow.mouse.move(150, 20, { steps: 5 });
    await mainWindow.mouse.move(20, 10, { steps: 5 });
    await mainWindow.waitForTimeout(300);
    expect(await widgetBounds(electronApp)).toEqual(before);
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

  // An undismissed summary, then Recalibrate (Settings/context menu) or a
  // tray/Cmd+Shift+M/next-call start on a mic with no normal voice yet: the
  // summary gives way to the calibration panel at 320x240.
  for (const [how, message, arg] of [
    ["Recalibrate", "trigger-recalibration"],
    ["tray Start", "toggle-monitoring", true],
    ["a call starting", "meeting-detection-changed", { detected: true }],
  ]) {
    test(`${how} with the session summary open shows calibration`, async () => {
      const summary = mainWindow.locator("#sessionCompletePanel");
      // The summary state itself (a real one needs a >=60 s session).
      await mainWindow.evaluate(() =>
        window.electronAPI.widgetTransition("sessionComplete"),
      );
      await expect(summary).toBeVisible();

      await sendToWidget(message, arg);

      await expect(mainWindow.locator("#calibrationView")).toBeVisible();
      await expect(mainWindow.locator("#expandedPanel")).toBeVisible();
      await expect(summary).not.toBeVisible();
      await expect
        .poll(() => widgetBounds(electronApp))
        .toMatchObject({ width: 320, height: 240 });
      expect(
        await mainWindow.evaluate(() => [innerWidth, innerHeight]),
      ).toEqual([320, 240]);
      expect(
        await mainWindow.evaluate(() => window.electronAPI.widgetGetState()),
      ).toBe("expanded");
    });
  }

  // If the panel can't be shown, nothing starts and no normal voice is
  // taken from audio the user was never prompted for.
  const savedNormal = () =>
    mainWindow.evaluate(() => window.electronAPI.getCalibration("fake-builtin"));
  const failTransitions = () =>
    electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("widget-transition");
      ipcMain.handle("widget-transition", () => ({
        success: false,
        error: "test: refused",
      }));
    });

  test("a start the widget can't show starts nothing and saves no normal", async () => {
    test.setTimeout(60000);
    await mainWindow.evaluate(() =>
      window.electronAPI.widgetTransition("sessionComplete"),
    );
    await failTransitions();
    await sendToWidget("toggle-monitoring", true);
    await mainWindow.waitForTimeout(20000); // longer than a calibration
    expect(await savedNormal()).toBeFalsy();
    await expect(mainWindow.locator("#sessionCompletePanel")).toBeVisible();
    await expect(mainWindow.locator("#compactPill")).not.toHaveClass(
      /\bmonitoring\b/,
    );
  });

  test("a recalibration the widget can't show stops and keeps the old normal", async () => {
    test.setTimeout(120000);
    const pill = mainWindow.locator("#compactPill");
    await pill.click();
    await finishCalibration(mainWindow);
    const before = await savedNormal();
    expect(before).toBeTruthy();
    await expect(pill).toHaveClass(/\bmonitoring\b/);

    await failTransitions();
    await sendToWidget("trigger-recalibration");
    await mainWindow.waitForTimeout(20000); // longer than a calibration
    expect(await savedNormal()).toEqual(before);
    await expect(pill).not.toHaveClass(/\bmonitoring\b/);
    await expect(pill).toBeVisible();
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
