import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import speakers from "../../../capture/lib/speakers.js";
import T from "../../../capture/lib/transcript.js";
import A from "../../../capture/lib/ambient.js";
import S from "../../../capture/lib/state.js";
import P from "../../../capture/lib/pipeline.js";
import W from "../../../capture/lib/wav.js";

// Temp dirs (repos, synthetic test audio) are removed after this file's tests.
const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(prefix);
  made.push(d);
  return d;
};
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

it("keeps channel attribution while labeling far-side voices; rename merges labels", () => {
  const lines = speakers.assignSpeakers([
    { at: 0, who: "you", cluster: 8, text: "Hi." },
    { at: 1, who: "them", cluster: 2, text: "Alice here." },
    { at: 2, who: "them", cluster: 7, text: "Bob here." },
    { at: 3, who: "them", cluster: 2, text: "Thanks." },
    { at: 4, who: "you", cluster: 8, text: "Bye." },
    { at: 5, who: "you", cluster: 9, text: "Room voice." },
  ]);
  expect(lines.map((l) => l.speaker)).toEqual([
    undefined,
    "Speaker 1",
    "Speaker 2",
    "Speaker 1",
    undefined,
    "In room 1",
  ]);
  const md = T.toMarkdown({
    start: new Date(),
    end: new Date(),
    apps: ["Zoom"],
    lines,
    model: "base.en",
    audioKept: false,
  });
  const renamed = speakers.renameSpeaker(md, "Speaker 1", "Alice");
  expect(renamed).toContain("[00:00:01] [them] (Alice) Alice here.");
  expect(T.parseMarkdown(renamed).lines[1]).toMatchObject({
    who: "them",
    speaker: "Alice",
    text: "Alice here.",
  });
  const merged = speakers.renameSpeaker(renamed, "Speaker 2", "Alice");
  expect(T.parseMarkdown(merged).meta.speakers).toEqual(["Alice", "In room 1"]);
  expect(() => speakers.renameSpeaker(md, "Speaker 1", "()")).toThrow(/empty/);
});

it("doesn't mistake a parenthetical speech prefix for a speaker name", () => {
  const md = T.toMarkdown({
    start: new Date(),
    end: new Date(),
    apps: [],
    lines: [{ at: 0, who: "you", text: "(laughs) Hi there." }],
    model: "base.en",
    audioKept: false,
  });
  expect(T.parseMarkdown(md).lines[0]).toEqual({
    at: "00:00:00",
    who: "you",
    text: "(laughs) Hi there.",
  });
});

describe("always-on mode", () => {
  it("requires its own activation; call detection and saved chunks don't turn it off", () => {
    const cfg = { enabled: false, neverApps: [] };
    let s = S.initialState(cfg);
    expect(s.phase).toBe("off");
    s = S.next(s, { type: "ambient-on", at: 10 }, cfg);
    for (const event of [
      { type: "call", apps: [] },
      { type: "settings" },
      { type: "saved", file: "ambient/x.md" },
    ])
      s = S.next(s, event, cfg);
    expect(s.phase).toBe("ambient");
    expect(s.file).toBe("ambient/x.md");
    expect(S.next(s, { type: "ambient-off" }, cfg).phase).toBe("off");
  });

  it("saves an ambient chunk without git history, deletes audio, and expires the text", async () => {
    const root = mkdtemp(path.join(os.tmpdir(), "qpc-ambient-"));
    const folder = path.join(root, "repo");
    fs.mkdirSync(folder);
    const wavPath = path.join(root, "chunk.wav");
    fs.writeFileSync(
      wavPath,
      W.encode([new Int16Array(1600).fill(6000), new Int16Array(1600)]),
    );
    const settings = A.chunkSettings({ folder, keepAudio: true, keepDays: 7 });
    expect(settings.keepAudio).toBe(false);
    const result = await P.finishCall({
      wavPath,
      start: new Date(2026, 9, 27, 11),
      end: new Date(2026, 9, 27, 11, 10),
      apps: [],
      settings,
      model: "base.en",
      ambient: true,
      transcribeSide: async () => ({
        transcription: [
          { offsets: { from: 0, to: 100 }, text: "Notes to myself." },
        ],
      }),
      diarizeSide: async (_wav, segs) => segs.map(() => 0),
    });
    expect(result.sha).toBe(null);
    expect(result.name).toBe("ambient/2026-10-27-1100-always-on.md");
    expect(fs.existsSync(wavPath)).toBe(false);
    expect(fs.readFileSync(result.file, "utf8")).toContain(
      'title: "Always-on"',
    );
    expect(
      execFileSync("git", ["-C", folder, "status", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe("");
    expect(() =>
      execFileSync("git", ["-C", folder, "rev-parse", "--verify", "HEAD"], {
        stdio: "ignore",
      }),
    ).toThrow();
    const now = Date.now();
    fs.utimesSync(
      result.file,
      new Date(now - 25 * 3600000),
      new Date(now - 25 * 3600000),
    );
    expect(A.sweepAmbient(folder, 24, now)).toEqual([result.file]);
    expect(fs.existsSync(result.file)).toBe(false);
  });

  it("expires only its own always-on files; a user's file in ambient/ is never deleted", () => {
    const folder = mkdtemp(path.join(os.tmpdir(), "qpc-ambient-own-"));
    const d = path.join(folder, "ambient");
    fs.mkdirSync(d);
    const own = [
      "2026-10-27-1100-always-on.md",
      "2026-10-27-1100-always-on-2.md",
    ];
    const foreign = [
      "personal.md",
      "2026-10-27-1100-zoom.md",
      "always-on.md",
      "notes.txt",
    ];
    const now = Date.now();
    const aged = new Date(now - 25 * 3600000);
    for (const n of [...own, ...foreign]) {
      fs.writeFileSync(path.join(d, n), "synthetic\n");
      fs.utimesSync(path.join(d, n), aged, aged);
    }
    expect(A.sweepAmbient(folder, 24, now).sort()).toEqual(
      own.map((n) => path.join(d, n)).sort(),
    );
    expect(fs.readdirSync(d).sort()).toEqual([...foreign].sort());
  });
});
