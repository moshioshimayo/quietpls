import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const LL = require("../../level-logic");
const { createCalibrationManager } = require("../../calibration-manager");
const { createSessionTracker } = require("../../session-tracker");
const { getColorForZone } = require("../../tray-icon-canvas");
const h = require("./helpers/worklet-harness");

describe("one decision feeds bar, tray and session", () => {
  it("records only accepted speech, preserving the exact visible verdict", () => {
    const w = h.createWorklet(16000);
    w.feed(h.noise(1000, -65, 16000));
    const cal = createCalibrationManager();
    cal.start();
    let baselineDb;
    for (const f of w.feed(h.speechLike(20000, -30, 16000))) {
      const r = cal.addFrame(f);
      if (r) { expect(r.status).toBe("ok"); baselineDb = r.baselineDb; break; }
    }
    expect(baselineDb).toBeTypeOf("number");
    const decisions = LL.createDecisionTracker({ baselineDb });
    const session = createSessionTracker({ baselineDb });
    const expectedMs = { silent: 0, normal: 0, warning: 0, danger: 0 };
    let speakingMs = 0;
    for (const f of w.feed(h.concat(
      h.speechLike(6000, -30, 16000), h.speechLike(8000, -23, 16000),
      h.speechLike(10000, -18, 16000), h.noise(6000, -65, 16000),
    ))) {
      const d = decisions.update(f);
      expect(d.visual).toBe(LL.zoneToVisual(d.zone));
      expect(getColorForZone(d.visual)).toBeTypeOf("string");
      expect(d.level).toBe(d.relDb === null ? 0 : LL.relativeLevel(d.relDb));
      session.recordFrame(d, f.frameMs);
      if (d.speaking) {
        speakingMs += f.frameMs;
        if (d.zone !== "silent") expectedMs[d.zone] += f.frameMs;
      } else expectedMs.silent += f.frameMs;
    }
    const r = session.finalize(decisions.snapshot());
    for (const zone of Object.keys(expectedMs)) expect(r.zoneTime[zone]).toBeCloseTo(expectedMs[zone] / 1000, 1);
    expect(r.speakingTime).toBeCloseTo(speakingMs / 1000, 1);
    for (const zone of ["normal", "warning", "danger"]) expect(r.zoneTime[zone]).toBeGreaterThan(2);
  });
});

describe("stored ratios and displayed percentages share one denominator", () => {
  it("short loud bursts between long pauses (warm-up each time)", () => {
    const { generateInsights } = require("../../session-insights");
    const SHL = require("../../settings-history-logic");
    let clock = 0;
    const decisions = LL.createDecisionTracker({ baselineDb: -30 });
    const session = createSessionTracker({ baselineDb: -30, now: () => clock });
    const feed = (n, frame) => {
      for (let i = 0; i < n; i++) {
        session.recordFrame(decisions.update({ ...frame, frameMs: 20 }), 20);
        clock += 20;
      }
    };
    for (let i = 0; i < 40; i++) {
      feed(75, { dbfs: -15, voiced: true }); // 1.5 s at +15 dB
      feed(300, { dbfs: -90, voiced: false }); // 6 s silence
    }
    const r = session.finalize(decisions.snapshot());
    expect(r.speakingTime).toBeCloseTo(60, 1);

    const pct = (ratio) => Math.round(ratio * 100);
    const insights = generateInsights(r).join(" | ");
    if (pct(r.gettingLoudRatio) > 0) {
      expect(insights).toContain(`Getting loud for ${pct(r.gettingLoudRatio)}%`);
    } else expect(insights).not.toContain("Getting loud for");
    if (pct(r.tooLoudRatio) > 0) {
      expect(insights).toContain(`Ease your voice for ${pct(r.tooLoudRatio)}%`);
    } else expect(insights).toContain("You never needed to ease your voice");

    const bars = SHL.computeSessionZonePercentages(r);
    expect(bars.loud).toBe(pct(r.gettingLoudRatio));
    expect(bars.danger).toBe(pct(r.tooLoudRatio));
    expect(bars.normal + bars.loud + bars.danger).toBeGreaterThanOrEqual(99);
    const grade = SHL.computeSessionGrade(r).score;
    expect(grade).toBeCloseTo(1 - r.tooLoudRatio - 0.4 * r.gettingLoudRatio, 2);
  });
});

const { decisionExplanation } = require("../../renderer");
it("explains alert delay, rounded thresholds, hysteresis and recovery without changing a decision", () => {
  const t = LL.createDecisionTracker({ baselineDb: -30 });
  const feed = (db, ms) => { let d; for (let i = 0; i < ms; i += 20) d = t.update({ dbfs: db, voiced: true, frameMs: 20 }); return d; };
  feed(-30, 3000);
  const pending = feed(-18, 1000);
  expect(pending.zone).toBe("normal");
  const before = JSON.stringify(pending);
  expect(decisionExplanation(pending)).toBe("Feedback waits for a sustained change");
  expect(JSON.stringify(pending)).toBe(before);
  const loud = feed(-18, 5000);
  expect(loud.zone).toBe("danger");
  expect(decisionExplanation(loud)).toBe("");
  const held = feed(-21, 5000);
  expect(held.zone).toBe("danger");
  expect(decisionExplanation(held)).toContain("sustained change");
  const recovery = feed(-30, 500);
  expect(decisionExplanation(recovery)).toContain("sustained change");
  const normal = feed(-30, 5000);
  expect(normal.zone).toBe("normal");
  expect(decisionExplanation(normal)).toBe("");
  expect(decisionExplanation({ zone: "normal", relDb: 5.8 })).toContain("sustained change");
});
