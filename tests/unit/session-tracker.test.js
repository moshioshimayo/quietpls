import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { createSessionTracker, pruneSessions } = require('../../session-tracker');

const DEFAULT_THRESHOLDS = {
  quietThreshold: 30,
  normalThreshold: 50,
  warningThreshold: 78,
};

/**
 * Helper: advance Date.now() by `ms` milliseconds and call
 * tracker.recordVolume(volume).
 */
function advanceAndRecord(tracker, volume, ms, mockNow) {
  mockNow.value += ms;
  vi.spyOn(Date, 'now').mockReturnValue(mockNow.value);
  tracker.recordVolume(volume);
}

/**
 * Helper: send volume readings for `durationMs` at roughly `intervalMs`
 * cadence, advancing the clock accordingly.
 */
function feedVolume(tracker, volume, durationMs, intervalMs, mockNow) {
  const iterations = Math.floor(durationMs / intervalMs);
  for (let i = 0; i < iterations; i++) {
    advanceAndRecord(tracker, volume, intervalMs, mockNow);
  }
}

describe('session-tracker', () => {
  let tracker;
  let mockNow;

  beforeEach(() => {
    mockNow = { value: 1000000 }; // arbitrary epoch ms
    vi.spyOn(Date, 'now').mockReturnValue(mockNow.value);
    tracker = createSessionTracker(DEFAULT_THRESHOLDS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Session activation
  // ----------------------------------------------------------------
  describe('session activation', () => {
    it('should activate session on first recordVolume call', () => {
      tracker.recordVolume(50);
      expect(tracker.isSessionActive()).toBe(true);
    });

    it('should return valid data from finalize() even for short sessions', () => {
      tracker.recordVolume(50);
      feedVolume(tracker, 50, 5_000, 100, mockNow);

      const session = tracker.finalize();
      expect(session).not.toBeNull();
      expect(session.duration).toBeCloseTo(5, 0);
    });

    it('should return null from finalize() when no volume recorded', () => {
      expect(tracker.finalize()).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // Zone accumulation
  // ----------------------------------------------------------------
  describe('zone accumulation', () => {
    it('should accumulate time in the correct zones', () => {
      tracker.recordVolume(50); // init — activates session

      // Send 10 s of each zone (thresholds: quiet=30, normal=50, warning=78)
      feedVolume(tracker, 5, 10_000, 100, mockNow);   // silent (< 30)
      feedVolume(tracker, 35, 10_000, 100, mockNow);   // quiet (30-49)
      feedVolume(tracker, 60, 10_000, 100, mockNow);   // normal (50-77)
      feedVolume(tracker, 85, 10_000, 100, mockNow);   // loud (>= 78)

      const session = tracker.finalize();

      expect(session.zoneTime.silent).toBeCloseTo(10, 0);
      expect(session.zoneTime.quiet).toBeCloseTo(10, 0);
      expect(session.zoneTime.normal).toBeCloseTo(10, 0);
      expect(session.zoneTime.loud).toBeCloseTo(10, 0);
    });

    it('should classify volumes at exact thresholds correctly', () => {
      tracker.recordVolume(50); // init

      // Volume exactly at quietThreshold (30) → quiet zone
      feedVolume(tracker, 30, 5_000, 100, mockNow);
      // Volume exactly at normalThreshold (50) → normal zone
      feedVolume(tracker, 50, 5_000, 100, mockNow);
      // Volume exactly at warningThreshold (78) → loud zone
      feedVolume(tracker, 78, 5_000, 100, mockNow);

      const session = tracker.finalize();
      expect(session.zoneTime.quiet).toBeGreaterThan(4);
      expect(session.zoneTime.normal).toBeGreaterThan(4);
      expect(session.zoneTime.loud).toBeGreaterThan(4);
    });
  });

  // ----------------------------------------------------------------
  // Speaking pace estimation
  // ----------------------------------------------------------------
  describe('speaking pace estimation', () => {
    it('should count silence-to-speech transitions per minute', () => {
      tracker.recordVolume(50); // init

      // Alternate silence/speech 6 times over 60 s
      for (let i = 0; i < 6; i++) {
        feedVolume(tracker, 5, 5_000, 100, mockNow);   // silent
        feedVolume(tracker, 50, 5_000, 100, mockNow);   // speech
      }

      const session = tracker.finalize();
      // 6 transitions in 60 s of tracked time = 6 per minute
      expect(session.speakingPace).toBeCloseTo(6, 0);
    });

    it('should return 0 pace when no transitions occur', () => {
      tracker.recordVolume(50);
      feedVolume(tracker, 50, 10_000, 100, mockNow);

      const session = tracker.finalize();
      expect(session.speakingPace).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // Volume variance
  // ----------------------------------------------------------------
  describe('volume variance (stddev)', () => {
    it('should return 0 variance for constant volume', () => {
      tracker.recordVolume(50);
      feedVolume(tracker, 50, 10_000, 100, mockNow);

      const session = tracker.finalize();
      expect(session.volumeVariance).toBe(0);
    });

    it('should compute correct stddev for varying volumes', () => {
      tracker.recordVolume(50);

      // Alternate between 30 and 70 for 10 s at 100 ms intervals
      for (let i = 0; i < 50; i++) {
        advanceAndRecord(tracker, 30, 100, mockNow);
        advanceAndRecord(tracker, 70, 100, mockNow);
      }

      const session = tracker.finalize();
      // stddev of alternating 30 and 70 ≈ 20 (with the initial 50 sample, slightly off)
      expect(session.volumeVariance).toBeCloseTo(20, -1);
    });
  });

  // ----------------------------------------------------------------
  // Peak moments
  // ----------------------------------------------------------------
  describe('peak moments tracking', () => {
    it('should keep top 5 peaks sorted descending', () => {
      tracker.recordVolume(50);

      // Send distinct peaks
      const peaks = [40, 80, 60, 90, 70, 95, 50];
      for (const v of peaks) {
        advanceAndRecord(tracker, v, 100, mockNow);
      }

      const session = tracker.finalize();
      expect(session.peakMoments.length).toBeLessThanOrEqual(5);
      expect(session.peakMoments[0].value).toBe(95);
      expect(session.peakMoments[1].value).toBe(90);

      // Verify descending order
      for (let i = 1; i < session.peakMoments.length; i++) {
        expect(session.peakMoments[i].value).toBeLessThanOrEqual(
          session.peakMoments[i - 1].value
        );
      }
    });

    it('should include ISO timestamps on peaks', () => {
      tracker.recordVolume(50);
      advanceAndRecord(tracker, 99, 100, mockNow);

      const session = tracker.finalize();
      expect(session.peakMoments[0].timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
      );
    });
  });

  // ----------------------------------------------------------------
  // 10 Hz sampling
  // ----------------------------------------------------------------
  describe('10 Hz sampling', () => {
    it('should only record one sample per 100 ms even if called more often', () => {
      tracker.recordVolume(50); // init

      // Feed at 10 ms intervals for 1 s — should get ~10 samples, not 100
      feedVolume(tracker, 42, 1_000, 10, mockNow);
      const session = tracker.finalize();

      expect(session.volumeSamples.length).toBeLessThanOrEqual(15);
      expect(session.volumeSamples.length).toBeGreaterThanOrEqual(8);
    });

    it('should record samples at ~100 ms cadence', () => {
      tracker.recordVolume(50);

      // Feed 5 s of data at exactly 100 ms intervals
      feedVolume(tracker, 60, 5_000, 100, mockNow);

      const session = tracker.finalize();
      // ~50 samples from 5 s at 10 Hz
      expect(session.volumeSamples.length).toBeGreaterThanOrEqual(48);
      expect(session.volumeSamples.length).toBeLessThanOrEqual(55);
    });
  });

  // ----------------------------------------------------------------
  // Silence ratio
  // ----------------------------------------------------------------
  describe('silence ratio', () => {
    it('should compute correct silence ratio', () => {
      tracker.recordVolume(50);

      // 5 s silent, 15 s speech → silent is 5 out of 20
      feedVolume(tracker, 5, 5_000, 100, mockNow);
      feedVolume(tracker, 50, 15_000, 100, mockNow);

      const session = tracker.finalize();
      expect(session.zoneTime.silent).toBeCloseTo(5, 0);
      expect(session.silenceRatio).toBeGreaterThan(0);
      expect(session.silenceRatio).toBeLessThan(1);
    });
  });

  // ----------------------------------------------------------------
  // Session object structure
  // ----------------------------------------------------------------
  describe('finalized session object', () => {
    it('should have all required fields', () => {
      tracker.recordVolume(50);
      feedVolume(tracker, 50, 5_000, 100, mockNow);

      const session = tracker.finalize();

      expect(session).toHaveProperty('id');
      expect(session).toHaveProperty('startTime');
      expect(session).toHaveProperty('endTime');
      expect(session).toHaveProperty('duration');
      expect(session).toHaveProperty('volumeSamples');
      expect(session).toHaveProperty('peakMoments');
      expect(session).toHaveProperty('zoneTime');
      expect(session).toHaveProperty('silenceRatio');
      expect(session).toHaveProperty('speakingPace');
      expect(session).toHaveProperty('volumeVariance');

      // UUID v4 format
      expect(session.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(session.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(session.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof session.duration).toBe('number');
      expect(Array.isArray(session.volumeSamples)).toBe(true);
      expect(Array.isArray(session.peakMoments)).toBe(true);
      expect(session.zoneTime).toHaveProperty('silent');
      expect(session.zoneTime).toHaveProperty('quiet');
      expect(session.zoneTime).toHaveProperty('normal');
      expect(session.zoneTime).toHaveProperty('loud');
    });
  });

  // ----------------------------------------------------------------
  // Reset
  // ----------------------------------------------------------------
  describe('reset()', () => {
    it('should clear all state so a new session can be tracked', () => {
      tracker.recordVolume(50);
      expect(tracker.isSessionActive()).toBe(true);

      tracker.reset();
      expect(tracker.isSessionActive()).toBe(false);
      expect(tracker.finalize()).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // getSessionDuration
  // ----------------------------------------------------------------
  describe('getSessionDuration()', () => {
    it('should return 0 when no volume recorded yet', () => {
      expect(tracker.getSessionDuration()).toBe(0);
    });

    it('should return elapsed seconds since session started', () => {
      tracker.recordVolume(50);
      feedVolume(tracker, 50, 10_000, 100, mockNow);

      const dur = tracker.getSessionDuration();
      expect(dur).toBeGreaterThanOrEqual(9);
      expect(dur).toBeLessThanOrEqual(11);
    });
  });

  // ----------------------------------------------------------------
  // pruneSessions
  // ----------------------------------------------------------------
  describe('pruneSessions()', () => {
    function makeSessions(n) {
      return Array.from({ length: n }, (_, i) => ({
        id: `session-${i}`,
        startTime: new Date(1000000 + i * 100000).toISOString(),
      }));
    }

    it('should keep all sessions when count is 49 (below limit)', () => {
      const sessions = makeSessions(49);
      const pruned = pruneSessions(sessions, 50);
      expect(pruned.length).toBe(49);
    });

    it('should keep all sessions when count is exactly 50', () => {
      const sessions = makeSessions(50);
      const pruned = pruneSessions(sessions, 50);
      expect(pruned.length).toBe(50);
    });

    it('should prune to 50 when count is 51', () => {
      const sessions = makeSessions(51);
      const pruned = pruneSessions(sessions, 50);
      expect(pruned.length).toBe(50);
      // Should keep the newest (last) 50, dropping session-0
      expect(pruned[0].id).toBe('session-1');
      expect(pruned[49].id).toBe('session-50');
    });

    it('should not mutate the input array', () => {
      const sessions = makeSessions(55);
      const pruned = pruneSessions(sessions, 50);
      expect(sessions.length).toBe(55);
      expect(pruned.length).toBe(50);
    });
  });
});
