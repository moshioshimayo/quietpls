import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { generateInsights } = require("../../session-insights");

const base = {
  algorithmVersion: 2,
  startTime: "2026-10-25T12:00:00.000Z",
  zoneTime: { silent: 300, normal: 80, warning: 10, danger: 10 },
  volumeSamples: [],
  peakMoments: [],
};

describe("session insights (speaking-time denominators)", () => {
  it("reports too-loud share of speaking time, not of all time", () => {
    const out = generateInsights(base);
    expect(out[0]).toBe("Too loud for 10% of your speaking time");
    expect(out[1]).toBe("Getting loud for 10% of your speaking time");
  });

  it("silence does not dilute the result", () => {
    const quiet = generateInsights({
      ...base,
      zoneTime: { ...base.zoneTime, silent: 100000 },
    });
    expect(quiet[0]).toBe("Too loud for 10% of your speaking time");
  });

  it("says so when red was never reached", () => {
    const out = generateInsights({
      ...base,
      zoneTime: { silent: 10, normal: 100, warning: 0, danger: 0 },
    });
    expect(out[0]).toBe("You never hit the too-loud zone");
  });

  it("handles a session with no speech", () => {
    expect(
      generateInsights({
        ...base,
        zoneTime: { silent: 120, normal: 0, warning: 0, danger: 0 },
      }),
    ).toEqual(["No speech detected this session"]);
  });

  it("detects a dB trend between halves", () => {
    const zt = { silent: 0, normal: 100, warning: 0, danger: 0 };
    const louder = generateInsights({
      ...base,
      zoneTime: zt,
      volumeSamples: [...Array(20).fill(0), ...Array(20).fill(4)],
    });
    expect(louder).toContain("You got louder in the second half");
    const steady = generateInsights({
      ...base,
      zoneTime: zt,
      volumeSamples: Array(40).fill(1),
    });
    expect(steady).toContain("Your level was consistent throughout");
  });

  it("names the loudest moment relative to normal", () => {
    const out = generateInsights({
      ...base,
      zoneTime: { silent: 0, normal: 100, warning: 0, danger: 0 },
      peakMoments: [{ timestamp: "2026-10-25T12:02:05.000Z", value: 11.6 }],
    });
    expect(out).toContain("Loudest at 2:05: +12 dB above your normal");
  });

  it("never uses acoustic comparisons or absolute dB", () => {
    const out = generateInsights({
      ...base,
      volumeSamples: Array.from({ length: 40 }, (_, i) => i / 4),
      peakMoments: [{ timestamp: "2026-10-25T12:00:30.000Z", value: 14 }],
    }).join(" ");
    expect(out).not.toMatch(/lawn|mower|\b\d+ dB\b(?! above your normal)/);
  });

  it("returns at most 3 insights", () => {
    expect(
      generateInsights({
        ...base,
        volumeSamples: Array(40).fill(0),
        peakMoments: [{ timestamp: base.startTime, value: 5 }],
      }).length,
    ).toBeLessThanOrEqual(3);
  });
});
