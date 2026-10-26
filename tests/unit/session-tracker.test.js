import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  createSessionTracker,
  pruneSessions,
} = require("../../session-tracker");

function makeTracker(extra) {
  let clock = Date.UTC(2026, 9, 25, 12, 0, 0);
  const tracker = createSessionTracker({
    algorithmVersion: 2,
    now: () => clock,
    ...extra,
  });
  return {
    tracker,
    /** Record `seconds` of one zone as 20 ms frames, advancing the clock. */
    speak(zone, seconds, relDb = 0) {
      for (let i = 0; i < seconds * 50; i++) {
        tracker.recordFrame(
          { zone, relDb: zone === "silent" ? null : relDb },
          20,
        );
        clock += 20;
      }
    },
    /** Wall time passes with no frames (mic lost, reconnecting). */
    gap(seconds) {
      clock += seconds * 1000;
    },
  };
}

describe("session tracker — speech-only, gap-free accounting (F5/F7)", () => {
  it("too loud = red time / speaking time; yellow is separate", () => {
    const s = makeTracker();
    s.speak("normal", 60);
    s.speak("warning", 20, 7);
    s.speak("danger", 20, 12);
    s.speak("silent", 100);
    const r = s.tracker.finalize();
    expect(r.speakingTime).toBeCloseTo(100, 1);
    expect(r.tooLoudRatio).toBeCloseTo(0.2, 3);
    expect(r.gettingLoudRatio).toBeCloseTo(0.2, 3);
    expect(r.zoneTime).toEqual({
      silent: 100,
      normal: 60,
      warning: 20,
      danger: 20,
    });
  });

  it("does not charge a capture gap to any zone", () => {
    const s = makeTracker();
    s.speak("normal", 10);
    s.gap(300); // 5 minutes with no mic
    s.speak("danger", 1, 12);
    const r = s.tracker.finalize();
    expect(r.zoneTime.normal).toBeCloseTo(10, 1);
    expect(r.zoneTime.danger).toBeCloseTo(1, 1);
    expect(r.coveredTime).toBeCloseTo(11, 1);
    expect(r.gapTime).toBeCloseTo(300, 0);
    expect(r.duration).toBeCloseTo(311, 0);
  });

  it("ignores calibrating / reconnecting / unavailable decisions", () => {
    const s = makeTracker();
    for (const zone of [
      "calibrating",
      "uncalibrated",
      "reconnecting",
      "unavailable",
    ]) {
      s.tracker.recordFrame({ zone, relDb: null }, 20);
    }
    expect(s.tracker.isSessionActive()).toBe(false);
    expect(s.tracker.finalize()).toBeNull();
  });

  it("stores the algorithm version and the thresholds actually in force", () => {
    const s = makeTracker({
      sensitivity: 0,
      margins: { warningDb: 6, dangerDb: 10 },
    });
    s.speak("normal", 1);
    // Calibration finished / sensitivity changed mid-session
    s.tracker.setThresholds({
      baselineDb: -31.5,
      sensitivity: 2,
      margins: { warningDb: 4, dangerDb: 8 },
    });
    const r = s.tracker.finalize();
    expect(r.algorithmVersion).toBe(2);
    expect(r.thresholds).toEqual({
      baselineDb: -31.5,
      sensitivity: 2,
      warningDb: 4,
      dangerDb: 8,
    });
  });

  it("samples relative level only while speaking and keeps the top 5 peaks", () => {
    const s = makeTracker();
    s.speak("silent", 5);
    [1, 9, 3, 12, 5, 7].forEach((db) =>
      s.speak(db >= 10 ? "danger" : db >= 6 ? "warning" : "normal", 0.1, db),
    );
    const r = s.tracker.finalize();
    expect(r.volumeSamples.length).toBeGreaterThan(0);
    expect(r.volumeSamples.every((v) => v >= 1)).toBe(true);
    expect(r.peakMoments.map((p) => p.value)).toEqual([12, 9, 7, 5, 3]);
    expect(r.peakMoments[0].timestamp).toMatch(/^2026-10-25T/);
  });

  it("silence ratio and pace use covered time", () => {
    const s = makeTracker();
    s.speak("normal", 30);
    s.speak("silent", 30);
    s.speak("normal", 30);
    s.speak("silent", 30);
    const r = s.tracker.finalize();
    expect(r.silenceRatio).toBeCloseTo(0.5, 3);
    expect(r.speakingPace).toBeCloseTo(1, 1); // 2 starts over 2 minutes
  });

  it("has the fields the store validates", () => {
    const s = makeTracker();
    s.speak("normal", 1);
    const r = s.tracker.finalize();
    for (const k of [
      "id",
      "startTime",
      "endTime",
      "duration",
      "zoneTime",
      "volumeVariance",
    ]) {
      expect(r).toHaveProperty(k);
    }
  });

  it("reset() starts a fresh session", () => {
    const s = makeTracker();
    s.speak("danger", 2, 12);
    s.tracker.reset();
    expect(s.tracker.finalize()).toBeNull();
  });
});

describe("pruneSessions", () => {
  it("keeps the newest N", () => {
    const list = Array.from({ length: 60 }, (_, i) => ({ id: i }));
    const kept = pruneSessions(list, 50);
    expect(kept).toHaveLength(50);
    expect(kept[0].id).toBe(10);
  });
});
