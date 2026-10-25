const { _electron: electron } = require("@playwright/test");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..", "..");

// Resolve the electron binary from the project's node_modules
const electronPath = require("electron");

/**
 * Launch the Electron app.
 */
async function launchApp() {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(APP_ROOT, "main.js")],
    env: {
      ...process.env,
      QUIETPLS_E2E_TEST: "1",
      NODE_ENV: "test",
    },
  });

  // Wait for the first window (main pill window)
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  return { app, window };
}

/**
 * Get the main widget window (index.html) by URL, since the title "quietpls"
 * also appears in the onboarding window title "Welcome to quietpls".
 */
async function getWidgetWindow(electronApp, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const windows = electronApp.windows();
    for (const win of windows) {
      const url = await win.url();
      if (url.includes("index.html")) {
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Widget window (index.html) not found within ${timeoutMs}ms`);
}

/**
 * Dismiss first-launch onboarding through the real UI (Skip, or Start
 * Monitoring on the last step) so the widget is in its post-onboarding state.
 * No-op when onboarding is already complete.
 */
async function dismissOnboardingIfNeeded(electronApp, timeoutMs = 5000) {
  const onboarding = await findWindowByUrl(
    electronApp,
    "onboarding.html",
    2000,
  ).catch(() => null);
  if (!onboarding) return false;

  const skip = onboarding.locator("#skipBtn");
  const start = onboarding.locator("#startMonitoringBtn");
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  } else if (await start.isVisible().catch(() => false)) {
    await start.click();
  } else {
    // Wait for the step to render its nav buttons, then retry once
    await onboarding.waitForTimeout(1000);
    if (await skip.isVisible().catch(() => false)) await skip.click();
    else await start.click();
  }

  // Wait for the onboarding window to close
  const startWait = Date.now();
  while (Date.now() - startWait < timeoutMs) {
    const stillThere = await findWindowByUrl(
      electronApp,
      "onboarding.html",
      100,
    ).catch(() => null);
    if (!stillThere) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Onboarding window did not close");
}

async function findWindowByUrl(electronApp, urlSubstring, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const windows = electronApp.windows();
    for (const win of windows) {
      const url = await win.url();
      if (url.includes(urlSubstring)) {
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Window with URL containing "${urlSubstring}" not found within ${timeoutMs}ms`,
  );
}

/**
 * Reset the settings store in the main process to the given values.
 * Uses dynamic import — the Electron 40 main process is ESM and has no require().
 */
async function setSettingsStore(app, values) {
  await app.evaluate(
    async (electron, { vals }) => {
      const { default: Store } = await import("electron-store");
      const store = new Store({ name: "quietpls-settings" });
      for (const [key, value] of Object.entries(vals)) {
        store.set(key, value);
      }
    },
    { vals: values },
  );
}

/**
 * Read the settings store from the main process.
 */
async function getSettingsStore(app) {
  return app.evaluate(async () => {
    const { default: Store } = await import("electron-store");
    const store = new Store({ name: "quietpls-settings" });
    return {
      quietThreshold: store.get("quietThreshold"),
      normalThreshold: store.get("normalThreshold"),
      warningThreshold: store.get("warningThreshold"),
      audioDeviceId: store.get("audioDeviceId"),
    };
  });
}

/**
 * Get a BrowserWindow page by its title substring.
 * Waits up to timeoutMs for the window to appear.
 */
async function getWindow(electronApp, titleSubstring, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const windows = electronApp.windows();
    for (const win of windows) {
      const title = await win.title();
      if (title.includes(titleSubstring)) {
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Window with title containing "${titleSubstring}" not found within ${timeoutMs}ms`,
  );
}

module.exports = {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
  setSettingsStore,
  getSettingsStore,
  getWindow,
};
