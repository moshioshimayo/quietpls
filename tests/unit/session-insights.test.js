import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { generateInsights } = require('../../session-insights');

/**
 * Helper: build a sessionData object with sensible defaults that can be overridden.
 */
function makeSession(overrides = {}) {
  return {
    zoneTime: { silent: 10, quiet: 20, normal: 50, loud: 20, ...overrides.zoneTime },
    duration: overrides.duration ?? 300,
    volumeSamples: overrides.volumeSamples ?? Array(100).fill(50),
    peakMoments: overrides.peakMoments ?? [{ timestamp: '2026-03-16T10:05:30.000Z', value: 95 }],
    startTime: overrides.startTime ?? '2026-03-16T10:00:00.000Z',
    ...overrides,
  };
}

describe('session-insights', () => {
  describe('loud zone insight', () => {
    it('includes loud zone percentage when loud > 0%', () => {
      const data = makeSession({ zoneTime: { silent: 0, quiet: 10, normal: 70, loud: 20 } });
      const insights = generateInsights(data);
      expect(insights[0]).toMatch(/In your loud zone \d+% of the time/);
    });

    it('includes "stayed out of the loud zone" when loud = 0%', () => {
      const data = makeSession({ zoneTime: { silent: 5, quiet: 30, normal: 65, loud: 0 } });
      const insights = generateInsights(data);
      expect(insights[0]).toBe('You stayed out of the loud zone entirely');
    });
  });

  describe('volume trend insight', () => {
    it('reports louder in second half when avg rises 15%+', () => {
      // First 50 samples at 40, second 50 at 60 => 50% increase
      const samples = [...Array(50).fill(40), ...Array(50).fill(60)];
      const data = makeSession({ volumeSamples: samples });
      const insights = generateInsights(data);
      expect(insights).toContain('You got louder in the second half');
    });

    it('reports quieter toward the end when avg drops 15%+', () => {
      // First 50 samples at 60, second 50 at 40 => ~33% decrease
      const samples = [...Array(50).fill(60), ...Array(50).fill(40)];
      const data = makeSession({ volumeSamples: samples });
      const insights = generateInsights(data);
      expect(insights).toContain('You got quieter toward the end');
    });

    it('reports consistent volume when change is within 15%', () => {
      // All samples at 50 => 0% change
      const samples = Array(100).fill(50);
      const data = makeSession({ volumeSamples: samples });
      const insights = generateInsights(data);
      expect(insights).toContain('Your volume was consistent throughout');
    });
  });

  describe('peak moment formatting', () => {
    it('formats peak as "Loudest at M:SS into the call"', () => {
      // Peak at 5m 30s into the call
      const data = makeSession({
        startTime: '2026-03-16T10:00:00.000Z',
        peakMoments: [{ timestamp: '2026-03-16T10:05:30.000Z', value: 95 }],
      });
      const insights = generateInsights(data);
      expect(insights).toContain('Loudest at 5:30 into the call');
    });

    it('formats peak with zero-padded seconds', () => {
      // Peak at 2m 5s
      const data = makeSession({
        startTime: '2026-03-16T10:00:00.000Z',
        peakMoments: [{ timestamp: '2026-03-16T10:02:05.000Z', value: 90 }],
      });
      const insights = generateInsights(data);
      expect(insights).toContain('Loudest at 2:05 into the call');
    });
  });

  describe('overall assessment', () => {
    it('gives positive assessment when loud < 10%', () => {
      // loud = 5 out of 100 total => 5%
      const data = makeSession({
        zoneTime: { silent: 5, quiet: 30, normal: 60, loud: 5 },
        volumeSamples: Array(10).fill(50), // too few for trend
        peakMoments: [],
      });
      const insights = generateInsights(data);
      expect(insights).toContain('Great job keeping it steady!');
    });

    it('gives constructive assessment when loud >= 30%', () => {
      // loud = 40 out of 100 total => 40%
      const data = makeSession({
        zoneTime: { silent: 0, quiet: 10, normal: 50, loud: 40 },
        volumeSamples: Array(10).fill(50), // too few for trend
        peakMoments: [],
      });
      const insights = generateInsights(data);
      expect(insights).toContain('Try to keep it down next time');
    });
  });

  describe('max 3 cap', () => {
    it('never returns more than 3 insights', () => {
      // Session with all conditions that could produce insights
      const samples = [...Array(50).fill(30), ...Array(50).fill(60)];
      const data = makeSession({
        zoneTime: { silent: 0, quiet: 10, normal: 50, loud: 40 },
        volumeSamples: samples,
        peakMoments: [{ timestamp: '2026-03-16T10:05:00.000Z', value: 95 }],
        startTime: '2026-03-16T10:00:00.000Z',
      });
      const insights = generateInsights(data);
      expect(insights.length).toBeLessThanOrEqual(3);
    });
  });

  describe('edge cases', () => {
    it('returns at least 1 fallback insight for null data', () => {
      const insights = generateInsights(null);
      expect(insights.length).toBeGreaterThanOrEqual(1);
      expect(insights[0]).toBe('Keep monitoring to get more detailed insights');
    });

    it('returns at least 1 fallback insight for empty object', () => {
      const insights = generateInsights({});
      expect(insights.length).toBeGreaterThanOrEqual(1);
      expect(insights[0]).toBe('Keep monitoring to get more detailed insights');
    });

    it('does not divide by zero when firstHalfAvg is zero or near-zero', () => {
      const samples = [...Array(50).fill(0), ...Array(50).fill(50)];
      const data = makeSession({
        volumeSamples: samples,
        zoneTime: { silent: 50, quiet: 20, normal: 20, loud: 10 },
      });
      // Should not throw
      expect(() => generateInsights(data)).not.toThrow();
      const insights = generateInsights(data);
      // Should still return valid insights (loud zone at minimum)
      expect(insights.length).toBeGreaterThanOrEqual(1);
      // Volume trend should be skipped (firstHalfAvg is 0)
      expect(insights).not.toContain('You got louder in the second half');
    });
  });
});
