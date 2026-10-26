import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const h = require("./helpers/worklet-harness");

// These run the real volume-processor.js (vm, 128-sample render quanta).

const last = (msgs) => msgs[msgs.length - 1];
const levels = (msgs) => msgs.filter((m) => typeof m.dbfs === "number");

describe("volume-processor — level in true dBFS (F1/F3)", () => {
  it("reports RMS 0.05 as −26.0 dBFS, not an invented 0–100 score", () => {
    const w = h.createWorklet(48000);
    const msgs = w.feed(h.tone(1000, 1000, 20 * Math.log10(0.05)));
    expect(last(msgs).dbfs).toBeCloseTo(-26.02, 1);
    expect(last(msgs).volume).toBeUndefined();
  });

  it("doubling the amplitude adds 6.02 dB at any level", () => {
    for (const base of [-40, -30, -20]) {
      const a = h.createWorklet(48000);
      const b = h.createWorklet(48000);
      const la = last(a.feed(h.tone(800, 1000, base))).dbfs;
      const lb = last(b.feed(h.tone(800, 1000, base + 6.0206))).dbfs;
      expect(lb - la).toBeCloseTo(6.02, 1);
    }
  });

  it("works at a low 8 kHz sample rate too", () => {
    const w = h.createWorklet(8000);
    w.feed(h.noise(1000, -65, 8000));
    const msgs = w.feed(h.speechLike(3000, -30, 8000));
    expect(last(msgs).dbfs).toBeGreaterThan(-35);
    expect(h.speechFrames(msgs).length).toBeGreaterThan(100);
  });

  it("is the same across sample rates", () => {
    const got = [16000, 44100, 48000, 96000].map(
      (fs) => last(h.createWorklet(fs).feed(h.tone(800, 1000, -30, fs))).dbfs,
    );
    for (const v of got) expect(v).toBeCloseTo(-30, 0);
  });

  it("uses a 400 ms window: a step settles by 400 ms, not instantly", () => {
    const w = h.createWorklet(48000);
    w.feed(h.noise(1000, -90));
    const msgs = w.feed(h.tone(600, 1000, -20));
    const at = (ms) => msgs[Math.round(ms / 20) - 1].dbfs;
    expect(at(100)).toBeLessThan(-24); // still filling
    expect(at(440)).toBeCloseTo(-20, 0);
  });

  it("flags clipping when samples reach full scale", () => {
    const w = h.createWorklet(48000);
    const clean = w.feed(h.tone(200, 1000, -10));
    expect(clean.some((m) => m.clip)).toBe(false);
    const hot = w.feed(h.tone(200, 1000, 0)); // peak 1.41 > full scale
    expect(hot.some((m) => m.clip)).toBe(true);
  });

  it("high-pass removes DC and low hum from the level", () => {
    const w = h.createWorklet(48000);
    const dc = new Float32Array(48000).fill(0.3);
    expect(last(w.feed(dc)).dbfs).toBeLessThan(-80);
    const hum = last(h.createWorklet(48000).feed(h.tone(1000, 30, -20))).dbfs;
    expect(hum).toBeLessThan(-40);
  });

  it("posts one message per ~20 ms frame", () => {
    const w = h.createWorklet(48000);
    const msgs = w.feed(h.noise(1000, -60));
    expect(msgs.length).toBe(50);
    expect(msgs[0].frameMs).toBeCloseTo(20, 5);
  });
});

describe("volume-processor — speech gate (F6)", () => {
  it("marks speech-like sound as speech", () => {
    const w = h.createWorklet(48000);
    w.feed(h.noise(1000, -65));
    const msgs = w.feed(h.speechLike(3000, -30));
    const share = msgs.filter((m) => m.speech).length / msgs.length;
    expect(share).toBeGreaterThan(0.9);
  });

  it("silence and a quiet room are not speech", () => {
    const w = h.createWorklet(48000);
    expect(h.speechFrames(w.feed(h.noise(3000, -65)))).toHaveLength(0);
    expect(
      h.speechFrames(h.createWorklet(48000).feed(new Float32Array(48000))),
    ).toHaveLength(0);
  });

  it("rejects low hum and high hiss (frequency gate)", () => {
    const hum = h.createWorklet(48000);
    expect(
      h.speechFrames(
        hum.feed(h.concat(h.noise(1000, -65), h.tone(4000, 40, -20))),
      ),
    ).toHaveLength(0);
    const hiss = h.createWorklet(48000);
    expect(
      h.speechFrames(
        hiss.feed(h.concat(h.noise(1000, -65), h.tone(4000, 8000, -30))),
      ),
    ).toHaveLength(0);
  });

  it("digital zeros at stream start do not make room tone look like speech", () => {
    // Real capture opens with a few hundred ms of exact zeros; they must not
    // become the noise floor (found in the real-mic smoke test).
    const w = h.createWorklet(48000);
    const msgs = w.feed(
      h.concat(new Float32Array(24000), h.roomTone(5000, -61)),
    );
    expect(h.speechFrames(msgs)).toHaveLength(0);
  });

  it("a mic start-up ramp (zeros, one very quiet frame) does not open the gate", () => {
    // Shape measured on the MacBook built-in mic: ~150 ms of zeros, one frame
    // around -91 dB, then room tone around -66 dB.
    const w = h.createWorklet(48000);
    const msgs = w.feed(
      h.concat(
        new Float32Array(7200),
        h.roomTone(20, -91),
        h.roomTone(5000, -66),
      ),
    );
    expect(h.speechFrames(msgs)).toHaveLength(0);
    // ...while real speech right after start still registers quickly
    const v = h.createWorklet(48000);
    const sp = v.feed(
      h.concat(
        new Float32Array(7200),
        h.roomTone(300, -66),
        h.speechLike(2000, -30),
      ),
    );
    expect(h.speechFrames(sp).length).toBeGreaterThan(70);
  });

  it("rejects short transients such as clicks and taps", () => {
    const w = h.createWorklet(48000);
    expect(h.speechFrames(w.feed(h.clicks(5000, 250, -10)))).toHaveLength(0);
  });

  it("does not treat steady broadband noise (fan) as speech", () => {
    const w = h.createWorklet(48000);
    const msgs = w.feed(
      h.concat(h.noise(1000, -65), h.noise(8000, -40, 48000, 5)),
    );
    expect(h.speechFrames(msgs)).toHaveLength(0);
  });

  it("holds through short word gaps but ends after speech stops", () => {
    const w = h.createWorklet(48000);
    w.feed(h.noise(1000, -65));
    w.feed(h.speechLike(2000, -30));
    const after = w.feed(h.noise(1000, -65));
    expect(after[0].speech).toBe(true); // hangover
    expect(last(after).speech).toBe(false);
  });

  it("reports missing input instead of going silent", () => {
    const w = h.createWorklet(48000);
    const msgs = w.feedNoInput(40);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every((m) => m.noInput === true)).toBe(true);
  });
});
