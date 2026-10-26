const { test, expect } = require("@playwright/test");
const {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
  getWindow,
  installFakeMic,
  setFakeTransports,
} = require("./helpers");

// 2.1.1: opening AirPods' mic makes macOS drop them to call-quality audio,
// so quietpls skips a Bluetooth default everywhere it opens a mic. Real app,
// throwaway profile, mocked device lists and CoreAudio transports.

const BUILTIN = {
  kind: "audioinput",
  deviceId: "fake-builtin",
  groupId: "g-builtin",
  label: "MacBook Pro Microphone (Built-in)",
};
const AIRPODS = {
  kind: "audioinput",
  deviceId: "fake-airpods",
  groupId: "g-airpods",
  label: "AirPods",
};
const CORE_BUILTIN = { name: "MacBook Pro Microphone", transport: "builtin" };
const CORE_AIRPODS = { name: "Alex's AirPods", transport: "bluetooth" };

const gumIds = (page) =>
  page.evaluate(() =>
    window.__fakeMic
      .gumCalls()
      .map((c) => (c.audio.deviceId && c.audio.deviceId.exact) || "default"),
  );

test.describe("Bluetooth mic policy — widget and Settings", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp;
  let page;
  let settingsPage;
  const label = () => page.locator("#zoneLabel");

  test.beforeAll(async () => {
    const { app } = await launchApp();
    electronApp = app;
    await dismissOnboardingIfNeeded(electronApp);
    page = await getWidgetWindow(electronApp, 10000);
    await page.waitForLoadState("domcontentloaded");
    await setFakeTransports(electronApp, [
      { ...CORE_BUILTIN, isDefault: false },
      { ...CORE_AIRPODS, isDefault: true },
    ]);
    await installFakeMic(page, {
      devices: [BUILTIN, AIRPODS],
      defaultId: "fake-airpods",
    });
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  test("AirPods as the default input: monitoring captures the built-in mic and calibrates it", async () => {
    await page.locator("#compactPill").click();
    await expect(label()).toHaveText(/Calibrating/, { timeout: 5000 });
    expect(await gumIds(page)).toEqual(["fake-builtin"]);
    await expect(label()).toHaveText(/Normal/, { timeout: 12000 });
  });

  test("AirPods reconnecting mid-session don't move capture", async () => {
    await page.evaluate(
      ({ b, a }) => window.__fakeMic.setDevices([b], "fake-builtin"),
      { b: BUILTIN, a: AIRPODS },
    );
    await page.evaluate(
      ({ b, a }) => window.__fakeMic.setDevices([b, a], "fake-airpods"),
      { b: BUILTIN, a: AIRPODS },
    );
    await page.waitForTimeout(1000);
    expect(await gumIds(page)).toEqual(["fake-builtin"]);
    await expect(label()).toHaveText(/Normal|Not speaking/);
  });

  test("Settings marks the Bluetooth mic, notes it, and respects an explicit pick", async () => {
    await page.evaluate(() => window.electronAPI.openSettings());
    settingsPage = await getWindow(electronApp, "Settings");
    await settingsPage.waitForLoadState("domcontentloaded");
    await installFakeMic(settingsPage, {
      devices: [BUILTIN, AIRPODS],
      defaultId: "fake-airpods",
    });
    await expect(settingsPage.locator("#calibrationDevice")).toHaveText(
      BUILTIN.label,
    );
    // Re-enumerate with the mocked list (as on a devicechange).
    await settingsPage.evaluate(
      ({ b, a }) => window.__fakeMic.setDevices([b, a], "fake-airpods"),
      { b: BUILTIN, a: AIRPODS },
    );
    const select = settingsPage.locator("#audioDeviceSelect");
    await expect(select.locator("option")).toHaveText([
      "System Default (skips Bluetooth mics)",
      "MacBook Pro Microphone (Built-in)",
      "AirPods (Bluetooth)",
    ]);
    const note = settingsPage.locator("#bluetoothMicNote");
    await expect(note).toBeHidden();

    // Mic test on System Default never opens the Bluetooth default either.
    await settingsPage.locator("#testMicBtn").click();
    await expect.poll(() => gumIds(settingsPage)).toEqual(["fake-builtin"]);
    await settingsPage.locator("#testMicBtn").click();

    await select.selectOption("fake-airpods");
    await expect(note).toBeVisible();
    await expect(note).toHaveText(
      "Using a Bluetooth mic switches your headphones to call-quality audio.",
    );
    await expect
      .poll(() => gumIds(page))
      .toEqual(["fake-builtin", "fake-airpods"]);
    await expect(settingsPage.locator("#calibrationDevice")).toHaveText(
      "AirPods",
    );
    // The AirPods mic gets its own calibration.
    await expect(label()).toHaveText(/Calibrating/, { timeout: 5000 });
    await expect(label()).toHaveText(/Normal/, { timeout: 12000 });

    await select.selectOption("");
    await expect(note).toBeHidden();
    await expect
      .poll(() => gumIds(page))
      .toEqual(["fake-builtin", "fake-airpods", "fake-builtin"]);
    // Back on the built-in mic: its saved calibration is reused, no prompt.
    await expect(label()).toHaveText(/Normal|Not speaking/, { timeout: 5000 });
  });

  test("stopping returns to idle", async () => {
    await settingsPage.close();
    await page.locator("#stopBtn").click();
    await expect(page.locator("#expandedPanel")).not.toBeVisible({
      timeout: 5000,
    });
  });
});

test.describe("Bluetooth mic policy — stale transport snapshot (review P1)", () => {
  test("AirPods become the default mid-session while transports still name the built-in default: capture stays on the built-in mic", async () => {
    const { app } = await launchApp();
    try {
      await dismissOnboardingIfNeeded(app);
      const page = await getWidgetWindow(app, 10000);
      await page.waitForLoadState("domcontentloaded");
      // Transports keep reporting the old state (built-in default, no AirPods).
      await setFakeTransports(app, [{ ...CORE_BUILTIN, isDefault: true }]);
      await installFakeMic(page, {
        devices: [BUILTIN],
        defaultId: "fake-builtin",
      });
      await page.locator("#compactPill").click();
      await expect(page.locator("#zoneLabel")).toHaveText(/Calibrating/, {
        timeout: 5000,
      });
      await page.evaluate(
        ({ b, a }) => window.__fakeMic.setDevices([b, a], "fake-airpods"),
        { b: BUILTIN, a: AIRPODS },
      );
      // Device change + the bounded re-checks that follow it.
      await page.waitForTimeout(3000);
      expect(await gumIds(page)).toEqual(["fake-builtin"]);
    } finally {
      await app.close();
    }
  });
});

test.describe("Bluetooth mic policy — only a Bluetooth mic", () => {
  test("uses it and shows the one-time note once", async () => {
    const { app } = await launchApp();
    try {
      await dismissOnboardingIfNeeded(app);
      const page = await getWidgetWindow(app, 10000);
      await page.waitForLoadState("domcontentloaded");
      await setFakeTransports(app, [{ ...CORE_AIRPODS, isDefault: true }]);
      await installFakeMic(page, {
        devices: [AIRPODS],
        defaultId: "fake-airpods",
      });
      const notes = () => app.evaluate(() => globalThis.__quietplsNotes || []);

      await page.locator("#compactPill").click();
      await expect(page.locator("#zoneLabel")).toHaveText(/Calibrating/, {
        timeout: 5000,
      });
      expect(await gumIds(page)).toEqual(["fake-airpods"]);
      await expect
        .poll(notes)
        .toEqual(["quietpls is using your Bluetooth mic"]);

      // Second session: no second note.
      await page.locator("#stopBtn").click();
      await expect(page.locator("#expandedPanel")).not.toBeVisible({
        timeout: 5000,
      });
      await page.locator("#compactPill").click();
      await expect(page.locator("#zoneLabel")).toHaveText(
        /Calibrating|Normal|Not speaking/,
        { timeout: 5000 },
      );
      await page.waitForTimeout(500);
      expect(await notes()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

test.describe("Bluetooth mic policy — onboarding", () => {
  test("the onboarding demo meter opens the built-in mic, not the AirPods default", async () => {
    // Chromium's fake capture device: the first demo start never touches a
    // real mic before the mock is installed.
    const { app } = await launchApp({
      onboarding: true,
      args: ["--use-fake-device-for-media-stream"],
    });
    try {
      await setFakeTransports(app, [
        { ...CORE_BUILTIN, isDefault: false },
        { ...CORE_AIRPODS, isDefault: true },
      ]);
      let onboarding = null;
      for (let i = 0; i < 50 && !onboarding; i++) {
        for (const w of app.windows()) {
          if ((await w.url()).includes("onboarding.html")) onboarding = w;
        }
        if (!onboarding) await new Promise((r) => setTimeout(r, 200));
      }
      expect(onboarding).toBeTruthy();
      await onboarding.waitForLoadState("domcontentloaded");
      await installFakeMic(onboarding, {
        devices: [BUILTIN, AIRPODS],
        defaultId: "fake-airpods",
      });
      // (Re)enter the demo step so it opens a mic with the mock in place.
      await onboarding.evaluate(() => window.goToStep(2));
      await onboarding.waitForTimeout(500);
      await onboarding.evaluate(() => window.goToStep(3));
      await expect.poll(() => gumIds(onboarding)).toEqual(["fake-builtin"]);
    } finally {
      await app.close();
    }
  });
});
