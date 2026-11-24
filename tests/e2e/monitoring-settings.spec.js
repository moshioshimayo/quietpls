const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { launchApp, getWidgetWindow, installFakeMic, getSettingsStore } = require("./helpers");

test.describe.configure({ mode: "serial" });
test.describe("Settings Monitoring and History", () => {
  let app, widget, settings, profile;
  const monitoring = () => settings.getByRole("tab", { name: "Monitoring", exact: true });
  const history = () => settings.getByRole("tab", { name: "History", exact: true });
  const nativeSettings = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/settings.html"));
    return { bounds: win.getContentBounds(), floating: win.isAlwaysOnTop(), title: win.getTitle() };
  });
  const fixture = (id, extra = {}) => ({
    id, algorithmVersion: 4, startTime: "2026-11-23T14:04:00Z", endTime: "2026-11-23T14:28:00Z", duration: 1440,
    speakingTime: 100, zoneTime: { silent: 1200, normal: 71, warning: 18, danger: 11 }, volumeSamples: [], volumeVariance: 0,
    peakMoments: [{timestamp:"2026-11-23T14:21:00Z",value:12}], ...extra,
  });

  test.beforeAll(async () => {
    ({ app } = await launchApp());
    profile = await app.evaluate(({ app }) => app.getPath("userData"));
    widget = await getWidgetWindow(app);
    await installFakeMic(widget);
    await widget.evaluate(() => window.electronAPI.saveCalibration("fake-builtin", {
      version: 3, baselineDb: -30, speechMs: 10000, calibratedAt: "2026-11-23T12:00:00Z", deviceId: "fake-builtin", deviceLabel: "Fake Built-in Mic",
    }));
    await widget.evaluate(() => window.electronAPI.openSettings());
    await expect.poll(() => app.windows().find((w) => w.url().endsWith("/settings.html"))).toBeTruthy();
    settings = app.windows().find((w) => w.url().endsWith("/settings.html"));
    await settings.waitForLoadState("domcontentloaded");
    await installFakeMic(settings);
    await settings.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event("devicechange")));
  });
  test.afterAll(async () => { if (app) await app.close(); });

  test("is a standard content-fit Settings window with title-bar tabs", async () => {
    await expect(monitoring()).toHaveAttribute("aria-selected", "true");
    await expect(settings.locator("#calibrationDevice")).toHaveText("Fake Built-in Mic");
    await expect(settings.locator("#calibrationStatus")).toHaveText(/Normal voice saved/);
    await expect.poll(nativeSettings).toMatchObject({ bounds: { width: 540 }, floating: false, title: "Monitoring" });
    await expect.poll(() => settings.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
    await expect(settings.locator("#closeSettings")).toHaveCount(0);
    await expect(settings.locator(".settings-header")).toHaveCount(0);
  });

  test("sensitivity is saved and Reset sensitivity preserves the mic and general choices", async () => {
    await settings.locator("#audioDeviceSelect").selectOption("fake-headset");
    await settings.locator("#showInMenubar").uncheck();
    await settings.locator("#meetingDetection").check();
    const beforeGeneral = await settings.evaluate(() => window.electronAPI.getGeneralSettings());
    await settings.locator("#sensitivity").fill("2");
    await settings.locator("#sensitivity").dispatchEvent("input");
    await expect(settings.locator("#marginsDescription")).toHaveText("Getting loud: +4 dB. Ease your voice: +8 dB above normal.");
    await expect.poll(() => getSettingsStore(app)).toMatchObject({ sensitivity: 2, audioDeviceId: "fake-headset" });
    await settings.getByRole("button", { name: "Reset sensitivity", exact: true }).click();
    await expect.poll(() => getSettingsStore(app)).toMatchObject({ sensitivity: 0, audioDeviceId: "fake-headset" });
    expect(await settings.evaluate(() => window.electronAPI.getGeneralSettings())).toEqual(beforeGeneral);
    expect(await settings.evaluate(() => window.electronAPI.getMeetingDetectionEnabled())).toBe(true);
    await expect(settings.locator("#showInMenubar")).not.toBeChecked();
    expect(await widget.evaluate(() => window.electronAPI.getCalibration("fake-builtin"))).toMatchObject({ baselineDb: -30 });
    await settings.locator("#audioDeviceSelect").selectOption("");
    await settings.locator("#meetingDetection").uncheck();
    await settings.locator("#showInMenubar").check();
  });

  test("Test mic releases its stream when History opens, including a pending access request", async () => {
    await settings.getByRole("button", { name: "Test mic", exact: true }).click();
    await expect(settings.getByRole("button", { name: "Stop test", exact: true })).toBeVisible();
    await settings.evaluate(() => {
      window.__firstTestStream = micTestStream;
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => {
        const stream = await original(...args);
        window.__testStream = stream;
        await new Promise((resolve) => { window.__releaseTest = resolve; });
        return stream;
      };
    });
    await history().click();
    expect(await settings.evaluate(() => window.__firstTestStream.getTracks().every((track) => track.readyState === "ended"))).toBe(true);
    await monitoring().click();
    await settings.getByRole("button", { name: "Test mic", exact: true }).click();
    await expect.poll(() => settings.evaluate(() => !!window.__releaseTest)).toBe(true);
    await history().click();
    await settings.evaluate(() => window.__releaseTest());
    await expect.poll(() => settings.evaluate(() => window.__testStream.getTracks().every((t) => t.readyState === "ended"))).toBe(true);
    await monitoring().click();
    await expect(settings.getByRole("button", { name: "Test mic", exact: true })).toBeEnabled();
  });

  test("native tab selection and keyboard shortcuts resize and retitle the window", async () => {
    await expect.poll(nativeSettings).toMatchObject({ title: "Monitoring" });
    await expect.poll(async () => (await nativeSettings()).bounds.height).toBeGreaterThan(300);
    const height = (await nativeSettings()).bounds.height;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/settings.html")).webContents.send("select-settings-tab", "history"));
    await expect(history()).toHaveAttribute("aria-selected", "true");
    await expect(settings.getByText("No sessions yet", {exact:true})).toBeVisible();
    await expect.poll(nativeSettings).toMatchObject({ title: "History" });
    await expect.poll(async () => (await nativeSettings()).bounds.height).toBeLessThan(height);
    await settings.keyboard.press("Meta+1");
    await expect(monitoring()).toHaveAttribute("aria-selected", "true");
    await settings.keyboard.press("Meta+2");
    await expect(history()).toHaveAttribute("aria-selected", "true");
    await settings.keyboard.press("Meta+1");
    await settings.keyboard.press("ArrowRight");
    await expect(history()).toHaveAttribute("aria-selected", "true");
    await settings.keyboard.press("Meta+1");
  });

  test("permission broadcasts replace the mic groups and recover without a restart", async () => {
    const broadcast = (status) => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/settings.html")).webContents.send("microphone-status-changed", value), status);
    await broadcast("denied");
    await expect(settings.locator("#microphoneDenied")).toBeVisible();
    await expect(settings.locator("#microphoneDenied .l")).toContainText("Microphone access is off");
    await expect(settings.getByRole("button", {name:"Open System Settings",exact:true})).toBeVisible();
    await expect(settings.locator("#microphoneGroups")).toBeHidden();
    await broadcast("granted");
    await expect(settings.locator("#microphoneGroups")).toBeVisible();
    await expect(settings.locator("#microphoneDenied")).toBeHidden();
  });

  test("Settings shows the captured mic and exactly the widget's live decision", async () => {
    await widget.locator("#compactPill").click();
    await expect(widget.locator("#pillWord")).toHaveText("Normal", {timeout:15000});
    await expect(settings.locator("#calibrationDevice")).toHaveText("Fake Built-in Mic");
    await widget.evaluate(() => window.__fakeMic.setLevelDb(-8));
    await expect(widget.locator("#pillWord")).toHaveText("Ease your voice", {timeout:15000});
    await expect(settings.locator("#liveLevelText")).toHaveText(/· Ease your voice$/, {timeout:5000});
    await expect(settings.locator("#calibrationStatus")).toHaveText(/Normal voice saved/);
    await widget.evaluate(() => window.__fakeMic.setLevelDb(null));
    await expect(settings.locator("#liveLevelText")).toHaveText("Listening", {timeout:8000});
    await expect(settings.locator("#levelMarker")).toBeHidden();
    // Stop through the widget; even a short real monitoring run remains in History.
    if (!(await widget.locator("#stopBtn").isVisible())) await widget.locator("#compactPill").click();
    await widget.locator("#stopBtn").click();
    await expect.poll(async () => (await settings.evaluate(() => window.electronAPI.getSessions())).data.length).toBeGreaterThan(0);
  });

  test("History has an overview and accessible rows, preserves legacy sessions, and confirms deletion", async () => {
    await widget.evaluate((data) => window.electronAPI.saveSession(data), fixture("modern"));
    await widget.evaluate((data) => window.electronAPI.saveSession(data), fixture("legacy", {algorithmVersion:undefined, grade:"A", zoneTime:{quiet:50,normal:50,loud:0}}));
    await history().click();
    await expect(settings.locator('[data-session-id="modern"]')).toBeVisible();
    await expect(settings.locator('[data-session-id="legacy"]')).toContainText("Before 2.1");
    await expect(settings.locator('[data-session-id="legacy"] .split')).toHaveCount(0);
    await expect(settings.locator('[data-session-id="modern"]')).toContainText("Normal 71%");
    await expect(settings.locator("#historyTotals")).toContainText(/sessions · .* monitored/);
    await expect(settings.locator("#tab-history")).not.toContainText(/\bGrade\b|\bScore\b|Avg Grade/);
    await settings.locator('[data-session-id="modern"] [data-action="view"]').click();
    await expect(settings.locator("#sessionModal")).toContainText("“Ease your voice” shown for 11% of talking time");
    await settings.getByRole("button", {name:"Delete session…",exact:true}).click();
    await expect(settings.getByRole("alertdialog")).toBeVisible();
    expect(await settings.locator("#deleteConfirmModal").evaluate((dialog) => dialog.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
    await expect(settings.getByRole("button", {name:"Cancel",exact:true})).toBeFocused();
    await settings.keyboard.press("Escape");
    await expect(settings.getByRole("button", {name:"Delete session…",exact:true})).toBeFocused();
    await settings.getByRole("button", {name:"Delete session…",exact:true}).click();
    const historyFile = path.join(profile, "sessions.json");
    const originalHistory = fs.readFileSync(historyFile, "utf8");
    fs.writeFileSync(historyFile, "unreadable during delete");
    await settings.getByRole("button", {name:"Delete session",exact:true}).click();
    await expect(settings.locator("#deleteError")).toBeVisible();
    await expect(settings.getByRole("alertdialog")).toBeVisible();
    expect(fs.readFileSync(historyFile, "utf8")).toBe("unreadable during delete");
    fs.writeFileSync(historyFile, originalHistory);
    await settings.getByRole("button", {name:"Delete session",exact:true}).click();
    await expect(settings.locator('[data-session-id="modern"]')).toHaveCount(0);
    expect((await settings.evaluate(() => window.electronAPI.getSession("legacy"))).data.grade).toBe("A");
  });

  test("unreadable history shows a retry state and preserves the original file", async () => {
    const file = path.join(profile,"sessions.json");
    const previous = fs.readFileSync(file,"utf8");
    fs.writeFileSync(file,"not readable history");
    await monitoring().click();
    await history().click();
    await expect(settings.getByText("Couldn’t load history",{exact:true})).toBeVisible();
    expect(fs.readFileSync(file,"utf8")).toBe("not readable history");
    fs.writeFileSync(file,previous);
    await settings.getByRole("button",{name:"Try again",exact:true}).click();
    await expect(settings.locator('[data-session-id="legacy"]')).toBeVisible();
  });
});
