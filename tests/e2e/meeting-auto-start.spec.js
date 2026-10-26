const { test, expect } = require("@playwright/test");
const { execFileSync, spawn } = require("child_process");
const path = require("path");
const {
  launchApp,
  getWidgetWindow,
  dismissOnboardingIfNeeded,
} = require("./helpers");

/**
 * E2E: a call starts monitoring, and the call ending stops it.
 *
 * A "call" is another process holding the real mic: ffmpeg recording the
 * default input. quietpls also opens the real mic (no fake mic here), so
 * stopping when ffmpeg lets go proves quietpls ignores its own mic use.
 * Needs ffmpeg, the bin/mic-users helper (npm run build:native) and mic
 * permission for both Electron and the terminal.
 */
const HELPER = path.join(__dirname, "..", "..", "bin", "mic-users");

function micUsers() {
  return execFileSync(HELPER, { encoding: "utf8" }).trim();
}

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

test("monitoring starts with a call and stops when it ends", async () => {
  test.skip(!hasFfmpeg(), "needs ffmpeg to hold the mic");
  test.skip(micUsers() !== "", "another app is already using the mic");
  test.setTimeout(120000);

  const { app } = await launchApp();
  let call;
  try {
    await dismissOnboardingIfNeeded(app);
    const widget = await getWidgetWindow(app, 10000);
    await widget.evaluate(() =>
      window.electronAPI.setMeetingDetectionEnabled(true),
    );
    const pill = widget.locator("#compactPill");

    await widget.waitForTimeout(4000);
    await expect(pill).not.toHaveClass(/\bmonitoring\b/);

    call = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-i",
      ":default",
      "-t",
      "12",
      "-f",
      "null",
      "-",
    ]);
    await expect(pill).toHaveClass(/\bmonitoring\b/, { timeout: 10000 });
    console.log("mic users during the call:\n" + micUsers());

    await new Promise((resolve) => call.on("exit", resolve));
    // 30 s grace after the mic is released, plus a poll.
    await expect(pill).not.toHaveClass(/\bmonitoring\b/, { timeout: 45000 });
  } finally {
    if (call && call.exitCode === null) call.kill();
    await app.close();
  }
});
