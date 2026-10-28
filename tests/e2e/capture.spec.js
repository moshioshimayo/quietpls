// Capture (beta): the opt-in call capture state machine, end to end in the real app,
// with fake transports (capture/e2e-fakes.js): no mic, no system audio, no whisper.
// A fake mic user stands in for a meeting app; a fake recorder writes a synthetic
// stereo WAV; a fake transcriber returns one line per side. Git, the transcript
// file, the audio deletion and the remote refusal are real.
const { test, expect, _electron: electron } = require("@playwright/test");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..", "..");
const ZOOM = "4242\tus.zoom.xos\n";
const scratch = []; // temp profiles and transcript repos, removed after each test

async function launch({ captureSettings } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "quietpls-e2e-"));
  scratch.push(userData);
  fs.writeFileSync(
    path.join(userData, "quietpls-app-state.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  // A placeholder speech model file: the fake transcriber never reads it.
  fs.mkdirSync(path.join(userData, "models"));
  fs.writeFileSync(path.join(userData, "models", "ggml-base.en.bin"), "fake");
  if (captureSettings)
    fs.writeFileSync(
      path.join(userData, "capture-settings.json"),
      JSON.stringify(captureSettings),
    );
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [path.join(APP_ROOT, "main.js")],
    env: {
      ...process.env,
      QUIETPLS_E2E_TEST: "1",
      QUIETPLS_CAPTURE_FAKES: "1",
      QUIETPLS_USER_DATA: userData,
      NODE_ENV: "test",
    },
  });
  await app.firstWindow();
  return { app, userData };
}

async function windowByUrl(app, part, timeout = 10000) {
  let found = null;
  await expect
    .poll(
      async () => {
        for (const w of app.windows()) if (w.url().includes(part)) found = w;
        return Boolean(found);
      },
      { timeout },
    )
    .toBe(true);
  return found;
}

const isVisible = (app, part) =>
  app.evaluate(
    ({ BrowserWindow }, p) =>
      BrowserWindow.getAllWindows().some(
        (w) => w.webContents.getURL().includes(p) && w.isVisible(),
      ),
    part,
  );

const setMicUsers = (app, out) =>
  app.evaluate((_e, o) => {
    globalThis.__quietplsFakeMicUsers = o;
  }, out);

const phase = async (page) =>
  (await page.evaluate(() => window.qpc.snapshot())).state.phase;

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quietpls-e2e-notes-"));
  scratch.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return dir;
}
const commits = (dir) =>
  Number(
    execFileSync("git", ["-C", dir, "rev-list", "--count", "--all"], {
      encoding: "utf8",
    }).trim() || 0,
  );
const mdFiles = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
const audioFiles = (userData) => {
  const d = path.join(userData, "capture-audio");
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

test.describe("Capture (beta)", () => {
  let app;
  test.afterEach(async () => {
    if (app) await app.close().catch(() => {});
    app = null;
    for (const d of scratch.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  test("is off by default: a call raises nothing and Settings shows it off", async () => {
    let userData;
    ({ app, userData } = await launch());
    await setMicUsers(app, ZOOM);
    await app.evaluate(({ ipcMain }) => ipcMain.emit("open-settings"));
    const settings = await windowByUrl(app, "settings.html");
    await expect(settings.locator("#captureSection h4")).toHaveText(
      "Capture (beta)",
    );
    await expect(settings.locator("#captureEnabled")).not.toBeChecked();
    await expect(settings.locator("#captureActions")).toBeHidden();
    await settings.waitForTimeout(4000); // two detector polls, if it were running
    expect(app.windows().some((w) => w.url().includes("banner.html"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(userData, "capture-settings.json"))).toBe(
      false,
    );
  });

  test("consent → recording → transcribing → saved; then skip; then a remote is refused", async () => {
    test.setTimeout(90000);
    const notes = gitRepo();
    let userData;
    ({ app, userData } = await launch({
      captureSettings: { enabled: false, folder: notes },
    }));

    // Turn it on through quietpls's Settings section.
    await app.evaluate(({ ipcMain }) => ipcMain.emit("open-settings"));
    const settings = await windowByUrl(app, "settings.html");
    await settings.locator("#captureEnabled").evaluate((el) => el.click());
    await expect(settings.locator("#captureEnabled")).toBeChecked();
    await expect(settings.locator("#captureActions")).toBeVisible();
    await expect(settings.locator("#captureDescription")).toContainText(
      "asked before any call is recorded",
    );

    // A call starts: the consent banner asks; nothing is recorded yet.
    await setMicUsers(app, ZOOM);
    const banner = await windowByUrl(app, "banner.html");
    await expect.poll(() => isVisible(app, "banner.html")).toBe(true);
    await expect(banner.locator("#app")).toHaveText("Zoom");
    await expect(banner.locator("#accept")).toHaveText("Record this call");
    expect(await phase(banner)).toBe("asking");
    expect(audioFiles(userData)).toEqual([]);

    // Yes: recording, with the indicator up and the banner gone.
    await banner.locator("#accept").click();
    await expect.poll(() => phase(banner)).toBe("recording");
    const indicator = await windowByUrl(app, "indicator.html");
    await expect.poll(() => isVisible(app, "indicator.html")).toBe(true);
    await expect(indicator.locator("#label")).toContainText("REC");
    await expect.poll(() => isVisible(app, "banner.html")).toBe(false);

    // The call ends: after the grace period the call is transcribed and committed.
    await setMicUsers(app, "");
    await expect.poll(() => phase(banner), { timeout: 30000 }).toBe("saved");
    await expect(indicator.locator("#label")).toHaveText("Saved");
    expect(commits(notes)).toBe(1);
    const [file] = mdFiles(notes);
    const md = fs.readFileSync(path.join(notes, file), "utf8");
    expect(md).toContain('apps: ["Zoom"]');
    expect(md).toContain("audio: deleted");
    expect(md).toMatch(/\[you\] Sure, hosting was forty thousand\./);
    expect(md).toMatch(
      /\[them\] Thanks for joining, can you share the budget\?/,
    );
    expect(audioFiles(userData)).toEqual([]); // audio deleted after transcription

    // The transcripts window lists it.
    await banner.evaluate(() => window.qpc.openMain("calls"));
    const transcripts = await windowByUrl(app, "renderer/main.html");
    await expect(transcripts.locator("#rows li")).toHaveCount(1);

    // Back to idle once "saved" is dismissed (8 s).
    await expect.poll(() => phase(banner), { timeout: 15000 }).toBe("idle");

    // Next call, "Not now": nothing recorded, no new commit.
    await setMicUsers(app, ZOOM);
    await expect.poll(() => phase(banner)).toBe("asking");
    await banner.locator("#skip").click();
    await expect.poll(() => phase(banner)).toBe("detected");
    await setMicUsers(app, "");
    await expect.poll(() => phase(banner), { timeout: 20000 }).toBe("idle");
    expect(commits(notes)).toBe(1);

    // A remote appears on the transcript repo: the banner refuses, and so does accept.
    execFileSync("git", [
      "-C",
      notes,
      "remote",
      "add",
      "origin",
      "https://example.com/fake/notes.git",
    ]);
    await setMicUsers(app, ZOOM);
    await expect.poll(() => phase(banner)).toBe("asking");
    await expect(banner.locator("#warn")).toContainText("has a remote");
    await expect(banner.locator("#accept")).toHaveText("Fix in Settings");
    await banner.evaluate(() => window.qpc.accept());
    await banner.waitForTimeout(1000);
    expect(await phase(banner)).not.toBe("recording");
    expect(commits(notes)).toBe(1);
    expect(mdFiles(notes)).toHaveLength(1);
    expect(audioFiles(userData)).toEqual([]);
  });

  test("always-on needs its own typed consent and never starts by itself", async () => {
    const notes = gitRepo();
    ({ app } = await launch({
      captureSettings: { enabled: true, folder: notes },
    }));
    const main = await (async () => {
      await app.evaluate(({ ipcMain }) => ipcMain.emit("open-settings"));
      const settings = await windowByUrl(app, "settings.html");
      await expect(settings.locator("#captureEnabled")).toBeChecked();
      await settings.locator("#captureSettingsBtn").click();
      return windowByUrl(app, "renderer/main.html");
    })();
    expect(await phase(main)).toBe("idle"); // enabled in settings, not always-on
    await main.evaluate(() => window.qpc.ambientDialog());
    const consent = await windowByUrl(app, "ambient-consent.html");
    await expect(consent.locator("#start")).toBeDisabled();
    await consent.locator("#confirmation").fill("always on");
    await expect(consent.locator("#start")).toBeDisabled();
    await consent.locator("#confirmation").fill("ALWAYS ON");
    await expect(consent.locator("#start")).toBeEnabled();
    await consent.locator("#cancel").click();
    await expect
      .poll(() =>
        app.windows().some((w) => w.url().includes("ambient-consent")),
      )
      .toBe(false);
    expect(await phase(main)).toBe("idle");
  });
});
