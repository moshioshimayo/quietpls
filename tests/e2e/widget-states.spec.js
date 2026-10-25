const { test, expect } = require("@playwright/test");
const {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
} = require("./helpers");

/**
 * E2E test: Widget State Transitions (US-026) for the quietpls Electron app.
 *
 * Tests the widget state machine transitions between:
 *   compact -> expanded -> sessionComplete -> compact
 *
 * The floating widget has four visual states governed by widget-state-machine.js:
 *   - compact:         glassmorphic pill showing "quietpls" label
 *   - expanded:        monitoring panel with FFT canvas, dB readout, stop button
 *   - alert:           danger panel (triggered by volume threshold, not user-clickable)
 *   - sessionComplete: grade summary panel (shown after stopping a session)
 *
 * Note: Widget state transitions are auth-independent. The compact pill click
 * handler calls widgetTransition('expanded') via IPC without checking auth.
 */

let electronApp;
let mainWindow;

test.beforeEach(async () => {
  const { app } = await launchApp();
  electronApp = app;

  // Dismiss first-launch onboarding through the UI so the widget is testable
  await dismissOnboardingIfNeeded(electronApp);

  // The first window may be either the onboarding screen ("Welcome to quietpls")
  // or the main widget ("quietpls"). Both titles contain "quietpls", so we
  // identify the main widget window by its URL (index.html) instead.
  mainWindow = await getWidgetWindow(electronApp, 10000);
  await mainWindow.waitForLoadState("domcontentloaded");

  // Wait for initial widget state sync to complete
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
  test("app launches in compact state with canvas pill", async () => {
    const compactPill = mainWindow.locator("#compactPill");
    await expect(compactPill).toBeVisible();

    // v2: the pill label is drawn on the waveform canvas (no DOM label element)
    const waveformCanvas = mainWindow.locator("#pillWaveformCanvas");
    await expect(waveformCanvas).toBeAttached();

    // Verify compact pill dimensions (v2 window is 72px wide; CSS 100% of it)
    const box = await compactPill.boundingBox();
    expect(box).toBeTruthy();
    expect(box.width).toBeGreaterThanOrEqual(60);
    expect(box.width).toBeLessThanOrEqual(100);
    expect(box.height).toBeGreaterThanOrEqual(28);
    expect(box.height).toBeLessThanOrEqual(50);

    // Expanded panel should be hidden
    const expandedPanel = mainWindow.locator("#expandedPanel");
    await expect(expandedPanel).not.toBeVisible();

    // Alert and session complete panels should also be hidden
    const alertPanel = mainWindow.locator("#alertPanel");
    await expect(alertPanel).not.toBeVisible();
    const sessionCompletePanel = mainWindow.locator("#sessionCompletePanel");
    await expect(sessionCompletePanel).not.toBeVisible();
  });

  test("compact -> expanded on click", async () => {
    const compactPill = mainWindow.locator("#compactPill");
    const expandedPanel = mainWindow.locator("#expandedPanel");

    // Start in compact state
    await expect(compactPill).toBeVisible();
    await expect(expandedPanel).not.toBeVisible();

    // Click the compact pill to transition to expanded (starts monitoring)
    await compactPill.click();

    // Wait for state transition animation (250-500ms) + monitoring init
    await mainWindow.waitForTimeout(1500);

    // Verify expanded panel is now visible
    await expect(expandedPanel).toBeVisible();

    // Verify compact pill is hidden
    await expect(compactPill).not.toBeVisible();

    // Verify FFT canvas element exists in expanded panel
    const fftCanvas = mainWindow.locator("#fftCanvas");
    await expect(fftCanvas).toBeAttached();

    // Verify dB readout element exists
    const dbReadout = mainWindow.locator("#dbReadout");
    await expect(dbReadout).toBeAttached();

    // Verify stop button is visible
    const stopBtn = mainWindow.locator("#stopBtn");
    await expect(stopBtn).toBeVisible();
  });

  test("expanded -> compact on stop for short sessions", async () => {
    const compactPill = mainWindow.locator("#compactPill");
    const expandedPanel = mainWindow.locator("#expandedPanel");
    const sessionCompletePanel = mainWindow.locator("#sessionCompletePanel");

    // Transition to expanded by clicking compact pill
    await compactPill.click();
    await mainWindow.waitForTimeout(1500);
    await expect(expandedPanel).toBeVisible();

    // Click stop button — v2: short sessions (<60s) skip the scorecard
    // and return straight to compact (commit aa6a393 gates scorecard at 60s)
    const stopBtn = mainWindow.locator("#stopBtn");
    await stopBtn.click();
    await mainWindow.waitForTimeout(1500);

    // Back to compact directly, scorecard never shown for a short session
    await expect(compactPill).toBeVisible();
    await expect(expandedPanel).not.toBeVisible();
    await expect(sessionCompletePanel).not.toBeVisible();
  });

  test("widget state persistence across interaction cycle", async () => {
    const compactPill = mainWindow.locator("#compactPill");
    const expandedPanel = mainWindow.locator("#expandedPanel");
    const sessionCompletePanel = mainWindow.locator("#sessionCompletePanel");

    // --- Cycle 1: compact -> expanded -> sessionComplete -> compact ---

    // Verify initial compact state
    await expect(compactPill).toBeVisible();
    await expect(expandedPanel).not.toBeVisible();

    // compact -> expanded
    await compactPill.click();
    await mainWindow.waitForTimeout(1500);
    await expect(expandedPanel).toBeVisible();
    await expect(compactPill).not.toBeVisible();

    // expanded -> compact (via stop; short session skips scorecard)
    await mainWindow.locator("#stopBtn").click();
    await mainWindow.waitForTimeout(1500);
    await expect(compactPill).toBeVisible();

    // --- Cycle 2: compact -> expanded again to verify clean re-entry ---

    await compactPill.click();
    await mainWindow.waitForTimeout(1500);
    await expect(expandedPanel).toBeVisible();
    await expect(compactPill).not.toBeVisible();

    // Verify monitoring elements render correctly on second cycle
    const dbReadout = mainWindow.locator("#dbReadout");
    await expect(dbReadout).toBeAttached();

    const stopBtn = mainWindow.locator("#stopBtn");
    await expect(stopBtn).toBeVisible();
  });

  test("long session shows sessionComplete scorecard after stop", async () => {
    test.slow(); // needs a real >=60s monitoring session for the scorecard
    const compactPill = mainWindow.locator("#compactPill");
    const expandedPanel = mainWindow.locator("#expandedPanel");
    const sessionCompletePanel = mainWindow.locator("#sessionCompletePanel");

    await compactPill.click();
    await mainWindow.waitForTimeout(1500);
    await expect(expandedPanel).toBeVisible();

    // Monitor for 65s so the session crosses the 60s scorecard gate.
    // The widget auto-collapses while monitoring (v2), so re-expand via pill
    // click before stopping.
    await mainWindow.waitForTimeout(65_000);
    await expect(compactPill).toBeVisible();
    await compactPill.click();
    await mainWindow.waitForTimeout(1000);
    await expect(expandedPanel).toBeVisible();

    await mainWindow.locator("#stopBtn").click();
    await mainWindow.waitForTimeout(1500);

    await expect(sessionCompletePanel).toBeVisible();
    await expect(expandedPanel).not.toBeVisible();
    await expect(compactPill).not.toBeVisible();

    // sessionComplete -> compact (via close)
    await mainWindow.locator("#sessionCloseBtn").click();
    await mainWindow.waitForTimeout(500);
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
    await electronApp.evaluate(({ ipcMain }) => {
      global.__contextMenuReceived = false;
      ipcMain.on("show-context-menu", () => {
        global.__contextMenuReceived = true;
      });
    });

    // Perform a native right-click via Playwright
    await compactPill.click({ button: "right" });

    // Wait for the IPC round-trip
    await mainWindow.waitForTimeout(500);

    // Verify the IPC was received in the main process
    const contextMenuReceived = await electronApp.evaluate(() => {
      return global.__contextMenuReceived;
    });

    expect(contextMenuReceived).toBe(true);
  });
});
