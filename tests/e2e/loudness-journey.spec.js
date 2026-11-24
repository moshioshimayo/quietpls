const { test, expect } = require("@playwright/test");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  SPEECH_WAV,
  launchApp,
  getWidgetWindow,
  getWindow,
  dismissOnboardingIfNeeded,
  installFakeMic,
  installObservers,
  observations,
  finishCalibration,
  widgetBounds,
} = require("./helpers");

/**
 * 2.4.0 loudness journey through the running product (spec AC-6, AC-9,
 * AC-11, AC-13, AC-17, AC-20, AC-21, AC-22; plan "First integrated
 * verification" 2).
 *
 * Only the physical microphone is replaced: the committed speech recording
 * loops through AudioBufferSourceNode -> gain -> MediaStreamDestination and
 * the app's own getUserMedia path. Real capture, the production
 * volume-processor AudioWorklet, calibration, decision tracker, renderer DOM
 * and IPC run unchanged; the observers only read (helpers.installObservers).
 *
 * Gains are dB relative to the recording, which is also what calibration
 * hears, so +12 here is +12 above the saved normal.
 *
 * QUIETPLS_SHOTS=<dir> saves real-window screenshots named after the
 * product-canvas cells (P1.S1.E-3 ...).
 */

const SHOTS = process.env.QUIETPLS_SHOTS;
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({
    path: path.join(SHOTS, name + ".png"),
    omitBackground: true,
  });
}

const sessionCount = (page) =>
  page.evaluate(async () => (await window.electronAPI.getSessions()).data.length);

const relativeLevel = (relDb) =>
  Math.max(0, Math.min(100, ((relDb + 10) / 25) * 100));

/**
 * The native window has settled at 320x240 content and every visible button
 * of the open panel lies inside that actual viewport.
 */
async function expectButtonsInside(app, page) {
  await expect
    .poll(() => widgetBounds(app))
    .toMatchObject({ width: 368 });
  const { vw, vh, rects } = await page.evaluate(() => ({
    vw: window.innerWidth,
    vh: window.innerHeight,
    rects: [...document.querySelectorAll("#expandedPanel button")]
      .filter((b) => b.offsetParent !== null)
      .map((b) => {
        const r = b.getBoundingClientRect();
        return { id: b.id, top: r.top, left: r.left, bottom: r.bottom, right: r.right };
      }),
  }));
  expect(vw).toBe(368);
  expect(vh).toBeGreaterThan(150);
  expect(rects.length).toBeGreaterThan(0);
  for (const r of rects) {
    expect(r.top, r.id).toBeGreaterThanOrEqual(0);
    expect(r.left, r.id).toBeGreaterThanOrEqual(0);
    expect(r.bottom, r.id).toBeLessThanOrEqual(vh);
    expect(r.right, r.id).toBeLessThanOrEqual(vw);
  }
  return rects.map((r) => r.id);
}

test.describe("Loudness journey with recorded speech (2.4)", () => {
  test.describe.configure({ mode: "serial" });
  let app;
  let page;
  const word = () => page.locator("#pillWord");
  const pill = () => page.locator("#compactPill");
  const panel = () => page.locator("#expandedPanel");
  const setLevel = (db) =>
    page.evaluate((d) => window.__fakeMic.setLevelDb(d), db);
  const obs = () => observations(app, page);

  test.beforeAll(async () => {
    ({ app } = await launchApp());
    await dismissOnboardingIfNeeded(app);
    page = await getWidgetWindow(app, 10000);
    await page.waitForLoadState("domcontentloaded");
    await installFakeMic(page, { wav: SPEECH_WAV });
    await installObservers(app, page);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test("idle pill, then guided calibration and the louder/normal rehearsal", async () => {
    test.setTimeout(150000);
    await shot(page, "P1.S1.E-4");
    await pill().click();
    await expect(page.locator("#calibrationView")).toBeVisible();
    await page.locator("#calPrimaryBtn").click();
    await expect(page.locator("#calText")).toHaveText(
      /^[4-9] of 10 seconds heard · Fake Built-in Mic$/,
      { timeout: 30000 },
    );
    await shot(page, "P1.S3.default");
    const cal = await obs();
    expect(cal.decision.zone).toBe("calibrating");

    // Rehearsal: louder sentence until quietpls shows Getting loud or more.
    await expect(page.locator("#calText")).toHaveText(
      "Try a slightly louder voice.",
      { timeout: 45000 },
    );
    const rehearsal = await obs();
    expect(rehearsal.opts.reanchorEnabled).toBe(false);
    await expect(page.locator("#calLiveWord")).toHaveText(/Listening|Normal/, {
      timeout: 10000,
    });
    await shot(page, "P1.S3.E-7");
    await setLevel(8);
    await expect(page.locator("#calTitle")).toHaveText(
      "That's the cue you'll see on calls",
      { timeout: 15000 },
    );
    await shot(page, "P1.S3.E-8");
    await setLevel(0);
    await expect(page.locator("#calTitle")).toHaveText("All set", {
      timeout: 16000,
    });
    await shot(page, "P1.S3.success");
    // A fresh monitoring tracker replaces the rehearsal one.
    const after = await obs();
    expect(after.opts.reanchorEnabled).toBe(true);
    expect(after.trackers).toBeGreaterThan(rehearsal.trackers);
    // Success collapses after about 3 s.
    await expect(pill()).toBeVisible({ timeout: 6000 });
    await expect
      .poll(() => widgetBounds(app))
      .toMatchObject({ width: 240 });
  });

  test("+12 dB turns the compact pill to Ease your voice without any transition", async () => {
    test.setTimeout(60000);
    await expect(word()).toHaveText("Normal", { timeout: 15000 });
    await shot(page, "P1.S1.default");

    const start = await page.evaluate(() => {
      window.__fakeMic.setLevelDb(12);
      return { ...window.__obs, changes: undefined };
    });
    await expect(word()).toHaveText("Getting loud", { timeout: 10000 });
    await shot(page, "P1.S1.E-2");
    await expect(word()).toHaveText("Ease your voice", { timeout: 15000 });
    await expect(pill()).toHaveClass(/\bloud\b/);
    await expect(pill()).toBeVisible();
    await expect(panel()).not.toBeVisible();
    expect(await widgetBounds(app)).toMatchObject({ width: 240 });
    const o = await obs();
    const latch = o.changes.find(
      (c) => c.zone === "danger" && c.audioMs >= start.audioMs,
    );
    console.log(
      `[journey] +12 dB latched after ${latch.audioMs - start.audioMs} audio ms / ` +
        `${latch.acceptedMs - start.acceptedMs} talking ms`,
    );
    await shot(page, "P1.S1.E-3");
  });

  test("details agree with the pill, tray/Settings payload and the actual mic", async () => {
    await pill().click();
    await expect(panel()).toBeVisible();
    await expect(page.locator("#detailsView")).toBeVisible();
    await expect(page.locator("#zoneLabel")).toHaveText("Ease your voice");
    await expect(panel()).toHaveClass(/\bloud\b/);
    await expect(page.locator("#dbReadout")).toHaveText(
      /^\+\d+ dB$/,
    );
    await expect(page.locator("#micLabel")).toHaveText("Fake Built-in Mic");
    await expect(page.locator("#hideBtn")).toBeFocused();

    const { fill, relDb } = await page.evaluate(() => ({
      fill: parseFloat(document.getElementById("relFill").style.left),
      relDb: window.__obs.decision.relDb,
    }));
    expect(Math.abs(fill - relativeLevel(relDb))).toBeLessThan(8);
    // The same decision reaches the tray/Settings path in main.
    const o = await obs();
    expect(o.main.level.zone).toBe("danger");
    expect(o.main.level.visual).toBe("danger");
    expect(o.main.level.label).toBe("Ease your voice");
    expect(Math.abs(o.main.level.level - fill)).toBeLessThan(8);
    expect(await expectButtonsInside(app, page)).toEqual(
      expect.arrayContaining(["hideBtn", "recalibrateBtn", "stopBtn"]),
    );
    await shot(page, "P1.S2.E-3");

    await page.evaluate(() => window.electronAPI.openSettings());
    const settings = await getWindow(app, "Monitoring");
    await settings.waitForLoadState("domcontentloaded");
    await expect(settings.locator("#liveLevelText")).toHaveText(
      /dB above normal/,
      { timeout: 5000 },
    );
    await settings.close();
  });

  test("Hide and Escape while red keep monitoring; the pill stays red", async () => {
    test.setTimeout(60000);
    for (const how of ["Hide", "Escape"]) {
      if (await pill().isVisible()) {
        await pill().focus();
        await page.keyboard.press("Enter");
      }
      await expect(page.locator("#detailsView")).toBeVisible();
      const before = await obs();
      if (how === "Hide") await page.locator("#hideBtn").click();
      else await page.keyboard.press("Escape");
      await expect(pill()).toBeVisible();
      await expect(word()).toHaveText("Ease your voice");
      await expect(pill()).toHaveClass(/monitoring/);
      await page.waitForTimeout(1000);
      const after = await obs();
      expect(after.frames).toBeGreaterThan(before.frames + 20);
      expect(after.main.monitoring).toBe(true);
      await expect(page.locator("#sessionCompletePanel")).not.toBeVisible();
      expect(await widgetBounds(app)).toMatchObject({ width: 240 });
    }
    await shot(page, "P1.S1.E-9");
  });

  test("back to the normal voice clears the cue by speech, not by a silence reset", async () => {
    test.setTimeout(60000);
    const o = await obs();
    // Audio time needed for 4000 talking ms (voiced + gate hangover) of this recording.
    const talkShare = o.acceptedMs / o.audioMs;
    const d4 = 4000 / talkShare;
    const start = await page.evaluate(() => {
      window.__fakeMic.setLevelDb(0);
      return { ...window.__obs, changes: undefined };
    });
    await expect(word()).not.toHaveText("Ease your voice", {
      timeout: d4 + 2000,
    });
    const end = await obs();
    const cleared = end.changes.find(
      (c) => c.zone !== "danger" && c.audioMs >= start.audioMs,
    );
    const between = end.changes.filter(
      (c) => c.audioMs >= start.audioMs && c.audioMs <= cleared.audioMs,
    );
    console.log(
      `[journey] recovery: ${cleared.acceptedMs - start.acceptedMs} talking ms, ` +
        `${cleared.audioMs - start.audioMs} audio ms; ` +
        `talking share ${talkShare.toFixed(2)}, D4 ${Math.round(d4)} ms`,
    );
    expect(cleared.acceptedMs - start.acceptedMs).toBeLessThanOrEqual(4000);
    expect(between.map((c) => c.zone)).not.toContain("silent");
    await expect(word()).toHaveText("Normal", { timeout: 15000 });
    await pill().click();
    await expect(page.locator("#dbReadout")).toHaveText(
      /^(Near or below normal|\+\d dB)$/,
    );
    await expectButtonsInside(app, page);
    await shot(page, "P1.S2.default");
    await page.locator("#hideBtn").click();
  });

  test("set normal voice again, then a quieter setup re-anchors the session (E-10)", async () => {
    test.setTimeout(240000);
    const sessionsBefore = (await sessionCount(page));
    await pill().click();
    await page.locator("#recalibrateBtn").click();
    // The old segment is saved silently: no summary, still monitoring.
    await expect(page.locator("#calibrationView")).toBeVisible();
    await expect(page.locator("#sessionCompletePanel")).not.toBeVisible();
    await expect
      .poll(async () =>
        (await sessionCount(page)),
      )
      .toBe(sessionsBefore + 1);
    await page.locator("#calPrimaryBtn").click();
    await expect(page.locator("#calTitle")).toHaveText("Normal voice saved", { timeout: 45000 });
    await page.locator("#calSecondaryBtn").filter({ hasText: "Done" }).click();
    await expect(pill()).toBeVisible({ timeout: 6000 });

    // Leaning back: 5 dB quieter than the saved normal for 30 s of speech.
    await setLevel(-5);
    const o = await obs();
    const wait = 32000 / (o.acceptedMs / o.audioMs) + 15000;
    await expect(page.locator("#reanchorLine")).toHaveText(
      /^Normal adjusted −[45] dB for this session$/,
      { timeout: wait },
    );
    await pill().click();
    await expect(page.locator("#reanchorLine")).toBeVisible();
    await expect(page.locator("#stopBtn")).toBeVisible();
    const ids = await expectButtonsInside(app, page);
    expect(ids).toEqual(
      expect.arrayContaining(["hideBtn", "recalibrateBtn", "stopBtn"]),
    );
    await shot(page, "P1.S2.E-10");
    await page.keyboard.press("Escape");
    await expect(pill()).toBeVisible();
  });

  test("a lost mic shows no verdict, and the same mic keeps its session", async () => {
    test.setTimeout(30000);
    await expect
      .poll(() => widgetBounds(app))
      .toMatchObject({ width: 240 });
    await page.evaluate(() => window.__fakeMic.endCurrentTrack());
    await expect(word()).toHaveText("Reconnecting mic…", { timeout: 3000 });
    await expect(pill()).toHaveClass(/is-uncertain/);
    await shot(page, "P1.S1.error");
    await expect(word()).toHaveText(/Listening|Normal/, { timeout: 10000 });
    // Same-device reconnect keeps the session's adjusted normal.
    await expect(page.locator("#reanchorLine")).toHaveText(/Normal adjusted/);
    // Details the user opens right after a reconnect stay open.
    await pill().click();
    await page.waitForTimeout(3500);
    await expect(page.locator("#detailsView")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pill()).toBeVisible();
  });

  test("Stop is the only stop: it ends monitoring and shows the summary", async () => {
    test.setTimeout(60000);
    await pill().click();
    await page.locator("#stopBtn").click();
    await expect(page.locator("#sessionCompletePanel")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator("#insightList")).toContainText(
      /speaking time|ease your voice/i,
    );
    expect((await obs()).main.monitoring).toBe(false);
    await page.locator("#sessionCloseBtn").click();
    await expect(word()).toHaveText("Start monitoring");
  });

  test("a different mic gets its own segment and calibration", async () => {
    test.setTimeout(60000);
    await pill().click(); // calibrated built-in mic: monitoring right away
    await expect(word()).toHaveText(/Listening|Normal/, { timeout: 10000 });
    await page.waitForTimeout(3000);
    const before = await sessionCount(page);
    await page.evaluate(() => window.electronAPI.openSettings());
    const settings = await getWindow(app, "Monitoring");
    await settings.waitForLoadState("domcontentloaded");
    await settings.evaluate(() =>
      window.electronAPI.updateSettings({
        sensitivity: 0,
        audioDeviceId: "fake-headset",
      }),
    );
    await settings.close();
    await expect(page.locator("#newMicTitle")).toHaveText("New mic: Fake Headset");
    await page.locator("#newMicSetup").click();
    await expect(word()).toHaveText(/Set normal voice/, { timeout: 8000 });
    await expect(page.locator("#calMicName")).toHaveText("Fake Headset");
    await expect
      .poll(async () =>
        (await sessionCount(page)),
      )
      .toBe(before + 1);
    await expect(page.locator("#sessionCompletePanel")).not.toBeVisible();
    await page.locator("#calSecondaryBtn").click(); // Stop during calibration
    await expect(word()).toHaveText("Set normal voice");
  });
});

// ---- Meeting auto-start with the same recorded speech (2.2.0 regression) ----

const MIC_USERS = path.join(__dirname, "..", "..", "bin", "mic-users");

function micUserPids() {
  return execFileSync(MIC_USERS, { encoding: "utf8" })
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

/** Another app holds the real mic for `seconds` (the existing call helper). */
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

test.describe("Hide during an auto-started call (2.2.0 regression)", () => {
  let app;
  let call;

  test.beforeEach(async () => {
    test.skip(!hasFfmpeg(), "needs ffmpeg to hold the mic");
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

  test("auto-start, red, Hide/Escape keep monitoring; call end stops; next call starts; Stop holds", async () => {
    test.setTimeout(300000);
    ({ app } = await launchApp({ generalSettings: { meetingDetection: true } }));
    await dismissOnboardingIfNeeded(app);
    const page = await getWidgetWindow(app, 10000);
    await page.waitForLoadState("domcontentloaded");
    await installFakeMic(page, { wav: SPEECH_WAV });
    await installObservers(app, page);
    const pill = page.locator("#compactPill");
    const word = page.locator("#pillWord");
    const MONITORING = /\bmonitoring\b/;

    call = await startCall(75);
    await expect(pill).toHaveClass(MONITORING, { timeout: 10000 });
    await expect(word).toHaveText(/Set normal voice/, { timeout: 10000 });
    await finishCalibration(page);
    await expect(pill).toBeVisible({ timeout: 6000 });

    await page.evaluate(() => window.__fakeMic.setLevelDb(12));
    await expect(word).toHaveText("Ease your voice", { timeout: 20000 });
    for (const how of ["Hide", "Escape"]) {
      await pill.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#detailsView")).toBeVisible();
      const before = await observations(app, page);
      if (how === "Hide") await page.locator("#hideBtn").click();
      else await page.keyboard.press("Escape");
      await expect(pill).toBeVisible();
      await expect(pill).toHaveClass(MONITORING);
      await page.waitForTimeout(1000);
      const after = await observations(app, page);
      expect(after.frames).toBeGreaterThan(before.frames + 20);
      expect(after.main.monitoring).toBe(true);
      await expect(page.locator("#sessionCompletePanel")).not.toBeVisible();
    }

    // The call ends: the existing grace period stops the auto-started run.
    await new Promise((resolve) => call.on("exit", resolve));
    await expect(pill).not.toHaveClass(MONITORING, { timeout: 60000 });
    if (await page.locator("#sessionCloseBtn").isVisible()) {
      await page.locator("#sessionCloseBtn").click();
    }

    // The next call starts it again (calibrated now: straight to monitoring).
    call = await startCall(40);
    await expect(page.locator("#pillWord")).toHaveText(
      /Listening|Normal|Getting loud|Ease your voice/,
      { timeout: 15000 },
    );
    await expect(pill).toHaveClass(MONITORING, { timeout: 10000 });

    // An explicit Stop during the call holds until that call ends.
    if (await pill.isVisible()) await pill.click();
    await page.locator("#stopBtn").click();
    await expect(pill).not.toHaveClass(MONITORING, { timeout: 5000 });
    await page.waitForTimeout(6000);
    await expect(pill).not.toHaveClass(MONITORING);
  });
});

// ---- Onboarding "Try it" never rates the voice (AC-20) ----

test("onboarding step 3 says Hearing you / Waiting for your voice and never coaches", async () => {
  test.setTimeout(60000);
  const { app } = await launchApp({
    onboarding: true,
    args: ["--use-fake-device-for-media-stream"],
  });
  try {
    let onboarding = null;
    for (let i = 0; i < 50 && !onboarding; i++) {
      for (const w of app.windows()) {
        if ((await w.url()).includes("onboarding.html")) onboarding = w;
      }
      if (!onboarding) await new Promise((r) => setTimeout(r, 200));
    }
    expect(onboarding).toBeTruthy();
    await onboarding.waitForLoadState("domcontentloaded");
    await installFakeMic(onboarding, { wav: SPEECH_WAV });
    await onboarding.click("#getStartedBtn");

    const step = onboarding.locator('[data-panel="check"]');
    await expect(onboarding.locator("#hearLabel")).toBeVisible();
    await expect(onboarding.locator('[data-panel="ask"]')).not.toBeVisible();
    await expect(onboarding.locator("#hearLabel")).toHaveText(
      "Mic is responding",
      { timeout: 10000 },
    );
    await expect(step).toContainText(
      "Next, talk normally for about 10 seconds to set your normal voice.",
    );
    await expect(step).not.toContainText(
      /nice and calm|sweet spot|too loud|getting loud/i,
    );
    await onboarding.waitForTimeout(600); // step-enter animation
    await shot(onboarding, "P1.S4.default");

    await onboarding.evaluate(() => window.__fakeMic.setLevelDb(null));
    await expect(onboarding.locator("#hearLabel")).toHaveText(
      "Waiting for input",
      { timeout: 5000 },
    );
    await shot(onboarding, "P1.S4.empty");
  } finally {
    await app.close();
  }
});
