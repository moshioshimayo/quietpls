// T4 Capture copy: render the real Capture renderers (banner, recording pill, Capture
// window) and lib messages with synthetic fixtures, then check each CR row's text
// against tests/copy-expectations.json and the §9.2 banned list. No DOM library:
// the renderers run in a vm with a small element stub, like tests/unit/capture/mode.test.js.
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import { execFileSync } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const h = require("./copy-helpers.js");
const W = require("../../capture/lib/whisper.js");
const T = require("../../capture/lib/transcript.js");
const repo = require("../../capture/lib/repo.js");
const speakers = require("../../capture/lib/speakers.js");

const ROOT = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const text = (html) => h.normalize(String(html).replace(/<[^>]*>/g, " "));
const authored = []; // every visible message rendered below, for the banned-word check
const seen = (...messages) => (authored.push(...messages), messages[0]);

/** Assert a row (or one of its variants) against real rendered text that also carries other copy. */
function contains(id, html, values = {}, variant) {
  const row = h.loadExpectations().find((r) => r.id === id);
  const template = variant == null ? row.expected ?? row.template : row.variants[variant];
  expect(text(html)).toContain(h.normalize(h.renderExpected({ id, template }, values)));
}

const HOME = "/Users/sam";
const FOLDER = `${HOME}/Documents/Call notes`;
function snap({ state = {}, settings = {}, health = {} } = {}) {
  return {
    state: { phase: "idle", apps: [], file: null, error: null, ...state },
    settings: { enabled: true, folder: FOLDER, keepAudio: false, keepDays: 7, neverApps: [], seenApps: ["Zoom", "Google Meet", "FaceTime"], model: "base.en", speakerLabels: false, ...settings },
    health: { whisper: "/opt/homebrew/bin/whisper-cli", modelReady: true, mic: "granted", folder: { ok: true, reason: null, remotes: [] }, download: null, lastCallSilent: [], lastCallMicOnly: null, speakerModelReady: true, uv: "/opt/homebrew/bin/uv", ...health },
    home: HOME,
    models: W.MODELS.map((m) => ({ ...m, ready: m.id === "base.en" })),
    elapsed: 724,
  };
}

/** Load common.js + a renderer into a vm with element stubs keyed by selector. */
function load(script, qpc = {}) {
  const els = {};
  const el = () => ({ style: {}, hidden: false, innerHTML: "", textContent: "", title: "", offsetHeight: 200, querySelectorAll: () => [], querySelector: () => el(), setAttribute() {}, append() {}, after() {} });
  let onSnapshot = null;
  const ctx = {
    document: { querySelector: (sel) => (els[sel] ||= el()), querySelectorAll: () => [], createElement: el },
    window: { qpc: { on: (n, fn) => n === "snapshot" && (onSnapshot = fn), snapshot: () => new Promise(() => {}), fit() {}, ...qpc } },
    requestAnimationFrame() {},
  };
  vm.createContext(ctx);
  for (const f of ["common.js", script]) vm.runInContext(read(`capture/renderer/${f}`), ctx);
  return { els, ctx, show: (s) => onSnapshot(s), run: (code) => vm.runInContext(code, ctx) };
}

describe("call banner (CAPB)", () => {
  const banner = (s) => {
    const b = load("banner.js");
    b.show(s);
    return { title: `Record a call in ${b.els["#app"].textContent}?`, never: `Never for ${b.els["#app2"].textContent}`, where: b.els["#where"].textContent, audio: b.els["#audio"].textContent, warn: b.els["#warn"].hidden ? "" : b.els["#warn"].textContent, accept: b.els["#accept"].textContent, facts: !b.els["#facts"].hidden };
  };

  it("asks about one call with the real destination and retention", () => {
    const b = banner(snap({ state: { phase: "asking", apps: ["Zoom"] } }));
    h.assertRenderedCopy("CR-234", seen(b.title), { app: "Zoom" });
    h.assertRenderedCopy("CR-243", seen(b.never), { app: "Zoom" });
    h.assertRenderedCopy("CR-251", seen(b.where), { folder: "~/Documents/Call notes" });
    h.assertRenderedCopy("CR-240", seen(b.audio));
    h.assertRenderedCopy("CR-241", seen(b.accept));
    expect(b.facts).toBe(true);
    // AC-K6 rows reflect settings: kept audio and no folder yet.
    const kept = banner(snap({ state: { phase: "asking", apps: ["Zoom"] }, settings: { keepAudio: true, keepDays: 7 } }));
    h.assertRenderedCopy("CR-253", seen(kept.audio), { days: 7 });
    const oneDay = banner(snap({ state: { phase: "asking", apps: ["Zoom"] }, settings: { keepAudio: true, keepDays: 1 } }));
    h.assertRenderedCopy("CR-253", oneDay.audio, {}, [{ id: "CR-253", expected: "Kept for 1 day, then deleted" }]);
    const noFolder = banner(snap({ state: { phase: "asking", apps: ["Zoom"] }, settings: { folder: null }, health: { folder: { ok: false, reason: "not-chosen", remotes: [] } } }));
    h.assertRenderedCopy("CR-252", seen(noFolder.where));
  });

  it("blocked calls show one line of cause and Open settings", () => {
    const one = banner(snap({ state: { phase: "asking", apps: ["Zoom"] }, settings: { neverApps: ["Zoom"] } }));
    h.assertRenderedCopy("CR-245", seen(one.warn), { apps: "Zoom" }, [{ id: "CR-245", template: "Recording blocked. {apps} is set to Never." }]);
    h.assertRenderedCopy("CR-254", seen(one.accept));
    expect(one.facts).toBe(false);
    const two = banner(snap({ state: { phase: "asking", apps: ["Zoom", "Microsoft Teams"] }, settings: { neverApps: ["Zoom", "Microsoft Teams"] } }));
    h.assertRenderedCopy("CR-245", seen(two.warn), { apps: "Zoom and Microsoft Teams" }, [{ id: "CR-245", template: "Recording blocked. {apps} are set to Never." }]);
    h.assertRenderedCopy("CR-244", two.never.replace("Never for ", ""));
    const cases = [
      ["CR-246", { folder: { ok: false, reason: "has-remote", remotes: [{ name: "origin" }] } }],
      ["CR-247", { folder: { ok: false, reason: "not-chosen", remotes: [] } }],
      ["CR-248", { whisper: null }],
      ["CR-249", { modelReady: false }],
      ["CR-250", { mic: "denied" }],
    ];
    for (const [id, health] of cases)
      h.assertRenderedCopy(id, seen(banner(snap({ state: { phase: "asking", apps: ["Zoom"] }, health })).warn));
  });

  it("keeps the privacy line and the Never action on its own line", () => {
    const html = read("capture/renderer/banner.html");
    expect(text(html)).toContain(seen("Only you see this prompt; quietpls doesn’t notify the other people on the call."));
    expect(read("capture/renderer/banner.css")).toMatch(/#never \{[^}]*flex-basis: 100%[^}]*text-overflow: ellipsis/);
  });
});

describe("recording pill (CAPB)", () => {
  const pill = (phase, extra = {}) => {
    const p = load("indicator.js");
    p.show({ ...snap({ state: { phase, ...extra } }), elapsed: extra.elapsed ?? 724 });
    const shown = (sel) => !p.els[sel].hidden;
    return { label: p.els["#label"].textContent, detail: shown("#detail") ? p.els["#detail"].textContent : "", open: shown("#open") ? p.els["#open"].textContent : "", stop: shown("#stop") };
  };
  it("shows each phase in words with its action", () => {
    const rec = pill("recording");
    expect(seen(rec.label)).toBe("Recording 12:04"); // AC-K8
    expect(rec.stop).toBe(true);
    const tx = pill("transcribing");
    h.assertRenderedCopy("CR-262", seen(tx.label), {}, [{ id: "CR-262", expected: "Transcribing…" }]);
    h.assertRenderedCopy("CR-263", seen(tx.detail));
    const saved = pill("saved", { file: "2026-11-24-0904-zoom.md" });
    h.assertRenderedCopy("CR-265", seen(saved.label));
    expect(seen(saved.open)).toBe("View");
    const bad = pill("error", { error: "Recording stopped unexpectedly. No transcript was saved. Details: exit 3." });
    h.assertRenderedCopy("CR-266", seen(bad.label));
    h.assertRenderedCopy("CR-407", bad.detail, { code: 3 });
    h.assertRenderedCopy("CR-259", bad.open);
    const amb = pill("ambient", { elapsed: 0 });
    h.assertRenderedCopy("CR-260", seen(amb.label));
    h.assertRenderedCopy("CR-261", seen(amb.detail));
  });
});

describe("Capture window (CAPS)", () => {
  it("the Always-on card follows the live phase, so its button does what it says", () => {
    const calls = [];
    const m = load("main.js", { ambientStop: () => calls.push("stop"), ambientDialog: () => calls.push("dialog") });
    m.run(`tab = "settings"; snap = ${JSON.stringify(snap())}; render()`);
    expect(text(m.els["#settings"].innerHTML)).toContain("Set up always-on…");
    // Always-on starts: nothing else in Settings changed.
    m.run(`snap = ${JSON.stringify(snap({ state: { phase: "ambient" } }))}; render()`);
    expect(text(m.els["#settings"].innerHTML)).toContain("Stop always-on recording");
    m.els["#ambient"].onclick();
    expect(calls).toEqual(["stop"]);
  });

  it("status line names the phase", () => {
    for (const [phase, id, values] of [
      ["off", "CR-268", null], ["idle", "CR-269", null], ["detected", "CR-270", null],
      ["transcribing", "CR-273", null], ["saved", "CR-274", null], ["error", "CR-275", null], ["ambient", "CR-276", null],
    ]) {
      const m = load("main.js");
      m.run(`snap = ${JSON.stringify(snap({ state: { phase } }))}; renderStatus()`);
      const words = m.els["#status-text"].textContent;
      h.assertRenderedCopy(id, seen(words), values || {}, [{ id, expected: h.textVariants(h.loadExpectations().find((r) => r.id === id))[0] }]);
    }
    // Idle but not set up (transcription data missing): never "Waiting for a call".
    const unready = load("main.js");
    unready.run(`snap = ${JSON.stringify(snap({ health: { modelReady: false } }))}; renderStatus()`);
    contains("CR-316", unready.els["#status-text"].textContent, {}, 1);
    const m = load("main.js");
    m.run(`snap = ${JSON.stringify(snap({ state: { phase: "recording", apps: ["Zoom"] } }))}; renderStatus()`);
    h.assertRenderedCopy("CR-272", seen(m.els["#status-text"].textContent), { time: "12:04", apps: "Zoom" });
    expect(m.els["#status-action"].textContent).toBe("Stop");
    const off = load("main.js");
    off.run(`snap = ${JSON.stringify(snap({ state: { phase: "off" } }))}; renderStatus()`);
    expect(seen(off.els["#status-action"].textContent)).toBe("Turn on");
  });

  it("alerts say what is wrong and what to do", () => {
    const m = load("main.js");
    const alerts = (s) => m.run(`snap = ${JSON.stringify(s)}; alerts()`);
    const remote = alerts(snap({ health: { folder: { ok: false, reason: "has-remote", remotes: [{ name: "origin", url: "git@example.com:sam/notes.git" }] } } }));
    h.assertRenderedCopy("CR-293", seen(remote[0].text), { folder: "~/Documents/Call notes", remotes: "origin → git@example.com:sam/notes.git" });
    const missing = alerts(snap({ health: { folder: { ok: false, reason: "missing", remotes: [] } } }));
    h.assertRenderedCopy("CR-295", seen(missing[0].text), { folder: "~/Documents/Call notes" });
    h.assertRenderedCopy("CR-296", seen(alerts(snap({ health: { mic: "denied" } }))[0].text));
    h.assertRenderedCopy("CR-298", seen(alerts(snap({ health: { whisper: null } }))[0].text));
    h.assertRenderedCopy("CR-300", seen(alerts(snap({ health: { lastCallMicOnly: "FaceTime" } }))[0].text), { app: "FaceTime" });
    // While that call is still recording, the same alert speaks in the present.
    contains("CR-300", alerts({ ...snap({ health: { lastCallMicOnly: "FaceTime" }, state: { phase: "recording", apps: ["FaceTime"] } }), micOnly: true })[0].text, { app: "FaceTime" }, 1);
    h.assertRenderedCopy("CR-301", seen(alerts(snap({ health: { lastCallSilent: ["them"] } }))[0].text));
    const failed = alerts(snap({ state: { phase: "error", error: "No mic found. Connect or select a mic, then try again." } }));
    h.assertRenderedCopy("CR-402", failed[0].text);
    expect(failed[0].actions.map(([label]) => label)).toEqual(["Dismiss"]);
    // System audio can't start: the alert opens its System Settings pane as well.
    const audio = alerts(snap({ state: { phase: "error", error: "System audio is unavailable. Check Screen & System Audio Recording in System Settings, then try again." } }));
    expect(audio[0].actions.map(([label]) => label)).toEqual(["Open System Settings", "Dismiss"]);
    expect(m.run("alerts")).toBeTypeOf("function");
    // A remote URL or folder name is never interpreted as markup.
    const markup = alerts(snap({ health: { folder: { ok: false, reason: "missing", remotes: [] } }, settings: { folder: `${HOME}/<b>notes</b>` } }));
    expect(markup[0].text).toBe("Transcript folder not found: ~/<b>notes</b>");
  });

  it("transcript list, empty states and reader", async () => {
    const m = load("main.js", { transcripts: async () => [], transcript: async () => ({ meta: { title: "Weekly product sync", start: "2026-11-24T09:04:00Z", duration: "00:24:10", apps: ["Zoom"], audio: "deleted" }, notes: [], lines: [{ at: "00:00:01", who: "them", speaker: "Speaker 1", text: "Morning." }, { at: "00:00:03", who: "you", text: "Hi." }, { at: "00:00:05", who: "them", text: "Shall we start?" }] }) });
    m.run(`snap = ${JSON.stringify(snap())}; calls = []; renderCalls()`);
    h.assertRenderedCopy("CR-304", seen(text(m.els["#rows"].innerHTML)));
    contains("CR-305", seen(m.els["#reader"].innerHTML));
    contains("CR-306", m.els["#reader"].innerHTML);
    m.run(`snap = ${JSON.stringify(snap({ settings: { enabled: false } }))}; calls = [{ name: "a.md", text: "morning", preview: "", meta: { title: "Weekly product sync" } }]; selected = "a.md"; reading = "a.md"; query = "zebra"; renderCalls()`);
    h.assertRenderedCopy("CR-303", seen(text(m.els["#rows"].innerHTML)), { query: "zebra" });
    m.run(`query = ""; renderCalls()`);
    contains("CR-302", m.els["#rows"].innerHTML);
    await m.run(`select("a.md")`);
    const reader = m.els["#reader"].innerHTML;
    contains("CR-309", seen(reader), { retention: "deleted" });
    expect(reader).toContain('title="Rename speaker · Call audio"');
    h.assertRenderedCopy("CR-313", "Rename speaker · Call audio", { channel: "Call audio" });
    expect(text(reader)).toContain("You");
    expect(text(reader)).toContain("Call audio");
    // AC-I7: the rename failure is readable beside the field.
    const why = m.run(`renameError(new Error("Error invoking remote method 'capture:speaker-rename': Error: Enter a speaker name"))`);
    h.assertRenderedCopy("CR-315", seen(why), { "specific detail": "Enter a speaker name" });
    expect(read("capture/renderer/main.js")).toMatch(/why\.textContent = renameError\(err\)/);
  });

  it("setup checklist leads with the next missing step and offers Copy for the Terminal command", () => {
    const m = load("main.js");
    const setup = (s) => m.run(`snap = ${JSON.stringify(s)}; setupHtml()`);
    const first = setup(snap({ settings: { enabled: false, folder: null }, health: { whisper: null, modelReady: false, folder: { ok: false, reason: "not-chosen", remotes: [] } } }));
    contains("CR-316", seen(first), {}, 1);
    contains("CR-317", first);
    expect(text(first).indexOf("Install speech-to-text")).toBeLessThan(text(first).indexOf("Turn on call prompts"));
    expect(first).toMatch(/<span class="cmd">brew install whisper-cpp<\/span> <button class="sm" data-copy="brew install whisper-cpp">Copy<\/button>/);
    contains("CR-320", first, { size: "142 MB" });
    contains("CR-323", first);
    contains("CR-328", first);
    contains("CR-332", first);
    contains("CR-334", first);
    // Folder done, speech-to-text missing: the missing step comes first.
    const mixed = setup(snap({ settings: { enabled: false }, health: { whisper: null } }));
    expect(text(mixed).indexOf("Install speech-to-text")).toBeLessThan(text(mixed).indexOf("Choose a transcript folder"));
    contains("CR-326", seen(mixed), { folder: "~/Documents/Call notes" });
    contains("CR-321", mixed, { model: "base.en" });
    const ready = setup(snap());
    contains("CR-316", seen(ready), {}, 0);
    contains("CR-319", ready, { path: "/opt/homebrew/bin/whisper-cli" });
    contains("CR-331", ready);
    const failed = setup(snap({ health: { modelReady: false, download: { id: "base.en", error: "Details: HTTP 503." } } }));
    contains("CR-322", failed, { "diagnostic detail": "Details: HTTP 503." });
    contains("CR-327", setup(snap({ health: { folder: { ok: false, reason: "has-remote", remotes: [{ name: "origin" }] } } })));
  });

  it("settings groups use the reviewed words", () => {
    const m = load("main.js");
    const settings = (s) => (m.run(`snap = ${JSON.stringify(s)}; renderSettings()`), m.els["#settings"].innerHTML);
    const on = settings(snap());
    for (const id of ["CR-339", "CR-340", "CR-341", "CR-343", "CR-345", "CR-346", "CR-347", "CR-348", "CR-349", "CR-351", "CR-353", "CR-355", "CR-356", "CR-357", "CR-359", "CR-363", "CR-364", "CR-365", "CR-367", "CR-368", "CR-371", "CR-372", "CR-374", "CR-377", "CR-378", "CR-336"]) contains(id, seen(on));
    contains("CR-361", on, { path: "/opt/homebrew/bin/whisper-cli" });
    contains("CR-358", on, { label: "Fast · English", id: "base.en", size: "142 MB" });
    contains("CR-366", on.replace(/<input type="number"[^>]*>/, "7"), { days: 7 });
    const off = settings(snap({ settings: { enabled: false, folder: null, seenApps: [] }, health: { mic: "unknown", uv: null, whisper: null, speakerModelReady: false, speakerError: "uv exited 1", download: { id: "small.en", error: "Details: HTTP 503." } } }));
    for (const id of ["CR-342", "CR-350", "CR-352", "CR-362", "CR-370", "CR-376", "CR-335"]) contains(id, seen(off));
    contains("CR-354", off, { "specific detail": "uv exited 1" });
    contains("CR-360", off, { "diagnostic detail": "Details: HTTP 503." });
    const remote = settings(snap({ health: { mic: "denied", folder: { ok: false, reason: "has-remote", remotes: [{ name: "origin" }] } } }));
    contains("CR-337", seen(remote), { names: "origin" });
    contains("CR-375", remote);
    contains("CR-338", settings(snap({ health: { folder: { ok: false, reason: "missing", remotes: [] } } })));
    contains("CR-344", settings(snap({ state: { phase: "ambient" } })));
  });

  it("window chrome and always-on consent", () => {
    for (const id of ["CR-229", "CR-230", "CR-231", "CR-232", "CR-233"]) contains(id, seen(read("capture/renderer/main.html").replace(/placeholder="([^"]*)"/, ">$1<")));
    const consent = read("capture/renderer/ambient-consent.html");
    for (let n = 383; n <= 395; n++) contains(`CR-${n}`, seen(consent));
    expect(read("capture/renderer/ambient-consent.js")).toContain('input.value !== "ALWAYS ON"');
  });
});

describe("Capture lib messages (CAPE)", () => {
  const made = [];
  afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it("names apps, labels and model choices plainly", () => {
    h.assertRenderedCopy("CR-422", T.callTitle(["Zoom"]), { apps: "Zoom" }, [{ id: "CR-422", template: "{apps} call" }]);
    h.assertRenderedCopy("CR-422", T.callTitle([]), {}, [{ id: "CR-422", expected: "Call" }]);
    expect(W.MODELS.map((m) => m.label)).toEqual(["Fastest · English", "Fast · English", "Larger · English", "Multilingual"]);
    h.assertRenderedCopy("CR-427", load("banner.js").run("appList([])"));
    // AC-K4: an unknown app is "an app" in the headline; its raw name only in the Never link.
    const b = load("banner.js");
    b.show(snap({ state: { phase: "asking", apps: ["com.example.callr"] } }));
    h.assertRenderedCopy("CR-234", `Record a call in ${b.els["#app"].textContent}?`, { app: "an app" });
    expect(b.els["#app2"].textContent).toBe("com.example.callr");
    expect(b.run('appList(["process 4242", "Zoom"])')).toBe("an app + Zoom");
    expect(() => speakers.renameSpeaker("[00:00:01] [them] (Speaker 1) hi", "Speaker 1", " ")).toThrow("Enter a speaker name");
  });

  it("explains folder and download failures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-copy-t4-"));
    made.push(dir);
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.com/notes.git"]);
    const err = await repo.saveTranscript(dir, "a.md", "# a\n", "add").catch((e) => e);
    h.assertRenderedCopy("CR-419", err.message, { names: "origin" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
      const e = await W.downloadModel(dir, "base.en").catch((x) => x);
      h.assertRenderedCopy("CR-413", e.message, { status: 404 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("T4 banned vocabulary (§9.2)", () => {
  it("is absent from every authored message rendered above", () => {
    expect(authored.length).toBeGreaterThan(80);
    expect(h.bannedCopyViolations(authored.map(text))).toEqual([]);
  });
});
