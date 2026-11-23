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

/** Mean-power dBFS the worklet reports for steady speech at `levelDb`. */
function speechLevel(levelDb) {
  const w = h.createWorklet(48000);
  w.feed(h.noise(1000, -65));
  const s = h
    .speechFrames(w.feed(h.speechLike(20000, levelDb)))
    .filter(m => m.voiced);
  return 10 * Math.log10(s.reduce((sum, m) => sum + Math.pow(10, m.dbfs / 10), 0) / s.length);
}

describe("guided calibration (F2/F3)", () => {
  it("silence-heavy input does not drag the baseline down", () => {
    // Room silence before speech must not influence the voiced power mean.
    const w = h.createWorklet(48000);
    const frames = w.feed(
      h.concat(h.noise(4000, -65), h.speechLike(20000, -30)),
    );
    const cal = createCalibrationManager();
    cal.start();
    const r = run(cal, frames);
    expect(r.status).toBe("ok");
    expect(r.baselineDb).toBeCloseTo(speechLevel(-30), 0);
    expect(r.baselineDb).toBeGreaterThan(-35);
  });

  it("needs ~10 s of voiced speech, counted in audio time", () => {
    const w = h.createWorklet(48000);
    const frames = w.feed(h.concat(h.noise(500, -65), h.speechLike(10000, -30)));
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
    const silent = h.createWorklet(48000).feed(h.noise(41000, -65));
    expect(run(cal, silent).status).toBe("no-speech");
    expect(cal.isCalibrating()).toBe(false);

    cal.start();
    expect(cal.getProgress()).toBe(0);
    const w = h.createWorklet(48000);
    const r = run(
      cal,
      w.feed(h.concat(h.noise(500, -65), h.speechLike(20000, -24))),
    );
    expect(r.status).toBe("ok");
    expect(r.baselineDb).toBeCloseTo(speechLevel(-24), 0);
  });

  it("noise, hum and clicks never become a baseline", () => {
    const cal = createCalibrationManager();
    cal.start();
    const frames = [
      ...h.createWorklet(48000).feed(h.clicks(16000, 200, -10)),
      ...h
        .createWorklet(48000)
        .feed(h.concat(h.noise(500, -65), h.tone(16000, 40, -20))),
      ...h
        .createWorklet(48000)
        .feed(h.concat(h.noise(500, -65), h.noise(16000, -40, 48000, 9))),
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

  it("hangover padding with no voiced frame never counts as talking time", () => {
    const frames = Array.from({ length: 2100 }, (_, i) => ({
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
    const r = run(cal, w.feed(h.speechLike(20000, -55)));
    expect(r.status).toBe("ok");
    expect(r.baselineDb).toBeGreaterThan(-58);
    expect(r.baselineDb).toBeLessThan(-52);
  });

  it("rejects a clipping (overloaded) calibration", () => {
    const frames = Array.from({ length: 500 }, () => ({
      dbfs: -3,
      speech: true,
      voiced: true,
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
      { status: "ok", baselineDb: -31.6, speechMs: 10000 },
      { deviceId: "abc123", label: "MacBook Pro Microphone" },
      Date.UTC(2026, 9, 25),
    );
    expect(rec).toMatchObject({
      version: 3,
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
    expect(isValidCalibrationRecord({ version: 2, baselineDb: -30 })).toBe(false);
  });
});


describe("calibration clocks and power weighting", () => {
  it("requires explicit voiced frames and ignores invalid input durations/levels", () => {
    const cal = createCalibrationManager();
    cal.start();
    for (const frame of [
      { dbfs: -30, frameMs: 1000, speech: true },
      { dbfs: -30, frameMs: 1000, voiced: 1 },
      ...[NaN, Infinity, 0, -20].map(frameMs => ({ dbfs: -30, frameMs, voiced: true })),
      { dbfs: NaN, frameMs: 1000, voiced: true },
    ]) expect(cal.addFrame(frame)).toBeNull();
    expect(cal.getProgress()).toBe(0);
  });

  it("weights baseline by frame duration rather than dB or frame count", () => {
    const cal = createCalibrationManager();
    cal.start();
    expect(cal.addFrame({ dbfs: -30, voiced: true, frameMs: 9000 })).toBeNull();
    const r = cal.addFrame({ dbfs: -20, voiced: true, frameMs: 1000 });
    expect(r.status).toBe("ok");
    expect(r.baselineDb).toBe(-27.2);
    expect(r.speechMs).toBe(10000);
    expect(cal.getProgress()).toBe(1);
  });
});
