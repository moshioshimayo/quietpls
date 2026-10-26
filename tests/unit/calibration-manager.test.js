import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  createCalibrationManager,
  makeCalibrationRecord,
  isValidCalibrationRecord,
} = require("../../calibration-manager");
const h = require("./helpers/worklet-harness");

/** Feed frames until the manager returns a result (or frames run out). */
function run(cal, frames) {
  for (const f of frames) {
    const r = cal.addFrame(f);
    if (r) return r;
  }
  return null;
}

/** Median dBFS the worklet reports for steady speech at `levelDb`. */
function speechLevel(levelDb) {
  const w = h.createWorklet(48000);
  w.feed(h.noise(1000, -65));
  const s = h
    .speechFrames(w.feed(h.speechLike(6000, levelDb)))
    .map((m) => m.dbfs)
    .sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe("guided calibration (F2/F3)", () => {
  it("silence-heavy input does not drag the baseline down", () => {
    // 4 s of room silence (40% of the window) before 6 s of speech.
    const w = h.createWorklet(48000);
    const frames = w.feed(
      h.concat(h.noise(4000, -65), h.speechLike(6000, -30)),
    );
    const cal = createCalibrationManager();
    cal.start();
    const r = run(cal, frames);
    expect(r.status).toBe("ok");
    expect(r.baselineDb).toBeCloseTo(speechLevel(-30), 0);
    expect(r.baselineDb).toBeGreaterThan(-35);
  });

  it("needs ~2 s of voiced speech, counted in audio time", () => {
    const w = h.createWorklet(48000);
    const frames = w.feed(h.concat(h.noise(500, -65), h.speechLike(2000, -30)));
    const cal = createCalibrationManager();
    cal.start();
    expect(run(cal, frames)).toBeNull();
    expect(cal.isCalibrating()).toBe(true);
    expect(cal.getProgress()).toBeGreaterThan(0.4);
    expect(cal.getProgress()).toBeLessThan(1);
  });

  it("a silent attempt fails as no-speech, and a retry starts clean", () => {
    const cal = createCalibrationManager();
    cal.start();
    const silent = h.createWorklet(48000).feed(h.noise(11000, -65));
    expect(run(cal, silent).status).toBe("no-speech");
    expect(cal.isCalibrating()).toBe(false);

    cal.start();
    expect(cal.getProgress()).toBe(0);
    const w = h.createWorklet(48000);
    const r = run(
      cal,
      w.feed(h.concat(h.noise(500, -65), h.speechLike(6000, -24))),
    );
    expect(r.status).toBe("ok");
    expect(r.baselineDb).toBeCloseTo(speechLevel(-24), 0);
  });

  it("noise, hum and clicks never become a baseline", () => {
    const cal = createCalibrationManager();
    cal.start();
    const frames = [
      ...h.createWorklet(48000).feed(h.clicks(4000, 200, -10)),
      ...h
        .createWorklet(48000)
        .feed(h.concat(h.noise(500, -65), h.tone(4000, 40, -20))),
      ...h
        .createWorklet(48000)
        .feed(h.concat(h.noise(500, -65), h.noise(3000, -40, 48000, 9))),
    ];
    expect(run(cal, frames).status).toBe("no-speech");
  });

  it("a stationary noise that steps up during calibration never becomes the baseline", () => {
    // Review finding: the floor lags ~3 s behind a fan/tone step, and hangover
    // padded it to 3 s of "speech", so the noise level was accepted.
    for (const db of [-50, -45, -40]) {
      const w = h.createWorklet(48000);
      w.feed(h.roomTone(3000, -65));
      const cal = createCalibrationManager();
      cal.start();
      const r = run(cal, w.feed(h.roomTone(10000, db)));
      expect(r && r.status).not.toBe("ok");
    }
  });

  it("hangover padding does not count as speech time", () => {
    const frames = Array.from({ length: 600 }, (_, i) => ({
      dbfs: -30,
      bandDb: i % 2 ? -30 : -45,
      speech: true,
      voiced: false,
      frameMs: 20,
    }));
    const cal = createCalibrationManager();
    cal.start();
    expect(run(cal, frames).status).toBe("no-speech");
    expect(cal.getProgress()).toBe(0);
  });

  it("quiet speech (-55 dBFS) over room tone still calibrates", () => {
    const w = h.createWorklet(48000);
    w.feed(h.roomTone(3000, -65));
    const cal = createCalibrationManager();
    cal.start();
    const r = run(cal, w.feed(h.speechLike(10000, -55)));
    expect(r.status).toBe("ok");
    expect(r.baselineDb).toBeGreaterThan(-58);
    expect(r.baselineDb).toBeLessThan(-52);
  });

  it("rejects a clipping (overloaded) calibration", () => {
    const frames = Array.from({ length: 200 }, () => ({
      dbfs: -3,
      speech: true,
      clip: true,
      frameMs: 20,
    }));
    const cal = createCalibrationManager();
    cal.start();
    expect(run(cal, frames).status).toBe("clipping");
  });

  it("ignores frames when not calibrating and ignores no-input frames", () => {
    const cal = createCalibrationManager();
    expect(cal.addFrame({ dbfs: -30, speech: true, frameMs: 20 })).toBeNull();
    cal.start();
    for (let i = 0; i < 1000; i++) cal.addFrame({ noInput: true, frameMs: 20 });
    expect(cal.isCalibrating()).toBe(true);
    expect(cal.getProgress()).toBe(0);
  });
});

describe("calibration records", () => {
  it("records the real device and a version", () => {
    const rec = makeCalibrationRecord(
      { status: "ok", baselineDb: -31.6, speechMs: 3000 },
      { deviceId: "abc123", label: "MacBook Pro Microphone" },
      Date.UTC(2026, 9, 25),
    );
    expect(rec).toMatchObject({
      version: 2,
      baselineDb: -31.6,
      deviceId: "abc123",
      deviceLabel: "MacBook Pro Microphone",
    });
    expect(isValidCalibrationRecord(rec)).toBe(true);
  });

  it("treats 2.0 score-based records as not calibrated", () => {
    const legacy = {
      baseline: 45,
      thresholds: { quiet: 27, normal: 68, warning: 95 },
      calibratedAt: "2026-10-01T00:00:00.000Z",
    };
    expect(isValidCalibrationRecord(legacy)).toBe(false);
    expect(isValidCalibrationRecord(null)).toBe(false);
  });
});
