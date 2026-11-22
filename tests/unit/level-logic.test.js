import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const LL = require("../../level-logic");
const voiced = (dbfs, frameMs = 20) => ({ dbfs, frameMs, voiced: true, speech: true });
const pause = (frameMs) => ({ dbfs: -70, frameMs, voiced: false, speech: false });
const tracker = (options = {}) => LL.createDecisionTracker({ baselineDb: -30, ...options });
function feed(t, dbfs, ms) {
  let d;
  for (let left = ms; left > 0; left -= 20) d = t.update(voiced(dbfs, Math.min(20, left)));
  return d;
}

function expectNeutral(d, zone) {
  expect(d).toEqual({ zone, label: LL.ZONE_LABELS[zone], relDb: null, level: 0, heldZone: null, speaking: false, visual: "quiet" });
}

describe("speech-time decision tracker", () => {
  it("waits for 1000 accepted voiced ms and uses duration-weighted mean power", () => {
    const t = tracker();
    expect(t.update(voiced(-30, 999))).toMatchObject({ zone: "silent", relDb: null, speaking: true });
    expect(t.update(voiced(-30, 1))).toMatchObject({ zone: "normal", relDb: 0, speaking: true });
    // 1000 ms at -30 and 1000 ms at -20: power mean, not mean dB.
    expect(t.update(voiced(-20, 1000)).relDb).toBe(7.4);
    // Partial eviction retains 500 ms at -30, 1000 at -20, 500 at -30.
    expect(t.update(voiced(-30, 500)).relDb).toBe(7.4);
    expect(t.update(voiced(-30, 1000)).relDb).toBe(5.1);
  });

  it.each([-4, 0, 4])("has exact enter/exit hysteresis at sensitivity %s", sensitivity => {
    const m = LL.marginsFor(sensitivity);
    const t = tracker({ sensitivity });
    const settle = rel => t.update(voiced(-30 + rel, 2000));
    expect(settle(m.warningDb - 0.1).heldZone).toBe("normal");
    expect(settle(m.warningDb).heldZone).toBe("warning");
    expect(settle(m.warningDb - 1.9).heldZone).toBe("warning");
    expect(settle(m.warningDb - 2.1).heldZone).toBe("normal");
    expect(settle(m.dangerDb).heldZone).toBe("danger");
    expect(settle(m.dangerDb - 1.9).heldZone).toBe("danger");
    expect(settle(m.dangerDb - 2.1).heldZone).toBe("warning");
  });

  it("compares unrounded levels; rounding cannot enter warning early", () => {
    const d = tracker().update(voiced(-24.04, 1000));
    expect(d.relDb).toBe(6);
    expect(d.heldZone).toBe("normal");
  });

  it("accumulates loud speech across pauses, then holds a truthful bar during recovery", () => {
    const t = tracker();
    expect(feed(t, -18, 2960).zone).toBe("warning");
    expect(t.update(pause(1200))).toMatchObject({ zone: "warning", speaking: false });
    expect(feed(t, -18, 20).zone).toBe("danger");
    // A low-level frame replaces the active window, but needs 1000 accepted
    // ms below held danger to clear. The bar stays at the real relative level.
    const recovering = t.update(voiced(-30, 500));
    expect(recovering.zone).toBe("danger");
    expect(recovering.level).toBe(LL.relativeLevel(recovering.relDb));
    feed(t, -30, 2500);
    expect(t.update(null).zone).toBe("normal");
  });

  it("pauses hold recovery progress; re-entering danger resets it", () => {
    const t = tracker();
    feed(t, -18, 4000);
    // Evict the loud window with two quiet frames, then start recovery.
    t.update(voiced(-30, 1200));
    expect(t.update(voiced(-30, 800))).toMatchObject({ heldZone: "normal", zone: "danger" });
    expect(t.update(pause(1200)).zone).toBe("danger");
    expect(t.update(voiced(-18, 20)).heldZone).toBe("normal");
    expect(t.update(voiced(-18, 2000)).heldZone).toBe("danger");
    t.update(voiced(-30, 1200));
    expect(t.update(voiced(-30, 800)).zone).toBe("danger");
    expect(t.update(voiced(-30, 180)).zone).toBe("danger");
    expect(t.update(voiced(-30, 20)).zone).toBe("normal");
  });

  it("hangover and far-talker frames advance Listening and the 5000 ms reset", () => {
    const t = tracker();
    feed(t, -18, 4000);
    expect(t.update({ ...voiced(-18, 1999), voiced: false })).toMatchObject({ zone: "danger", speaking: false });
    expectNeutral(t.update(voiced(-46, 1)), "silent");
    // Listening hides the internal latch; a short accepted burst reveals it.
    expect(t.update(voiced(-18))).toMatchObject({ zone: "danger", speaking: true });
    expectNeutral(t.update({ ...voiced(-18, 2500), voiced: false }), "silent");
    expectNeutral(t.update(voiced(-46, 2500)), "silent");
    expect(t.update(voiced(-18, 999))).toMatchObject({ zone: "silent", heldZone: null, speaking: true });
    expect(t.update(voiced(-18, 1))).toMatchObject({ zone: "warning", heldZone: "danger" });
  });

  it("accepts the floor boundary and requires voiced === true", () => {
    const t = tracker();
    for (const frame of [{ dbfs: -30, speech: true, frameMs: 1000 }, { ...voiced(-30, 1000), voiced: 1 }, voiced(-45.01, 1000)])
      expectNeutral(t.update(frame), "silent");
    expect(t.update(voiced(-45, 1000))).toMatchObject({ zone: "normal", speaking: true, relDb: -15 });
  });

  it("health-only calls publish without counting speech or advancing audio time", () => {
    const t = tracker();
    expectNeutral(t.update(null), "silent");
    feed(t, -18, 2960);
    const before = t.snapshot();
    for (let i = 0; i < 1000; i++) expect(t.update(null)).toMatchObject({ zone: "warning", speaking: false });
    expect(t.snapshot()).toEqual(before);
    expect(t.update(voiced(-18)).zone).toBe("danger");
  });

  it.each([
    ["unavailable", { captureState: "unavailable", calibrating: true }],
    ["starting", { captureState: "starting", calibrating: true }],
    ["reconnecting", { captureState: "interrupted", calibrating: true }],
    ["calibrating", { captureState: "running", calibrating: true }],
  ])("clears transient state for %s with health precedence", (zone, ctx) => {
    const t = tracker();
    feed(t, -18, 4000);
    expectNeutral(t.update(null, ctx), zone);
    expect(t.update(voiced(-18, 999)).zone).toBe("silent");
    expect(t.update(voiced(-18, 1)).zone).toBe("warning");
  });

  it.each([null, undefined, NaN, Infinity, "-30"])("does not judge an invalid baseline %s", baselineDb => {
    expectNeutral(tracker({ baselineDb }).update(voiced(-10)), "uncalibrated");
  });

  it.each([
    { noInput: true, frameMs: 20 }, voiced(NaN), voiced(Infinity),
    voiced(-30, 0), voiced(-30, -1), voiced(-30, NaN), voiced(-30, Infinity),
  ])("invalid input clears the cue without adding time: %j", f => {
    const t = tracker();
    feed(t, -18, 4000);
    expectNeutral(t.update(f), "reconnecting");
    expect(t.update(voiced(-18, 999)).zone).toBe("silent");
  });

  it("sensitivity changes clear the cue and preserve the measured window", () => {
    const t = tracker();
    feed(t, -18, 4000);
    const before = t.snapshot();
    t.setSensitivity(-99); // clamped to -4; danger now +14
    expect(t.snapshot()).toEqual(before);
    expect(t.update(voiced(-18))).toMatchObject({ zone: "warning", heldZone: "warning", relDb: 12 });
    t.setSensitivity(99);
    expect(t.update(voiced(-18))).toMatchObject({ zone: "warning", heldZone: "danger", relDb: 12 });
    expect(feed(t, -18, 1980).zone).toBe("danger");
  });

  it("re-anchors once using only the first 30000 voiced ms, including partial frames", () => {
    const t = tracker();
    feed(t, -38, 29990);
    expect(t.snapshot()).toEqual({ storedBaselineDb: -30, sessionBaselineDb: -30, reanchorDb: 0, reanchored: false });
    // Only 10 ms of this 30 ms frame belong to the re-anchor measurement.
    t.update(voiced(-30, 30));
    const s = t.snapshot();
    const expected = 10 * Math.log10((29990 * Math.pow(10, -3.8) + 10 * Math.pow(10, -3)) / 30000) + 30;
    expect(s.reanchorDb).toBeCloseTo(expected, 8);
    expect(s.storedBaselineDb).toBe(-30);
    expect(s.reanchored).toBe(true);
    t.update(null, { captureState: "reconnecting" });
    feed(t, -20, 30000);
    t.update(pause(5000));
    expect(t.snapshot()).toEqual(s); // same-mic reconnect and silence preserve anchor
    t.reset();
    expect(t.snapshot()).toEqual({ storedBaselineDb: -30, sessionBaselineDb: -30, reanchorDb: 0, reanchored: false });
    expect(t.update(voiced(-30, 999)).zone).toBe("silent");
  });

  it("bounds negative re-anchor at -8 dB and can disable it for rehearsal", () => {
    const t = tracker();
    feed(t, -42, 30000);
    expect(t.snapshot()).toMatchObject({ sessionBaselineDb: -38, reanchorDb: -8, reanchored: true });
    const rehearsal = tracker({ reanchorEnabled: false });
    feed(rehearsal, -18, 40000);
    expect(rehearsal.snapshot()).toEqual({ storedBaselineDb: -30, sessionBaselineDb: -30, reanchorDb: 0, reanchored: false });
  });
});

describe("shared labels, units and margins", () => {
  it("defaults to +6/+10, clamps sensitivity and shifts both margins", () => {
    expect(LL.marginsFor(0)).toEqual({ warningDb: 6, dangerDb: 10 });
    expect(LL.marginsFor(2)).toEqual({ warningDb: 4, dangerDb: 8 });
    expect(LL.marginsFor(-99)).toEqual({ warningDb: 10, dangerDb: 14 });
    expect(LL.marginsFor(99)).toEqual({ warningDb: 2, dangerDb: 6 });
    expect(LL.clampSensitivity("nope")).toBe(0);
    expect(LL.ALGORITHM_VERSION).toBe(3);
    expect(LL.ACTIVE_WINDOW_MS).toBe(2000);
    expect(LL.ALERT_SPEECH_MS).toBe(2000);
  });
  it("formats relative levels and exposes neutral Listening", () => {
    expect(LL.formatRelative(7.4)).toBe("+7 dB above your normal");
    expect(LL.formatRelative(0.3)).toBe("Normal");
    expect(LL.formatRelative(-5)).toBe("Normal");
    expect(LL.formatRelativeShort(11.6)).toBe("+12 dB");
    expect(LL.formatRelativeShort(null)).toBe("—");
    expect(["silent", "normal", "warning", "danger"].map(LL.zoneToVisual)).toEqual(["quiet", "normal", "loud", "danger"]);
  });
  it("maps actual relative levels onto the 0–100 bar", () => {
    expect([-20, -10, 0, 6, 10, 15, 20].map(LL.relativeLevel)).toEqual([0, 0, 40, 64, 80, 100, 100]);
    expect([null, NaN, Infinity].map(LL.relativeLevel)).toEqual([0, 0, 0]);
  });
});
