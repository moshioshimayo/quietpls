import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

// Loads the real createCaptureMode with Electron mocked (tests/unit/setup.js) and the
// recorder, mic check, whisper and mic-users helper replaced: no microphone or system
// audio is ever opened. Synthetic files only, removed afterwards.
const require = createRequire(import.meta.url);
const electron = require("electron");

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};
afterAll(() =>
  made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
);

class FakeWindow {
  constructor() {
    this.visible = false;
    this.webContents = {
      send() {},
      on() {},
      once() {},
      isLoading: () => false,
    };
  }
  loadFile() {}
  on() {}
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
      startCapture: () => {
        t.launches++;
        return { pid: undefined, kill() {} };
      },
      transcribe: async () => ({ transcription: [] }),
      findWhisper: () => "/usr/bin/true",
      checkMic: () => {
        if (!t.gate) return Promise.resolve("granted");
        const p = new Promise((r) => (t.release = () => r("granted")));
        t.gate = null;
        return p;
      },
      detectorExecFile: (_bin, _args, _opts, cb) => cb(null, t.micUsers),
    },
  });
  t.mode = mode;
  t.handlers = handlers;
  return t;
}

async function inCall(t) {
  await t.handlers.settings({}, {}); // starts call detection
  await until(() => t.mode.summary().phase === "asking");
}

describe("consent race while the mic check is pending", () => {
  it("doesn't start the recorder when capture is turned off after Record was clicked", async () => {
    const t = makeMode();
    await inCall(t);
    t.gate = true;
    const accepting = t.handlers.accept();
    await tick();
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
    await tick();
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
    await tick();
    t.release();
    await Promise.all([a, b]);
    expect(t.launches).toBe(1);
    expect(t.mode.summary().phase).toBe("recording");
    await t.handlers["set-enabled"]({}, false);
  });
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
