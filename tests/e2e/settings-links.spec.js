const { test, expect } = require("@playwright/test");
const {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
  getWindow,
} = require("./helpers");

// Settings links open in the browser, never inside the app (spec A1).
// No live network: shell.openExternal is stubbed and every non-file request
// is cancelled in the main process.

const ISSUES = "https://github.com/moshioshimayo/quietpls/issues";

test.describe("Settings links and navigation lock", () => {
  let electronApp;
  let page;
  let settings;

  const opened = () => electronApp.evaluate(() => globalThis.__opened);
  const expectOnSettings = async () => {
    expect(new URL(settings.url()).pathname).toMatch(/\/settings\.html$/);
    // Same document: the page's own content is still there.
    // (evaluate, not locator waits: Playwright keeps waiting on a cancelled navigation)
    expect(
      await settings.evaluate(() => [
        location.pathname.endsWith("/settings.html"),
        Boolean(document.querySelector(".support-link a")),
      ]),
    ).toEqual([true, true]);
  };

  test.beforeAll(async () => {
    ({ app: electronApp } = await launchApp());
    await electronApp.evaluate(({ shell, session }) => {
      globalThis.__opened = [];
      shell.openExternal = async (url) => {
        globalThis.__opened.push(url);
      };
      session.defaultSession.webRequest.onBeforeRequest((details, cb) =>
        cb({ cancel: !details.url.startsWith("file:") && !details.url.startsWith("devtools:") }),
      );
    });
    await dismissOnboardingIfNeeded(electronApp);
    page = await getWidgetWindow(electronApp, 10000);
    await page.evaluate(() => window.electronAPI.openSettings());
    settings = await getWindow(electronApp, "Settings");
    await settings.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  test("support link opens the issues page in the browser", async () => {
    await settings.locator(".support-link a").click({ noWaitAfter: true });
    await expect.poll(opened).toEqual([ISSUES]);
    await settings.waitForTimeout(500);
    await expectOnSettings();
  });

  test("scripted navigation away from Settings is cancelled", async () => {
    const prev = await opened();
    for (const target of [
      "https://example.invalid/",
      "http://example.invalid/",
      "file:///etc/hosts",
    ]) {
      await settings.evaluate((t) => {
        location.href = t;
      }, target);
      await settings.waitForTimeout(500);
      await expectOnSettings();
    }
    // Nothing but the support link is ever handed to the browser.
    expect(await opened()).toEqual(prev);
  });

  test("window.open never creates an app window", async () => {
    const before = electronApp.windows().length;
    const prev = await opened();
    const results = await settings.evaluate((urls) => urls.map((u) => window.open(u) === null), [
      ISSUES,
      "https://example.invalid/",
      "javascript:alert(1)",
    ]);
    expect(results).toEqual([true, true, true]);
    await settings.waitForTimeout(500);
    expect(electronApp.windows().length).toBe(before);
    expect(await opened()).toEqual([...prev, ISSUES]);
    await expectOnSettings();
  });

  test("Settings and the widget still use call history", async () => {
    const saved = await page.evaluate(() =>
      window.electronAPI.saveSession({
        id: "e2e-settings-links",
        startTime: "2025-06-01T10:00:00.000Z",
        endTime: "2025-06-01T10:30:00.000Z",
        duration: 1800,
        volumeSamples: [40, 50],
        volumeVariance: 5,
        peakMoments: [],
        zoneTime: { silent: 0, quiet: 900, normal: 900, loud: 0 },
      }),
    );
    expect(saved.success).toBe(true);
    const listed = await settings.evaluate(() => window.electronAPI.getSessions());
    expect(listed.data.map((s) => s.id)).toContain("e2e-settings-links");
    expect((await settings.evaluate(() => window.electronAPI.getSessionStats())).success).toBe(true);
    expect(
      await settings.evaluate(() => window.electronAPI.deleteSession("e2e-settings-links")),
    ).toEqual({ success: true, deleted: true });
  });
});
