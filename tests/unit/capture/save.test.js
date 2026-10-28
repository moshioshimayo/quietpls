import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import W from "../../../capture/lib/wav.js";
import repo from "../../../capture/lib/repo.js";
import policy from "../../../capture/lib/audio-policy.js";
import P from "../../../capture/lib/pipeline.js";

// Temp dirs (repos, synthetic test audio) are removed after this file's tests.
const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(prefix);
  made.push(d);
  return d;
};
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
let dir, audio;

beforeEach(() => {
  dir = mkdtemp(path.join(os.tmpdir(), "qpc-test-repo-"));
  audio = mkdtemp(path.join(os.tmpdir(), "qpc-test-audio-"));
});

function recording(youLoud = true, themLoud = true) {
  const tone = (on, amp) =>
    Int16Array.from({ length: 16000 }, (_, i) =>
      on ? Math.round(Math.sin(i / 5) * amp) : 0,
    );
  const file = path.join(audio, "call.wav");
  fs.writeFileSync(
    file,
    W.encode([tone(youLoud, 12000), tone(themLoud, 6000)]),
  );
  return file;
}

const fakeWhisper = (wavPath) => {
  // Proves which channel reached which side: the mono file's loudness.
  const peak = W.decode(fs.readFileSync(wavPath)).channels[0].reduce(
    (m, s) => Math.max(m, Math.abs(s)),
    0,
  );
  return Promise.resolve({
    transcription: [
      {
        offsets: { from: 1000 },
        text: peak > 9000 ? " Loud left channel." : " Quieter right side.",
      },
    ],
  });
};

const call = (settings, wavPath) =>
  P.finishCall({
    wavPath,
    start: new Date(2026, 9, 27, 10, 0, 0),
    end: new Date(2026, 9, 27, 10, 1, 0),
    apps: ["Zoom"],
    settings: { keepAudio: false, keepDays: 7, folder: dir, ...settings },
    model: "base.en",
    transcribeSide: fakeWhisper,
  });

describe("saving a call", () => {
  it("preserves two calls made in the same minute", async () => {
    const a = await call({}, recording());
    const first = fs.readFileSync(a.file, "utf8");
    const b = await call({}, recording());
    expect(b.file).not.toBe(a.file);
    expect(b.name).toBe("2026-10-27-1000-zoom-2.md");
    expect(fs.readFileSync(a.file, "utf8")).toBe(first);
    expect(git(dir, "ls-files").trim().split("\n")).toHaveLength(2);
  });
  it("git-inits the folder, commits exactly one markdown file, and deletes the audio by default", async () => {
    const wav = recording();
    const r = await call({}, wav);
    expect(fs.existsSync(wav)).toBe(false);
    expect(r.audioDeleted).toBe(true);
    expect(git(dir, "log", "--oneline")).toMatch(
      /Zoom call, 2026-10-27 10:00 \(1 min\)/,
    );
    expect(git(dir, "show", "--name-only", "--format=", "HEAD").trim()).toBe(
      "2026-10-27-1000-zoom.md",
    );
    expect(git(dir, "status", "--porcelain")).toBe("");
    // left (loud) → you, right (quiet) → them
    expect(fs.readFileSync(r.file, "utf8")).toContain(
      "[00:00:01] [you] Loud left channel.\n[00:00:01] [them] Quieter right side.\n",
    );
  });

  it("keeps the audio when the user chose to keep it", async () => {
    const wav = recording();
    const r = await call({ keepAudio: true, keepDays: 3 }, wav);
    expect(fs.existsSync(wav)).toBe(true);
    expect(fs.readFileSync(r.file, "utf8")).toMatch(/^audio: kept$/m);
  });

  it("doesn't transcribe a silent side (whisper invents words on silence)", async () => {
    const r = await call({}, recording(true, false));
    expect(r.silent).toEqual(["them"]);
    expect(r.lines.map((l) => l.who)).toEqual(["you"]);
  });
});

describe("remote refusal", () => {
  it("refuses a repo with a remote and writes nothing to it", async () => {
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://example.com/notes.git");
    expect(await repo.checkFolder(dir)).toMatchObject({
      ok: false,
      reason: "has-remote",
      remotes: [{ name: "origin", url: "https://example.com/notes.git" }],
    });
    const wav = recording();
    await expect(call({}, wav)).rejects.toMatchObject({ code: "has-remote" });
    expect(fs.readdirSync(dir).filter((n) => n !== ".git")).toEqual([]);
    expect(fs.existsSync(wav)).toBe(true); // audio kept so the call isn't lost
  });

  it("refuses when no folder is chosen", async () => {
    expect(await repo.checkFolder(null)).toMatchObject({
      ok: false,
      reason: "not-chosen",
    });
  });
});

describe("audio retention", () => {
  const DAY = 86400000;
  const files = [
    { path: "new.wav", mtimeMs: 10 * DAY },
    { path: "old.wav", mtimeMs: 1 * DAY },
  ];

  it("deletes after the transcript unless keeping audio with a positive number of days", () => {
    expect(policy.afterTranscript({ keepAudio: false, keepDays: 7 })).toBe(
      "delete",
    );
    expect(policy.afterTranscript({ keepAudio: true, keepDays: 0 })).toBe(
      "delete",
    );
    expect(policy.afterTranscript({ keepAudio: true, keepDays: 7 })).toBe(
      "keep",
    );
  });

  it("expires kept audio after keepDays, and leftovers after a day when not keeping", () => {
    expect(
      policy.expired(files, { keepAudio: true, keepDays: 5 }, 10.5 * DAY),
    ).toEqual(["old.wav"]);
    expect(
      policy.expired(files, { keepAudio: true, keepDays: 30 }, 10.5 * DAY),
    ).toEqual([]);
    expect(
      policy.expired(files, { keepAudio: false, keepDays: 30 }, 10.5 * DAY),
    ).toEqual(["old.wav"]);
  });
});
