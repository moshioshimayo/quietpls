import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const LL = require("../../level-logic");
const { createCalibrationManager } = require("../../calibration-manager");
const h = require("./helpers/worklet-harness");

const speaking = (dbfs) => ({ dbfs, speech: true });
const ctx = (baselineDb, extra) => ({
  captureState: "running",
  baselineDb,
  sensitivity: 0,
  ...extra,
});

describe("zone margins (decided: yellow +6 dB, red +10 dB)", () => {
  it("defaults to +6/+10 and sensitivity shifts both", () => {
    expect(LL.marginsFor(0)).toEqual({ warningDb: 6, dangerDb: 10 });
    expect(LL.marginsFor(2)).toEqual({ warningDb: 4, dangerDb: 8 });
    expect(LL.marginsFor(-4)).toEqual({ warningDb: 10, dangerDb: 14 });
  });

  it("clamps sensitivity to ±4 dB", () => {
    expect(LL.marginsFor(99)).toEqual({ warningDb: 2, dangerDb: 6 });
    expect(LL.clampSensitivity("nope")).toBe(0);
  });

  it("classifies relative to the baseline", () => {
    expect(LL.decideZone(speaking(-27), ctx(-30)).zone).toBe("normal");
    expect(LL.decideZone(speaking(-24), ctx(-30)).zone).toBe("warning");
    expect(LL.decideZone(speaking(-20), ctx(-30)).zone).toBe("danger");
    expect(
      LL.decideZone(speaking(-24), ctx(-30, { sensitivity: -2 })).zone,
    ).toBe("normal");
  });
});

describe("silence and capture states are neutral (F1/F6/F7)", () => {
  it("not speaking is 'Not speaking', never 'Speak up' or quiet", () => {
    const d = LL.decideZone({ dbfs: -70, speech: false }, ctx(-30));
    expect(d).toMatchObject({
      zone: "silent",
      label: "Not speaking",
      relDb: null,
      speaking: false,
    });
  });

  it("loud non-speech (gate closed) does not count as too loud", () => {
    expect(LL.decideZone({ dbfs: -5, speech: false }, ctx(-30)).zone).toBe(
      "silent",
    );
  });

  it("lost capture shows reconnecting/unavailable, not a stale level", () => {
    expect(
      LL.decideZone(speaking(-10), ctx(-30, { captureState: "reconnecting" }))
        .zone,
    ).toBe("reconnecting");
    expect(
      LL.decideZone(speaking(-10), ctx(-30, { captureState: "interrupted" }))
        .zone,
    ).toBe("reconnecting");
    expect(
      LL.decideZone(speaking(-10), ctx(-30, { captureState: "unavailable" }))
        .label,
    ).toBe("Mic unavailable");
    // A fresh start is not a reconnect
    expect(
      LL.decideZone(null, ctx(-30, { captureState: "starting" })).label,
    ).toBe("Starting…");
  });

  it("uncalibrated or calibrating mics make no loudness claim", () => {
    expect(LL.decideZone(speaking(-10), ctx(null)).zone).toBe("uncalibrated");
    expect(
      LL.decideZone(speaking(-10), ctx(-30, { calibrating: true })).zone,
    ).toBe("calibrating");
  });
});

describe("honest units (F1)", () => {
  it("formats relative to the user's normal, with no absolute dB", () => {
    expect(LL.formatRelative(7.4)).toBe("+7 dB above your normal");
    expect(LL.formatRelative(0.3)).toBe("Normal");
    expect(LL.formatRelative(-5)).toBe("Normal");
    expect(LL.formatRelativeShort(11.6)).toBe("+12 dB");
    expect(LL.formatRelativeShort(null)).toBe("—");
  });

  it("maps zones onto the shared colour classes", () => {
    expect(
      ["silent", "normal", "warning", "danger"].map(LL.zoneToVisual),
    ).toEqual(["quiet", "normal", "loud", "danger"]);
  });
});

describe("end to end on the real worklet: +6/+10 dB steps (F3)", () => {
  function calibrateAt(levelDb) {
    const w = h.createWorklet(48000);
    const cal = createCalibrationManager();
    cal.start();
    for (const f of w.feed(
      h.concat(h.noise(1000, -65), h.speechLike(6000, levelDb)),
    )) {
      const r = cal.addFrame(f);
      if (r) return r.baselineDb;
    }
    throw new Error("calibration did not finish");
  }

  /** Dominant zone while speaking at `levelDb` after calibrating at `baseDb`. */
  function zoneAt(baseDb, levelDb) {
    const baselineDb = calibrateAt(baseDb);
    const w = h.createWorklet(48000);
    w.feed(h.noise(1000, -65));
    const msgs = w.feed(h.speechLike(4000, levelDb)).slice(25); // skip window fill
    const counts = {};
    for (const m of msgs) {
      const z = LL.decideZone(m, ctx(baselineDb)).zone;
      counts[z] = (counts[z] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  it("same voice level stays normal", () =>
    expect(zoneAt(-30, -30)).toBe("normal"));
  it("+3 dB stays normal", () => expect(zoneAt(-30, -27)).toBe("normal"));
  it("+7 dB is getting loud (yellow)", () =>
    expect(zoneAt(-30, -23)).toBe("warning"));
  it("+11 dB is too loud (red)", () => expect(zoneAt(-30, -19)).toBe("danger"));
  it("the margin is the same on a quiet or hot mic", () => {
    expect(zoneAt(-45, -38)).toBe("warning");
    expect(zoneAt(-20, -13)).toBe("warning");
  });
});
