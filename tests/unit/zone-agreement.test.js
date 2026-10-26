import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const LL = require("../../level-logic");
const { createCalibrationManager } = require("../../calibration-manager");
const { createSessionTracker } = require("../../session-tracker");
const { getZoneColor } = require("../../pill-waveform");
const { getColorForZone } = require("../../tray-icon-canvas");
const h = require("./helpers/worklet-harness");

// F5: the pill, tray and session must all come from ONE decision, including
// across the moment calibration finishes mid-session.

describe("one zone decision feeds pill, tray and session (F5)", () => {
  it("session buckets equal what the pill showed, frame for frame", () => {
    const w = h.createWorklet(48000);
    const frames = w.feed(
      h.concat(
        h.noise(1000, -65),
        h.speechLike(5000, -30), // calibration speech
        h.noise(2000, -65),
        h.speechLike(4000, -30), // normal
        h.speechLike(4000, -23), // +7: yellow
        h.speechLike(4000, -18), // +12: red
        h.noise(3000, -65), // not speaking
      ),
    );

    let clock = 0;
    const tracker = createSessionTracker({
      algorithmVersion: LL.ALGORITHM_VERSION,
      now: () => clock,
    });
    const cal = createCalibrationManager();
    cal.start();
    let baselineDb = null;
    const shownMs = {};

    for (const f of frames) {
      if (cal.isCalibrating()) {
        const r = cal.addFrame(f);
        if (r && r.status === "ok") {
          baselineDb = r.baselineDb;
          tracker.setThresholds({
            baselineDb,
            sensitivity: 0,
            margins: LL.marginsFor(0),
          });
        }
      }
      const decision = LL.decideZone(f, {
        captureState: "running",
        calibrating: cal.isCalibrating(),
        baselineDb,
        sensitivity: 0,
      });
      // pill + tray consume the same visual; session consumes the same zone
      const visual = LL.zoneToVisual(decision.zone);
      expect(getColorForZone(visual)).toBe(getZoneColor(visual));
      tracker.recordFrame(decision, f.frameMs);
      if (["silent", "normal", "warning", "danger"].includes(decision.zone)) {
        shownMs[decision.zone] = (shownMs[decision.zone] || 0) + f.frameMs;
      }
      clock += f.frameMs;
    }

    const session = tracker.finalize();
    for (const zone of ["silent", "normal", "warning", "danger"]) {
      expect(session.zoneTime[zone]).toBeCloseTo(
        (shownMs[zone] || 0) / 1000,
        1,
      );
    }
    // And the scripted levels actually exercised every zone.
    expect(session.zoneTime.normal).toBeGreaterThan(2);
    expect(session.zoneTime.warning).toBeGreaterThan(2);
    expect(session.zoneTime.danger).toBeGreaterThan(2);
    expect(session.thresholds.baselineDb).toBe(baselineDb);
  });
});
