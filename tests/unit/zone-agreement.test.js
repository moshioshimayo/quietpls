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
