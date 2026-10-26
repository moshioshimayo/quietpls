const { test, expect } = require("@playwright/test");
const { execFileSync, spawn } = require("child_process");
const path = require("path");
const {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
} = require("./helpers");

/**
 * E2E: calls start and stop monitoring.
 *
 * A "call" is another process holding the real mic: ffmpeg recording the
 * default input. quietpls also opens the real mic (no fake mic here), so
 * stopping while its own capture is still on the mic proves quietpls ignores
 * its own mic use. Needs ffmpeg, the bin/mic-users helper
 * (npm run build:native) and mic permission for Electron and the terminal.
 */
const HELPER = path.join(__dirname, "..", "..", "bin", "mic-users");
const MONITORING = /\bmonitoring\b/;

function micUserPids() {
  return execFileSync(HELPER, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(line.split("\t")[0]));
}

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

/** Another app holds the mic for `seconds`; resolves once it really has it. */
async function startCall(seconds) {
  const call = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "avfoundation",
    "-i",
    ":default",
    "-t",
    String(seconds),
    "-f",
    "null",
    "-",
  ]);
  await expect.poll(() => micUserPids().includes(call.pid)).toBe(true);
  return call;
}

async function openWidget(options) {
  const { app } = await launchApp({
    generalSettings: { meetingDetection: true },
    ...options,
  });
  await dismissOnboardingIfNeeded(app);
  const widget = await getWidgetWindow(app, 10000);
  return { app, widget, pill: widget.locator("#compactPill") };
}

test.describe("Start automatically in calls", () => {
  let app;
  let call;

  test.beforeEach(async () => {
    test.skip(!hasFfmpeg(), "needs ffmpeg to hold the mic");
    // The previous test's app may take a moment to release the mic.
    const free = await expect
      .poll(() => micUserPids().length, { timeout: 10000 })
      .toBe(0)
      .then(
        () => true,
        () => false,
      );
    test.skip(!free, "another app is already using the mic");
  });

  test.afterEach(async () => {
    if (call && call.exitCode === null) call.kill();
    call = null;
    if (app) await app.close();
    app = null;
  });

  test("starts with a call and stops when it ends", async () => {
    test.setTimeout(120000);
    let widget, pill;
    ({ app, widget, pill } = await openWidget());

    await widget.waitForTimeout(4000);
    await expect(pill).not.toHaveClass(MONITORING);

    call = await startCall(12);
    await expect(pill).toHaveClass(MONITORING, { timeout: 10000 });

    // quietpls's own capture is on the mic too during the call.
    const ownPids = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => m.pid),
    );
    await expect
      .poll(() => micUserPids().some((pid) => ownPids.includes(pid)))
      .toBe(true);

    await new Promise((resolve) => call.on("exit", resolve));
    // 30 s grace after the mic is released, plus a poll.
    await expect(pill).not.toHaveClass(MONITORING, { timeout: 45000 });
  });

  test("a call already running at launch starts monitoring", async () => {
    test.setTimeout(60000);
    call = await startCall(30);
    let pill;
    ({ app, pill } = await openWidget());
    await expect(pill).toHaveClass(MONITORING, { timeout: 10000 });
  });

  test("turning the setting off mid-call stops the auto-started run", async () => {
    test.setTimeout(60000);
    let widget, pill;
    ({ app, widget, pill } = await openWidget());
    call = await startCall(30);
    await expect(pill).toHaveClass(MONITORING, { timeout: 10000 });

    await widget.evaluate(() =>
      window.electronAPI.setMeetingDetectionEnabled(false),
    );
    await expect(pill).not.toHaveClass(MONITORING, { timeout: 5000 });
  });
});
