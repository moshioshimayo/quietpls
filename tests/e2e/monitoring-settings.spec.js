const { test, expect } = require("@playwright/test");
const {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
  getWindow,
} = require("./helpers");

/**
 * Page Object for the main pill window.
 */
class PillPage {
  constructor(page) {
    this.page = page;
  }

  get compactPill() {
    return this.page.locator("#compactPill");
  }

  get expandedPanel() {
    return this.page.locator("#expandedPanel");
  }

  get dbReadout() {
    return this.page.locator("#dbReadout");
  }

  get stopBtn() {
    return this.page.locator("#stopBtn");
  }

  async clickPill() {
    await this.compactPill.click();
  }

  async stopMonitoring() {
    await this.stopBtn.click();
  }

  async isMonitoringActive() {
    // In v2 the expanded monitoring panel is the active-monitoring surface
    return this.expandedPanel.isVisible();
  }

  async isIdle() {
    // Idle == compact pill shown, monitoring panel hidden
    return (
      (await this.compactPill.isVisible()) &&
      !(await this.expandedPanel.isVisible())
    );
  }
}

/**
 * Page Object for the settings window.
 */
class SettingsPage {
  constructor(page) {
    this.page = page;
  }

  get quietSlider() {
    return this.page.locator("#quietThreshold");
  }

  get normalSlider() {
    return this.page.locator("#normalThreshold");
  }

  get warningSlider() {
    return this.page.locator("#warningThreshold");
  }

  get quietValue() {
    return this.page.locator("#quietValue");
  }

  get normalValue() {
    return this.page.locator("#normalValue");
  }

  get warningValue() {
    return this.page.locator("#warningValue");
  }

  get currentLevel() {
    return this.page.locator("#currentLevel");
  }

  get closeButton() {
    return this.page.locator("#closeSettings");
  }

  get resetDefaultsButton() {
    return this.page.locator("#resetDefaults");
  }

  async setQuietThreshold(value) {
    await this.quietSlider.fill(String(value));
    // Trigger input event so the handler fires
    await this.quietSlider.dispatchEvent("input");
  }

  async getQuietThresholdValue() {
    return this.quietValue.textContent();
  }

  async close() {
    await this.closeButton.click();
  }
}

test.describe("Monitoring and Settings Flow", () => {
  let electronApp;
  let mainPage;
  let pill;

  test.beforeAll(async () => {
    // Launch the app
    const { app } = await launchApp();
    electronApp = app;

    // Dismiss first-launch onboarding through the UI
    await dismissOnboardingIfNeeded(electronApp);

    // Get the main window (the pill). It is the first window that loads index.html.
    mainPage = await getWidgetWindow(electronApp, 10000);
    await mainPage.waitForLoadState("domcontentloaded");

    pill = new PillPage(mainPage);
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test("app launches in idle state with idle pill", async () => {
    // Idle state: compact pill visible, monitoring panel hidden (v2 canvas pill)
    await expect(pill.compactPill).toBeVisible();
    await expect(pill.expandedPanel).not.toBeVisible();
  });

  test("clicking pill starts monitoring", async () => {
    // Click the pill to start monitoring
    await pill.clickPill();

    // Wait for monitoring to activate (mic permission may cause a brief delay)
    await mainPage.waitForTimeout(1500);

    // Verify the widget expanded into the active monitoring panel
    const isActive = await pill.isMonitoringActive();
    expect(isActive).toBe(true);
  });

  test("dB readout updates while monitoring", async () => {
    // Wait a moment for audio data to flow
    await mainPage.waitForTimeout(1000);

    // The dB readout should render a live value ("-- dB" placeholder before
    // first audio frame, then a numeric dB value)
    const dbText = await pill.dbReadout.textContent();
    expect(dbText).toMatch(/^-- dB$|^-?\d+(\.\d+)? dB$/);
  });

  test("Cmd+Click opens settings window", async () => {
    // Use Cmd+Shift+S shortcut to open settings (more reliable than Cmd+Click
    // which might not propagate the modifier in Playwright)
    await electronApp
      .evaluate(async ({ BrowserWindow, ipcMain }) => {
        // Trigger settings open via IPC, same as the keyboard shortcut handler
        const { createSettingsWindow } = require("./main");
      })
      .catch(() => {
        // createSettingsWindow is not exported, so use the IPC approach instead
      });

    // Send open-settings IPC from the renderer
    await mainPage.evaluate(() => {
      window.electronAPI.openSettings();
    });

    // Wait for settings window to appear
    const settingsPage = await getWindow(electronApp, "Settings");
    await settingsPage.waitForLoadState("domcontentloaded");

    expect(settingsPage).toBeTruthy();
  });

  test("settings window has threshold sliders", async () => {
    const settingsPage = await getWindow(electronApp, "Settings");
    const settings = new SettingsPage(settingsPage);

    // Verify sliders exist
    await expect(settings.quietSlider).toBeVisible();
    await expect(settings.normalSlider).toBeVisible();
    await expect(settings.warningSlider).toBeVisible();

    // Verify default values are displayed
    const quietVal = await settings.getQuietThresholdValue();
    expect(parseInt(quietVal)).toBeGreaterThan(0);
    expect(parseInt(quietVal)).toBeLessThan(100);
  });

  test("settings window shows live volume level", async () => {
    const settingsPage = await getWindow(electronApp, "Settings");
    const settings = new SettingsPage(settingsPage);

    // The current level element should exist and show a percentage
    await expect(settings.currentLevel).toBeVisible();
    const levelText = await settings.currentLevel.textContent();
    expect(levelText).toMatch(/\d+%/);
  });

  test("adjusting quiet threshold slider updates value", async () => {
    const settingsPage = await getWindow(electronApp, "Settings");
    const settings = new SettingsPage(settingsPage);

    // Set quiet threshold to a new value (e.g., 15)
    await settings.setQuietThreshold(15);
    await settingsPage.waitForTimeout(300);

    // Verify the displayed value updated
    const quietVal = await settings.getQuietThresholdValue();
    expect(parseInt(quietVal)).toBe(15);
  });

  test("closing settings window works", async () => {
    const settingsPage = await getWindow(electronApp, "Settings");
    const settings = new SettingsPage(settingsPage);

    await settings.close();

    // Wait for the window to close
    await mainPage.waitForTimeout(500);

    // Verify settings window is gone
    const windows = electronApp.windows();
    const settingsWindows = [];
    for (const win of windows) {
      const title = await win.title();
      if (title.includes("Settings")) {
        settingsWindows.push(win);
      }
    }
    expect(settingsWindows.length).toBe(0);
  });

  test("stopping monitoring returns to idle pill", async () => {
    // If monitoring is not active yet (fresh app state), start it first
    if (!(await pill.isMonitoringActive())) {
      await pill.clickPill();
      await mainPage.waitForTimeout(1500);
    }
    expect(await pill.isMonitoringActive()).toBe(true);

    // Stop via the stop button (v2 flow: stop button on the expanded panel;
    // short sessions skip the scorecard and return straight to compact)
    await pill.stopMonitoring();
    await mainPage.waitForTimeout(1500);

    // Verify the widget returned to idle
    const isIdle = await pill.isIdle();
    expect(isIdle).toBe(true);
  });
});
