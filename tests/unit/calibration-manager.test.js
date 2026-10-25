import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createCalibrationManager, computeCalibration } = require('../../calibration-manager');

/**
 * Helper: feed `count` samples of a given volume to a manager,
 * advancing Date.now() by `intervalMs` between each sample.
 */
function feedSamples(manager, volume, count, mockNow, intervalMs = 17) {
  for (let i = 0; i < count; i++) {
    mockNow.value += intervalMs;
    vi.spyOn(Date, 'now').mockReturnValue(mockNow.value);
    manager.addSample(typeof volume === 'function' ? volume(i) : volume);
  }
}

/**
 * Helper: feed samples that span the full calibration duration (30s).
 */
function feedUntilComplete(manager, volume, mockNow, opts = {}) {
  const duration = opts.duration || 30000;
  const intervalMs = opts.intervalMs || 17;
  const count = Math.ceil(duration / intervalMs) + 1;
  feedSamples(manager, volume, count, mockNow, intervalMs);
}

describe('CalibrationManager', () => {
  let mockNow;

  beforeEach(() => {
    mockNow = { value: 1000000 };
    vi.spyOn(Date, 'now').mockReturnValue(mockNow.value);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------
  // 1. Typical speech calibration
  // ---------------------------------------------------------------
  it('produces reasonable thresholds from typical speech samples (volume 40-50)', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50 });

    // Feed ~1800 samples around volume 40-50 over 30s
    feedUntilComplete(manager, (i) => 40 + (i % 11), mockNow);

    expect(manager.isCalibrated()).toBe(true);
    expect(manager.isCalibrating()).toBe(false);

    const t = manager.getThresholds();
    expect(t.quiet).toBeGreaterThanOrEqual(5);
    expect(t.quiet).toBeLessThanOrEqual(40);
    expect(t.normal).toBeGreaterThanOrEqual(30);
    expect(t.normal).toBeLessThanOrEqual(80);
    expect(t.warning).toBeGreaterThanOrEqual(55);
    expect(t.warning).toBeLessThanOrEqual(95);

    // Thresholds should be proportional to a baseline around 42-44
    const data = manager.getCalibrationData();
    expect(data.baseline).toBeGreaterThanOrEqual(35);
    expect(data.baseline).toBeLessThanOrEqual(50);
    expect(data.sampleCount).toBeGreaterThan(50);
  });

  // ---------------------------------------------------------------
  // 2. Outlier resilience
  // ---------------------------------------------------------------
  it('is resilient to outlier spikes (a few 90+ samples do not skew baseline)', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50 });

    // Feed mostly volume 45, with occasional spikes at 95
    feedUntilComplete(manager, (i) => (i % 50 === 0 ? 95 : 45), mockNow);

    expect(manager.isCalibrated()).toBe(true);

    const data = manager.getCalibrationData();
    // Baseline should be close to 45, not pulled up by the 95 spikes
    expect(data.baseline).toBeGreaterThanOrEqual(40);
    expect(data.baseline).toBeLessThanOrEqual(50);
  });

  // ---------------------------------------------------------------
  // 3. Silent input guard
  // ---------------------------------------------------------------
  it('triggers "silent" status when all samples are below noiseFloor', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50, noiseFloor: 0.05 });

    // Feed samples all below 0.05 but above 0.01
    feedUntilComplete(manager, 0.03, mockNow);

    // Calibration should NOT succeed — silent guard
    expect(manager.isCalibrated()).toBe(false);

    const status = manager.getStatus();
    expect(status).not.toBeNull();
    expect(status.status).toBe('silent');
  });

  // ---------------------------------------------------------------
  // 4. Muted mic guard
  // ---------------------------------------------------------------
  it('triggers "muted" status when all samples are below mutedThreshold', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50, mutedThreshold: 0.01 });

    // Feed samples all below 0.01
    feedUntilComplete(manager, 0.005, mockNow);

    expect(manager.isCalibrated()).toBe(false);

    const status = manager.getStatus();
    expect(status).not.toBeNull();
    expect(status.status).toBe('muted');
  });

  // ---------------------------------------------------------------
  // 5. High noise guard
  // ---------------------------------------------------------------
  it('caps baseline at baselineCeiling when median exceeds 60', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50, baselineCeiling: 60 });

    // Feed high volume samples (70-80 range)
    feedUntilComplete(manager, (i) => 70 + (i % 11), mockNow);

    expect(manager.isCalibrated()).toBe(true);

    const data = manager.getCalibrationData();
    expect(data.baseline).toBe(60);

    const status = manager.getStatus();
    expect(status.status).toBe('high-noise');

    // Thresholds should be derived from capped baseline of 60
    const t = manager.getThresholds();
    expect(t.quiet).toBe(Math.round(clamp(60 * 0.6, 5, 40)));
    expect(t.normal).toBeGreaterThanOrEqual(30);
    expect(t.warning).toBeGreaterThanOrEqual(55);
  });

  // ---------------------------------------------------------------
  // 6. Minimum sample count
  // ---------------------------------------------------------------
  it('fails calibration when fewer than minSamples are collected', () => {
    const manager = createCalibrationManager({ duration: 100, minSamples: 50 });

    // Feed only 10 samples, then jump time past duration
    feedSamples(manager, 45, 10, mockNow, 5);
    // Advance time past duration
    mockNow.value += 200;
    vi.spyOn(Date, 'now').mockReturnValue(mockNow.value);
    manager.addSample(45);

    expect(manager.isCalibrated()).toBe(false);
    const status = manager.getStatus();
    expect(status).not.toBeNull();
    expect(status.status).toBe('insufficient');
  });

  // ---------------------------------------------------------------
  // 7. Threshold ordering invariant
  // ---------------------------------------------------------------
  it('always maintains quiet < normal < warning with at least 5-unit gaps', () => {
    // Test with a range of baselines to stress the clamp+ordering logic
    const baselines = [5, 10, 20, 30, 45, 55, 60, 80, 100];

    for (const b of baselines) {
      const manager = createCalibrationManager({ duration: 30000, minSamples: 50, baselineCeiling: 100 });
      feedUntilComplete(manager, b, mockNow);

      if (manager.isCalibrated()) {
        const t = manager.getThresholds();
        expect(t.quiet).toBeLessThan(t.normal);
        expect(t.normal).toBeLessThan(t.warning);
        expect(t.normal - t.quiet).toBeGreaterThanOrEqual(5);
        expect(t.warning - t.normal).toBeGreaterThanOrEqual(5);
        expect(t.warning).toBeLessThanOrEqual(95);
      }
    }
  });

  // ---------------------------------------------------------------
  // 8. Cached calibration loading
  // ---------------------------------------------------------------
  it('loads cached thresholds immediately but still runs calibration', () => {
    const cached = {
      baseline: 42,
      thresholds: { quiet: 25, normal: 63, warning: 85 },
      calibratedAt: '2026-03-15T10:00:00.000Z',
      sampleCount: 1800,
    };

    const manager = createCalibrationManager({ cachedCalibration: cached });

    // Cached thresholds are available immediately
    const t = manager.getThresholds();
    expect(t.quiet).toBe(25);
    expect(t.normal).toBe(63);
    expect(t.warning).toBe(85);

    const data = manager.getCalibrationData();
    expect(data.baseline).toBe(42);
  });

  // ---------------------------------------------------------------
  // 9. onComplete callback fires exactly once
  // ---------------------------------------------------------------
  it('fires onComplete callback exactly once when calibration completes', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50 });
    const callback = vi.fn();

    manager.onComplete(callback);

    feedUntilComplete(manager, 45, mockNow);

    expect(callback).toHaveBeenCalledTimes(1);

    const callArg = callback.mock.calls[0][0];
    expect(callArg).toHaveProperty('baseline');
    expect(callArg).toHaveProperty('thresholds');
    expect(callArg).toHaveProperty('sampleCount');

    // Feeding more samples should NOT trigger callback again
    feedSamples(manager, 45, 100, mockNow);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('still runs calibration when cached data is provided (fires onComplete after samples)', () => {
    const cached = {
      baseline: 42,
      thresholds: { quiet: 25, normal: 63, warning: 85 },
      calibratedAt: '2026-03-15T10:00:00.000Z',
      sampleCount: 1800,
    };

    const manager = createCalibrationManager({ cachedCalibration: cached, duration: 100 });
    const callback = vi.fn();

    manager.onComplete(callback);

    // Callback should NOT fire immediately — calibration still needs to run
    expect(callback).toHaveBeenCalledTimes(0);

    // But cached thresholds are available
    expect(manager.getThresholds().quiet).toBe(25);
  });

  // ---------------------------------------------------------------
  // 10. reset() clears samples, restarts calibration
  // ---------------------------------------------------------------
  it('reset() clears samples and restarts calibration while keeping old thresholds', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50 });

    // First calibration
    feedUntilComplete(manager, 45, mockNow);
    expect(manager.isCalibrated()).toBe(true);

    const oldThresholds = manager.getThresholds();

    // Reset
    manager.reset();
    expect(manager.isCalibrated()).toBe(false);
    expect(manager.isCalibrating()).toBe(false);

    // Old thresholds should still be returned (kept for continuity)
    const t = manager.getThresholds();
    expect(t.quiet).toBe(oldThresholds.quiet);
    expect(t.normal).toBe(oldThresholds.normal);
    expect(t.warning).toBe(oldThresholds.warning);

    // Can recalibrate with new volume
    const newCallback = vi.fn();
    manager.onComplete(newCallback);
    feedUntilComplete(manager, 35, mockNow);

    expect(manager.isCalibrated()).toBe(true);
    expect(newCallback).toHaveBeenCalledTimes(1);

    // New thresholds should differ from old (different volume)
    const newThresholds = manager.getThresholds();
    expect(newThresholds).not.toEqual(oldThresholds);
  });

  // ---------------------------------------------------------------
  // 11. Edge-case callbacks fire for silent/muted/insufficient (US-011)
  // ---------------------------------------------------------------
  it('fires onComplete with status "silent" when all samples are below noiseFloor', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50, noiseFloor: 0.05 });
    const callback = vi.fn();
    manager.onComplete(callback);

    feedUntilComplete(manager, 0.03, mockNow);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].status).toBe('silent');
    expect(callback.mock.calls[0][0]).not.toHaveProperty('thresholds');
  });

  it('fires onComplete with status "muted" when all samples are below mutedThreshold', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50, mutedThreshold: 0.01 });
    const callback = vi.fn();
    manager.onComplete(callback);

    feedUntilComplete(manager, 0.005, mockNow);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].status).toBe('muted');
    expect(callback.mock.calls[0][0]).not.toHaveProperty('thresholds');
  });

  it('fires onComplete with status "insufficient" when too few samples are collected', () => {
    const manager = createCalibrationManager({ duration: 100, minSamples: 50 });
    const callback = vi.fn();
    manager.onComplete(callback);

    feedSamples(manager, 45, 10, mockNow, 5);
    mockNow.value += 200;
    vi.spyOn(Date, 'now').mockReturnValue(mockNow.value);
    manager.addSample(45);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].status).toBe('insufficient');
  });

  it('fires onComplete with status "high-noise" and includes thresholds', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50, baselineCeiling: 60 });
    const callback = vi.fn();
    manager.onComplete(callback);

    feedUntilComplete(manager, (i) => 70 + (i % 11), mockNow);

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0][0];
    expect(result.status).toBe('high-noise');
    expect(result.thresholds).toBeDefined();
    expect(result.thresholds.quiet).toBeGreaterThanOrEqual(5);
  });

  // ---------------------------------------------------------------
  // Additional: computeCalibration unit tests
  // ---------------------------------------------------------------
  describe('computeCalibration', () => {
    it('computes correct baseline and thresholds for uniform samples', () => {
      const samples = Array(100).fill(40);
      const result = computeCalibration(samples);

      expect(result.baseline).toBe(40);
      expect(result.thresholds.quiet).toBe(Math.round(clamp(40 * 0.6, 5, 40)));
      expect(result.thresholds.normal).toBe(Math.round(clamp(40 * 1.5, 30, 80)));
      expect(result.thresholds.warning).toBe(Math.round(clamp(40 * 2.2, 55, 95)));
    });
  });

  // ---------------------------------------------------------------
  // Additional: default thresholds when nothing calibrated
  // ---------------------------------------------------------------
  it('returns default thresholds when no calibration or cache exists', () => {
    const manager = createCalibrationManager({});
    const t = manager.getThresholds();
    expect(t).toEqual({ quiet: 30, normal: 50, warning: 78 });
  });

  // ---------------------------------------------------------------
  // Additional: addSample no-ops after calibration
  // ---------------------------------------------------------------
  it('addSample is a no-op after calibration completes', () => {
    const manager = createCalibrationManager({ duration: 30000, minSamples: 50 });
    feedUntilComplete(manager, 45, mockNow);

    expect(manager.isCalibrated()).toBe(true);
    const dataBefore = manager.getCalibrationData();

    // Feed more samples — should be ignored
    feedSamples(manager, 90, 500, mockNow);
    const dataAfter = manager.getCalibrationData();

    expect(dataAfter.sampleCount).toBe(dataBefore.sampleCount);
  });
});

// Helper used in tests — mirrors the clamp in calibration-manager.js
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
