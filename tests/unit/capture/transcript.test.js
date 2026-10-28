import { describe, it, expect } from "vitest";
import W from "../../../capture/lib/wav.js";
import T from "../../../capture/lib/transcript.js";

describe("channel mapping", () => {
  it("left channel is you (mic), right channel is them (system audio)", () => {
    expect(W.CHANNELS).toEqual({ you: 0, them: 1 });
    const left = Int16Array.from({ length: 1600 }, (_, i) =>
      i % 2 ? 16000 : -16000,
    );
    const right = new Int16Array(1600).fill(100);
    const split = W.splitCall(W.encode([left, right]));
    const you = W.decode(split.you.wav);
    const them = W.decode(split.them.wav);
    expect(you.channels).toHaveLength(1);
    expect(Array.from(you.channels[0])).toEqual(Array.from(left));
    expect(Array.from(them.channels[0])).toEqual(Array.from(right));
    expect(split.you.peak).toBeGreaterThan(0.4);
    expect(split.them.peak).toBeLessThan(T.SILENT_PEAK);
    expect(split.seconds).toBeCloseTo(0.1);
  });

  it("refuses a mono recording instead of guessing which side it is", () => {
    expect(() => W.splitCall(W.encode([new Int16Array(10)]))).toThrow(/stereo/);
  });
});

describe("transcript markdown", () => {
  const whisper = (items) => ({
    transcription: items.map(([from, text]) => ({
      offsets: { from, to: from + 1000 },
      text,
    })),
  });

  it("drops whisper's non-speech markers and interleaves both sides by time", () => {
    const you = T.parseWhisper(
      whisper([
        [0, " Hi there."],
        [5000, " [BLANK_AUDIO]"],
        [9000, " Sounds good."],
      ]),
    );
    const them = T.parseWhisper(
      whisper([
        [3000, " Hello! Can you hear me?"],
        [7000, " (silence)"],
      ]),
    );
    expect(T.mergeSides({ you, them }).map((l) => `${l.who}@${l.at}`)).toEqual([
      "you@0",
      "them@3",
      "you@9",
    ]);
  });

  it("moves a line's time to when its speech actually starts", () => {
    const samples = new Int16Array(32000);
    samples.fill(9000, 19200); // speech starts at 1.2 s
    const [line] = T.refineStarts(
      [{ at: 0, end: 2, text: "Hi." }],
      samples,
      16000,
    );
    expect(line.at).toBeCloseTo(1.2, 1);
  });

  it("drops mic lines that are the other side echoing out of the speakers", () => {
    const them = [
      {
        at: 4,
        text: "That's higher than planned. What drove the hosting cost?",
      },
    ];
    const you = [
      { at: 4.6, text: "higher than planned what drove the hosting cost" }, // echo
      { at: 10, text: "Mostly the new video pipeline." }, // real
      { at: 40, text: "What drove the hosting cost?" }, // same words, much later: real
    ];
    expect(T.dropEcho(you, them).map((l) => l.at)).toEqual([10, 40]);
  });

  it("has frontmatter (start, end, duration, apps) and [time] [you|them] lines", () => {
    const start = new Date(2026, 9, 27, 22, 15, 3);
    const end = new Date(2026, 9, 27, 22, 27, 34);
    const md = T.toMarkdown({
      start,
      end,
      apps: ["Zoom"],
      model: "base.en",
      audioKept: false,
      lines: [
        { at: 3.2, who: "you", text: "Hi." },
        { at: 65, who: "them", text: "Hello." },
      ],
    });
    const [, fm, body] = md.split(/^---$/m);
    expect(fm).toMatch(/^title: "Zoom call"$/m);
    expect(fm).toMatch(/^start: 2026-10-27T22:15:03[+-]\d\d:\d\d$/m);
    expect(fm).toMatch(/^end: 2026-10-27T22:27:34[+-]\d\d:\d\d$/m);
    expect(fm).toMatch(/^duration: "00:12:31"$/m);
    expect(fm).toMatch(/^duration_seconds: 751$/m);
    expect(fm).toMatch(/^apps: \["Zoom"\]$/m);
    expect(fm).toMatch(/^audio: deleted$/m);
    expect(body).toContain("[00:00:03] [you] Hi.\n[00:01:05] [them] Hello.\n");
    expect(T.fileName(start, ["Microsoft Teams"])).toBe(
      "2026-10-27-2215-microsoft-teams.md",
    );

    const parsed = T.parseMarkdown(md);
    expect(parsed.meta.apps).toEqual(["Zoom"]);
    expect(parsed.meta.duration).toBe("00:12:31");
    expect(parsed.lines).toEqual([
      { at: "00:00:03", who: "you", text: "Hi." },
      { at: "00:01:05", who: "them", text: "Hello." },
    ]);
  });

  it("says so when a side was silent or nothing was recognized", () => {
    const md = T.toMarkdown({
      start: new Date(),
      end: new Date(),
      apps: [],
      model: "base.en",
      audioKept: true,
      lines: [],
      silent: ["them"],
    });
    expect(md).toContain(
      "_No sound was heard from the other side (system audio)._",
    );
    expect(md).toContain("_No speech was recognized in this call._");
    expect(md).toMatch(/^audio: kept$/m);
  });
});
