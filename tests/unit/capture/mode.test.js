import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import vm from "vm";

// Loads the real createCaptureMode with Electron mocked (tests/unit/setup.js) and the
// recorder, mic check, whisper and mic-users helper replaced: no microphone or system
// audio is ever opened. Synthetic files only, removed afterwards.
const require = createRequire(import.meta.url);
const electron = require("electron");
const Wav = require("../../../capture/lib/wav.js");
const repo = require("../../../capture/lib/repo.js");
const copy = require("../copy-helpers.js");

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};
afterAll(() =>
  made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
);

const windows = [];
class FakeWindow {
  static getAllWindows() {
    return windows;
  }
  constructor(opts = {}) {
    this.visible = false;
    this.snap = null;
    this.url = "";
    this.events = {};
    this.bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 0, height: opts.height || 0 };
    windows.push(this);
    this.webContents = {
      send: (channel, data) => {
        if (channel === "snapshot") this.snap = data;
      },
      on() {},
      once() {},
      isLoading: () => false,
      getURL: () => this.url,
    };
  }
  loadFile(file) {
    this.page = path.basename(file, ".html");
    this.url = `file://${file}`;
  }
  on(event, fn) {
    this.events[event] = fn;
  }
  getBounds() {
    return { ...this.bounds };
  }
  getSize() {
    return [this.bounds.width, this.bounds.height];
  }
  setSize(width, height) {
    Object.assign(this.bounds, { width, height });
  }
  setPosition(x, y) {
    Object.assign(this.bounds, { x, y });
  }
  once() {}
  isDestroyed() {
    return false;
  }
  isVisible() {
    return this.visible;
  }
  show() {
    this.visible = true;
  }
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  moveTop() {}
  focus() {}
  close() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
}

let handlers = {};
let pickedFolder = null;
Object.assign(electron, {
  BrowserWindow: FakeWindow,
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    getDisplayMatching: () => ({
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
    }),
  },
  dialog: {
    showOpenDialog: async () => ({
      canceled: false,
      filePaths: [pickedFolder],
    }),
  },
});
electron.ipcMain.handle = (name, fn) => {
  handlers[name.replace(/^capture:/, "")] = fn;
};
const { createCaptureMode } = require("../../../capture/mode.js");

vi.spyOn(console, "log").mockImplementation(() => {});
afterEach(() => vi.useRealTimers());

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick();
  }
}

/** A capture mode with a user data dir, a transcript folder and fakes. */
function makeMode({ settings = {}, data = mkdtemp("qpc-mode-data-") } = {}) {
  const folder = settings.folder || mkdtemp("qpc-mode-folder-");
  fs.mkdirSync(path.join(data, "models"), { recursive: true });
  fs.writeFileSync(path.join(data, "models", "ggml-base.en.bin"), "fake");
  const file = path.join(data, "capture-settings.json");
  if (!fs.existsSync(file))
    fs.writeFileSync(
      file,
      JSON.stringify({ enabled: true, folder, ...settings }),
    );
  const t = {
    data,
    folder,
    launches: 0,
    child: null, // the fake recorder: { opts, kills }
    micChecks: 0,
    polls: 0,
    transcriptions: [],
    micUsers: "4242\tus.zoom.xos\n",
    gate: null, // when set, the next mic check waits for t.release()
  };
  t.release = () => {};
  handlers = {};
  const mode = createCaptureMode({
    app: {
      getPath: (k) => (k === "userData" ? data : os.tmpdir()),
      getAppMetrics: () => [],
      isPackaged: false,
      on() {},
      quit() {},
    },
    binDir: data,
    getTray: () => null,
    deps: {
      startCapture: (opts) => {
        t.launches++;
        t.child = { opts, kills: [], pid: undefined };
        t.child.kill = (sig) => t.child.kills.push(sig);
        t.child.revoke = () => t.child.kills.push("SIGUSR1");
        queueMicrotask(() => opts.onMessage({ type: "started" }));
        return t.child;
      },
      transcribe: async (_bin, _model, file) => {
        t.transcriptions.push(file);
        return { transcription: [{ offsets: { from: 0, to: 100 }, text: "My side" }] };
      },
      findWhisper: () => "/usr/bin/true",
      checkMic: () => {
        t.micChecks++;
        if (!t.gate) return Promise.resolve("granted");
        const p = new Promise((r) => (t.release = () => r("granted")));
        t.gate = null;
        return p;
      },
      detectorExecFile: (_bin, _args, _opts, cb) => {
        t.polls++;
        cb(null, t.micUsers);
      },
    },
  });
  t.mode = mode;
  t.handlers = handlers;
  return t;
}

async function inCall(t) {
  await t.handlers.settings({}, {}); // starts call detection
  await until(() => t.mode.summary().phase === "asking");
  // The detection's own health check (the 2nd mic check) has started, so a gate
  // set after this is met by the Record click's check, not that one.
  await until(() => t.micChecks >= 2);
}

/** Clicked Record while the mic check is gated: wait until the click reached it. */
const atGate = (t) => until(() => !t.gate);

describe("consent race while the mic check is pending", () => {
  it("doesn't start the recorder when capture is turned off after Record was clicked", async () => {
    const t = makeMode();
    await inCall(t);
    t.gate = true;
    const accepting = t.handlers.accept();
    await atGate(t);
    await t.handlers["set-enabled"]({}, false);
    t.release();
    await accepting;
    expect(t.launches).toBe(0);
    expect(t.mode.summary().phase).toBe("off");
  });

  it("doesn't start the recorder when the user says Not this time after Record was clicked", async () => {
    const t = makeMode();
    await inCall(t);
    t.gate = true;
    const accepting = t.handlers.accept();
    await atGate(t);
    t.handlers.skip();
    t.release();
    await accepting;
    expect(t.launches).toBe(0);
    expect(t.mode.summary().phase).toBe("detected");
    await t.handlers["set-enabled"]({}, false);
  });

  it("starts exactly one recorder for two quick Record clicks", async () => {
    const t = makeMode();
    await inCall(t);
    t.gate = true;
    const a = t.handlers.accept();
    const b = t.handlers.accept();
    await atGate(t);
    t.release();
    await Promise.all([a, b]);
    expect(t.launches).toBe(1);
    expect(t.mode.summary().phase).toBe("recording");
    await t.handlers["set-enabled"]({}, false);
  });
});

const ZOOM = "4242\tus.zoom.xos\n";
const TEAMS = "4343\tcom.microsoft.teams2\n";

/** Run the real banner renderer (common.js + banner.js) on a snapshot; returns its text. */
function renderBanner(snap) {
  const els = {};
  let onSnapshot = null;
  const ctx = {
    document: {
      querySelector: (sel) =>
        (els[sel] ||= { textContent: "", hidden: false, offsetHeight: 100 }),
    },
    window: {
      qpc: {
        on: (name, fn) => name === "snapshot" && (onSnapshot = fn),
        snapshot: () => new Promise(() => {}),
        fit() {},
      },
    },
    requestAnimationFrame() {},
  };
  vm.createContext(ctx);
  for (const f of ["common.js", "banner.js"])
    vm.runInContext(
      fs.readFileSync(
        new URL(`../../../capture/renderer/${f}`, import.meta.url),
        "utf8",
      ),
      ctx,
    );
  onSnapshot(snap);
  return {
    apps: els["#app"].textContent,
    warn: els["#warn"].hidden ? "" : els["#warn"].textContent,
    accept: els["#accept"].textContent,
  };
}

describe("call banner placement (AC-X10)", () => {
  it("stacks under quietpls's pill and its open details panel, then follows it", async () => {
    // quietpls's pill window with its details panel open (main.js owns it). The window
    // is 368 × 330 with transparent margins (32 sides, 24 top, 40 bottom), so what you
    // see is the 304 × 266 rect at (1102, 57): right edge 1406, bottom 323.
    const pill = new FakeWindow({ x: 1070, y: 33, width: 368, height: 330 });
    pill.url = "file:///app/index.html";
    pill.visible = true;
    try {
      const t = makeMode();
      t.micUsers = ZOOM;
      await inCall(t);
      const banner = windows.findLast((w) => w.page === "banner");
      expect(banner.visible).toBe(true);
      const card = banner.getBounds();
      // Visible card top (window y + 8 px shadow margin) is 8 px under the visible pill.
      expect(card.y + 8).toBe(323 + 8);
      // Right edges line up (24 px transparent side margin) with the visible pill.
      expect(card.x + card.width - 24).toBe(1406);

      // Details close: the pill window shrinks to 240 × 94 (right edge kept) and the
      // banner moves up with the visible 176 × 30 pill.
      Object.assign(pill.bounds, { x: 1198, width: 240, height: 94 });
      pill.events.resize();
      expect(banner.getBounds().y + 8).toBe(33 + 24 + 30 + 8);
      expect(banner.getBounds().x + banner.getBounds().width - 24).toBe(1406);

      // Pill dragged to the bottom of the screen: the banner's visible card (window
      // minus its 40 px bottom shadow margin) ends 8 px above the visible pill.
      Object.assign(pill.bounds, { y: 806 });
      pill.events.move();
      const above = banner.getBounds();
      expect(above.y + above.height - 40).toBe(806 + 24 - 8);
      await t.handlers["set-enabled"]({}, false);
    } finally {
      windows.splice(windows.indexOf(pill), 1);
    }
  });
});

describe("an app set to Never is on the call", () => {
  it("doesn't record when Zoom (Never) is on the mic with Teams (Ask), and the banner names both", async () => {
    const t = makeMode({ settings: { neverApps: ["Zoom"] } });
    t.micUsers = TEAMS + ZOOM;
    await inCall(t);
    expect(t.mode.summary().phase).toBe("asking");
    const banner = windows.findLast((w) => w.page === "banner");
    const shown = renderBanner(banner.snap);
    expect(shown.apps).toContain("Microsoft Teams");
    expect(shown.apps).toContain("Zoom");
    expect(shown.warn).toMatch(/Zoom is set to Never/);
    expect(shown.accept).toBe("Open settings");

    await t.handlers.accept(); // e.g. "Record this call" from the tray menu
    expect(t.launches).toBe(0);
    expect(t.mode.summary().phase).toBe("error");
    await t.handlers["set-enabled"]({}, false);
  });

  it("records as before when only Teams (Ask) is on the call", async () => {
    const t = makeMode({ settings: { neverApps: ["Zoom"] } });
    t.micUsers = TEAMS;
    await inCall(t);
    const banner = windows.findLast((w) => w.page === "banner");
    const shown = renderBanner(banner.snap);
    expect(shown.apps).toBe("Microsoft Teams");
    expect(shown.warn).toBe("");
    await t.handlers.accept();
    expect(t.launches).toBe(1);
    expect(t.mode.summary().phase).toBe("recording");
    await t.handlers["set-enabled"]({}, false);
  });
});

describe("consent covers the apps that were on the call", () => {
  it("stops and saves the recording when another app joins, and doesn't ask again mid-call", async () => {
    const t = makeMode();
    t.micUsers = ZOOM;
    await inCall(t);
    await t.handlers.accept();
    expect(t.mode.summary().phase).toBe("recording");

    t.micUsers = TEAMS + ZOOM; // Teams joins: not what the user said yes to
    await until(() => t.child.kills.length > 0, 6000);
    expect(t.child.kills).toEqual(["SIGINT"]);
    expect(t.mode.summary().phase).toBe("transcribing");

    // The recorder finishes like at a normal call end: the call is saved.
    fs.writeFileSync(
      t.child.opts.output,
      Wav.encode([new Int16Array(1600), new Int16Array(1600)]),
    );
    t.child.opts.onMessage({ type: "saved" });
    t.child.opts.onExit(0);
    await until(() => t.mode.summary().phase === "saved");

    t.micUsers = TEAMS; // Zoom leaves: no restart, no new question until the call ends
    const polls = t.polls;
    await until(() => t.polls > polls + 1, 6000);
    expect(t.launches).toBe(1);
    expect(t.mode.summary().phase).not.toMatch(/asking|recording/);
    await t.handlers["set-enabled"]({}, false);
  }, 20000);

  it("stops at a gap with nobody on the mic and asks fresh when the same app starts another call within the grace", async () => {
    const t = makeMode();
    t.micUsers = ZOOM;
    await inCall(t);
    await t.handlers.accept();
    expect(t.mode.summary().phase).toBe("recording");

    t.micUsers = ""; // call A ends: one poll sees nobody (well inside the 8s grace)
    const polls = t.polls;
    await until(() => t.polls > polls);
    expect(t.child.kills).toEqual([]);
    t.micUsers = ZOOM; // call B on Zoom: no change for the detector
    await until(() => t.child.kills.length > 0, 6000);
    expect(t.child.kills).toEqual(["SIGINT"]);
    expect(t.mode.summary().phase).toBe("transcribing");

    // A is saved on its own; then B is asked about, not recorded.
    const a = t.child;
    fs.writeFileSync(
      a.opts.output,
      Wav.encode([new Int16Array(1600), new Int16Array(1600)]),
    );
    a.opts.onMessage({ type: "saved" });
    a.opts.onExit(0);
    await until(() => t.mode.summary().phase === "saved");
    await until(() => t.mode.summary().phase === "asking", 12000);
    expect(t.launches).toBe(1);
    await t.handlers["set-enabled"]({}, false);
  }, 30000);

  it("revokes the recording when any app is newly set to Never", async () => {
    const t = makeMode();
    t.micUsers = TEAMS;
    await inCall(t);
    await t.handlers.accept();
    expect(t.mode.summary().phase).toBe("recording");

    await t.handlers.settings({}, { neverApps: ["Zoom"] });
    expect(t.child.kills).toEqual(["SIGUSR1"]);
    expect(t.mode.summary().phase).toBe("transcribing");

    await t.handlers.settings({}, { neverApps: ["Zoom", "Microsoft Teams"] });
    expect(t.child.kills).toEqual(["SIGUSR1"]);
    expect(t.mode.summary().phase).toBe("transcribing");
    await t.handlers["set-enabled"]({}, false);
  });

  it("keeps recording when the detector reports the same apps in another order", async () => {
    const t = makeMode();
    t.micUsers = ZOOM + TEAMS;
    await inCall(t);
    await t.handlers.accept();
    t.micUsers = TEAMS + ZOOM;
    const polls = t.polls;
    await until(() => t.polls > polls + 1, 6000);
    expect(t.child.kills).toEqual([]);
    expect(t.mode.summary().phase).toBe("recording");
    await t.handlers["set-enabled"]({}, false);
  }, 20000);
});

describe("always-on retention after switching transcript folders", () => {
  it("still expires ambient text left in the previous folder, also after a relaunch, and keeps call transcripts", async () => {
    const a = mkdtemp("qpc-mode-a-");
    const b = mkdtemp("qpc-mode-b-");
    fs.mkdirSync(path.join(a, "ambient"));
    const old = path.join(a, "ambient", "2026-10-27-1100-always-on.md");
    const call = path.join(a, "2026-10-27-1000-zoom.md");
    fs.writeFileSync(old, "synthetic ambient text\n");
    fs.writeFileSync(call, "synthetic call transcript\n");

    const intervals = [];
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((fn, ms) => {
        intervals.push({ fn, ms });
        return 0;
      });
    const t = makeMode({ settings: { enabled: false, folder: a } });
    t.mode.start();
    spy.mockRestore();
    const retention = intervals.find((i) => i.ms === 60 * 1000).fn;

    pickedFolder = b;
    await t.handlers["choose-folder"]();
    expect(t.mode.summary().folder).toBe(b);
    const aged = new Date(Date.now() - 25 * 3600 * 1000);

    // Relaunch with B selected: A is remembered in settings and swept at startup.
    fs.utimesSync(old, aged, aged);
    const spy2 = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(() => 0);
    makeMode({ data: t.data }).mode.start();
    spy2.mockRestore();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(call)).toBe(true);

    // Same session: the periodic sweep covers A too.
    fs.writeFileSync(old, "synthetic ambient text\n");
    fs.utimesSync(old, aged, aged);
    retention();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(call)).toBe(true);
  });
});

describe("crash leftovers", () => {
  it("purges per-side audio and whisper output left in the private scratch folder at launch", () => {
    const data = mkdtemp("qpc-mode-data-");
    const scratch = path.join(data, "capture-scratch");
    fs.mkdirSync(scratch);
    const left = [
      "qpc-ambient-123-1700000000000-you.wav",
      "qpc-ambient-123-1700000000000-you.json",
      "qpc-123-1700000000000-them.wav",
    ].map((n) => path.join(scratch, n));
    for (const f of left) fs.writeFileSync(f, "synthetic");
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(() => 0);
    makeMode({ data, settings: { enabled: false } }).mode.start();
    spy.mockRestore();
    expect(left.filter((f) => fs.existsSync(f))).toEqual([]);
  });
});

const snapOf = (t) => t.handlers.snapshot();
const messageOf = (t) => snapOf(t).state.error;
const transcriptsOf = (t) => fs.readdirSync(t.folder).filter((f) => f.endsWith('.md'));
const sourceError = { type: 'error', code: 'source-check-failed', detail: 'read failed' };
function savedMic(t, discarded = true) {
  const tone = Int16Array.from({ length: 3200 }, (_, i) => Math.round(8000 * Math.sin(i * 0.17)));
  fs.writeFileSync(t.child.opts.output, Wav.encode([tone, discarded ? new Int16Array(tone.length) : tone]));
  t.child.opts.onMessage({ type: 'saved', themDiscarded: discarded });
}
/** Record clicked; the helper is spawned but hasn't sent started yet. */
async function acceptBeforeStarted(t) {
  const micro = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => {});
  try {
    await t.handlers.accept();
  } finally {
    micro.mockRestore();
  }
  expect(t.launches).toBe(1);
}
async function finish(t) {
  await t.child.opts.onExit(0);
  await t.handlers['set-enabled']({}, false);
}

describe('approved app capture contract', () => {
  it('approves only the bundle actually seen and supplies Never ids without call PIDs', async () => {
    const t = makeMode({ settings: { neverApps: ['Zoom'], seenIds: { Zoom: ['custom.zoom'] } } });
    t.micUsers = TEAMS;
    await inCall(t);
    await t.handlers.accept();
    expect(t.child.opts.approvedOnly).toBe(true);
    expect(t.child.opts.approveBundleIds).toEqual(['com.microsoft.teams2']);
    expect(t.child.opts.neverBundleIds).toEqual(expect.arrayContaining(['us.zoom.xos', 'custom.zoom']));
    expect(t.child.opts.excludePids).not.toContain(4343);
    expect(snapOf(t).settings.seenIds['Microsoft Teams']).toEqual(['com.microsoft.teams2']);
    await finish(t);
  });

  it('passes approved-only without promoting a bundle-less process PID', async () => {
    const t = makeMode();
    t.micUsers = '4242\t\n';
    await inCall(t);
    await t.handlers.accept();
    expect(t.child.opts.approvedOnly).toBe(true);
    expect(t.child.opts.approveBundleIds).toEqual([]);
    expect(t.child.opts.excludePids).not.toContain(4242);
    await finish(t);
  });

  it('rechecks Never after folder preparation (two-app call)', async () => {
    const t = makeMode();
    t.micUsers = TEAMS + ZOOM;
    await inCall(t);
    let release;
    let entered = false;
    const prepare = repo.prepareFolder;
    const spy = vi.spyOn(repo, 'prepareFolder').mockImplementation(async (...args) => {
      entered = true;
      await new Promise((r) => { release = r; });
      return prepare(...args);
    });
    try {
      const accepting = t.handlers.accept();
      await until(() => entered);
      await t.handlers.settings({}, { neverApps: ['Zoom'] });
      release();
      await accepting;
      expect(t.launches).toBe(0);
      copy.assertRenderedCopy("CR-396", messageOf(t), { apps: "Zoom" });
    } finally {
      spy.mockRestore();
      await t.handlers['set-enabled']({}, false);
    }
  });

  it('a pre-start source error saves nothing and says Not recorded', async () => {
    const t = makeMode();
    await inCall(t);
    await acceptBeforeStarted(t);
    t.child.opts.onMessage(sourceError);
    await t.child.opts.onExit(2);
    copy.assertRenderedCopy("CR-406", messageOf(t));
    expect(transcriptsOf(t)).toEqual([]);
    await t.handlers['set-enabled']({}, false);
  });

  describe('between spawn and the helper\'s started message', () => {
    it('leaves the banner: the recording is visible and stoppable, Not now does nothing', async () => {
      const t = makeMode();
      await inCall(t);
      await acceptBeforeStarted(t);
      expect(t.mode.summary().phase).toBe('recording');
      t.handlers.skip();
      expect(t.mode.summary().phase).toBe('recording');
      t.mode.menuItems().find((i) => i.label === 'Stop Recording').click();
      expect(t.child.kills).toEqual(['SIGINT']);
      await finish(t);
    });

    it('banner Never for <App> revokes the starting recording like Settings Never', async () => {
      const t = makeMode({ settings: { keepAudio: true } });
      await inCall(t);
      await acceptBeforeStarted(t);
      await t.handlers.never();
      expect(snapOf(t).settings.neverApps).toEqual(['Zoom']);
      expect(t.child.kills).toEqual(['SIGUSR1']);
      t.child.opts.onMessage({ type: 'started' });
      savedMic(t);
      await t.child.opts.onExit(0);
      copy.assertRenderedCopy("CR-404", messageOf(t), { app: "Zoom", savedResult: "Only the microphone transcript was saved." });
      expect(Wav.splitCall(fs.readFileSync(t.child.opts.output)).them.peak).toBe(0);
      await t.handlers['set-enabled']({}, false);
    });

    it('turning Capture off stops and saves the recording', async () => {
      const t = makeMode();
      await inCall(t);
      await acceptBeforeStarted(t);
      await t.handlers['set-enabled']({}, false);
      expect(t.child.kills).toEqual(['SIGINT']);
      expect(t.mode.summary().phase).toBe('transcribing');
      savedMic(t, false);
      await t.child.opts.onExit(0);
      expect(transcriptsOf(t)).toHaveLength(1);
    });
  });

  it('shows mic-only status and suppresses the silent-other-side warning', async () => {
    const t = makeMode();
    await inCall(t);
    await t.handlers.accept();
    t.child.opts.onMessage({ type: 'notice', code: 'mic-only' });
    expect(t.mode.menuItems().some((i) => i.label === 'Recording mic only · Zoom')).toBe(true);
    expect(snapOf(t).health.lastCallMicOnly).toBe('Zoom');
    // Run the production alert function (with the real escaping helper), not a
    // copied text template. Bootstrapping the full window isn't needed here.
    const ctx = { window: { qpc: { on() {}, snapshot: () => new Promise(() => {}) } }, document: { querySelectorAll: () => [] }, $: () => ({}), esc: (text) => text, inputSnap: snapOf(t) };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(new URL('../../../capture/renderer/main.js', import.meta.url), 'utf8'), ctx);
    const notices = vm.runInContext('snap = inputSnap; alerts()', ctx);
    // Still recording: present tense.
    expect(notices).toContainEqual({ kind: 'warn', text: 'Call audio isn’t available for Zoom. Recording your microphone only.' });
    expect(notices.some((notice) => notice.text.includes('No call audio was captured'))).toBe(false);
    savedMic(t);
    await t.child.opts.onExit(0);
    expect(snapOf(t).health.lastCallSilent).not.toContain('them');
    ctx.inputSnap = snapOf(t); // saved: what was recorded
    expect(vm.runInContext('snap = inputSnap; alerts()', ctx)).toContainEqual({ kind: 'warn', text: 'Call audio unavailable for Zoom. Only your microphone was recorded.' });
    await t.handlers['set-enabled']({}, false);
  });

  for (const order of ['error-first', 'saved-first']) {
    it(`${order}: saves only you and preserves the source error after transcription`, async () => {
      const t = makeMode();
      await inCall(t);
      await t.handlers.accept();
      if (order === 'error-first') t.child.opts.onMessage(sourceError);
      savedMic(t);
      if (order === 'saved-first') t.child.opts.onMessage(sourceError);
      // A manual Stop arriving too must not signal a second stop.
      t.handlers.stop();
      t.handlers.stop();
      expect(t.child.kills.length).toBeLessThanOrEqual(1);
      await t.child.opts.onExit(0);
      expect(t.transcriptions).toHaveLength(1);
      expect(t.transcriptions[0]).toMatch(/-you.wav$/);
      expect(transcriptsOf(t)).toHaveLength(1);
      copy.assertRenderedCopy("CR-405", messageOf(t), { savedResult: "The microphone transcript was saved." });
      await t.handlers['set-enabled']({}, false);
    });
  }

  for (const app of ['Zoom', 'Microsoft Teams']) {
    it(`revokes for ${app}, retaining only confirmed mic audio with Keep audio on`, async () => {
      const t = makeMode({ settings: { keepAudio: true } });
      t.micUsers = TEAMS;
      await inCall(t);
      await t.handlers.accept();
      await t.handlers.settings({}, { neverApps: [app] });
      await t.handlers.settings({}, { neverApps: [app] });
      expect(t.child.kills).toEqual(['SIGUSR1']);
      savedMic(t);
      await t.child.opts.onExit(0);
      expect(t.transcriptions).toHaveLength(1);
      expect(messageOf(t)).toBe(`Recording stopped because ${app} was set to Never. Only the microphone transcript was saved.`);
      expect(Wav.splitCall(fs.readFileSync(t.child.opts.output)).them.peak).toBe(0);
      await t.handlers['set-enabled']({}, false);
    });
  }

  for (const keepAudio of [true, false]) {
    it(`Stop then Never discards an unconfirmed mixed file unread (keepAudio=${keepAudio})`, async () => {
      const t = makeMode({ settings: { keepAudio } });
      await inCall(t);
      await t.handlers.accept();
      t.handlers.stop();
      await t.handlers.settings({}, { neverApps: ['Microsoft Teams'] });
      savedMic(t, false);
      const read = vi.spyOn(fs, 'readFileSync');
      await t.child.opts.onExit(0);
      expect(read.mock.calls.some(([p]) => p === t.child.opts.output)).toBe(false);
      read.mockRestore();
      expect(fs.existsSync(t.child.opts.output)).toBe(false);
      expect(t.transcriptions).toEqual([]);
      expect(transcriptsOf(t)).toEqual([]);
      expect(messageOf(t)).toBe('Recording stopped because Microsoft Teams was set to Never. No transcript was saved.');
      await t.handlers['set-enabled']({}, false);
    });
  }

  for (const revoked of [false, true]) {
    it(`started then ${revoked ? 'revocation' : 'source error'} then no saved is truthful`, async () => {
      const t = makeMode();
      await inCall(t);
      await t.handlers.accept();
      if (revoked) await t.handlers.settings({}, { neverApps: ['Zoom'] });
      else t.child.opts.onMessage(sourceError);
      await t.child.opts.onExit(2);
      expect(messageOf(t)).toMatch(/^Recording stopped because .*No transcript was saved\.$/);
      expect(messageOf(t)).not.toMatch(/microphone transcript was saved/);
      await t.handlers['set-enabled']({}, false);
    });
  }

  it('always-on has the original options and ignores Never edits', async () => {
    const t = makeMode();
    t.handlers['ambient-dialog']();
    const consent = windows.findLast((w) => w.page === 'ambient-consent');
    await t.handlers['ambient-confirm']({ sender: consent.webContents }, 'ALWAYS ON');
    expect(t.child.opts.approvedOnly).toBeUndefined();
    expect(t.child.opts.approveBundleIds).toBeUndefined();
    expect(t.child.opts.neverBundleIds).toBeUndefined();
    await t.handlers.settings({}, { neverApps: ['Zoom'] });
    expect(t.child.kills).toEqual([]);
    t.handlers['ambient-stop']();
    await finish(t);
  });
});


describe('folder preparation consent controls', () => {
  it('unchanged settings launches exactly once after preparation', async () => {
    const t = makeMode(); t.micUsers = TEAMS + ZOOM;
    await inCall(t); await t.handlers.accept();
    expect(t.launches).toBe(1); await finish(t);
  });
  it('all apps Never never launches', async () => {
    const t = makeMode({ settings: { neverApps: ['Zoom', 'Microsoft Teams'] } });
    t.micUsers = TEAMS + ZOOM;
    await t.handlers.settings({}, {});
    await until(() => t.polls > 0);
    await t.handlers.accept();
    expect(t.launches).toBe(0);
    await t.handlers['set-enabled']({}, false);
  });
  it('banner-wide Never while preparation is pending cancels the launch', async () => {
    const t = makeMode(); t.micUsers = TEAMS + ZOOM;
    await inCall(t);
    const prepare = repo.prepareFolder;
    let release; let entered = false;
    const spy = vi.spyOn(repo, 'prepareFolder').mockImplementation(async (...args) => {
      entered = true; await new Promise((r) => { release = r; }); return prepare(...args);
    });
    try {
      const accepting = t.handlers.accept();
      await until(() => entered);
      await t.handlers.never(); release(); await accepting;
      expect(t.launches).toBe(0);
    } finally { spy.mockRestore(); await t.handlers['set-enabled']({}, false); }
  });
});
