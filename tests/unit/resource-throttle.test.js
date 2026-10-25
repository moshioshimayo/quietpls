'use strict';

// vitest globals (describe, it, expect) are injected via vitest.config.js globals: true

const {
  shouldSkipFrame,
  calculateTargetFps,
  isIdleAudio,
  shouldWarnMemory,
  calculateBarCount,
  isSessionExpired,
  fpsToInterval,
  FPS_DEFAULTS,
  MEMORY_WARNING_THRESHOLD_MB,
  IDLE_VOLUME_THRESHOLD,
  IDLE_DURATION_MS,
  SESSION_MAX_AGE_DAYS,
} = require('../../resource-throttle');

// ── shouldSkipFrame ──────────────────────────────────────────────────

describe('shouldSkipFrame', () => {
  it('should not skip the first frame (lastFrameTime = 0)', () => {
    expect(shouldSkipFrame(0, 30, 1000)).toBe(false);
  });

  it('should skip when elapsed time is less than the frame interval', () => {
    // At 30fps, interval = ~33.3ms. 10ms elapsed → skip
    expect(shouldSkipFrame(1000, 30, 1010)).toBe(true);
  });

  it('should not skip when enough time has elapsed', () => {
    // At 30fps, interval = ~33.3ms. 40ms elapsed → render
    expect(shouldSkipFrame(1000, 30, 1040)).toBe(false);
  });

  it('should not skip when elapsed time slightly exceeds the frame interval', () => {
    // At 30fps, interval = ~33.33ms. 34ms elapsed → render
    expect(shouldSkipFrame(1000, 30, 1034)).toBe(false);
  });

  it('should always skip when targetFps is 0 or negative', () => {
    expect(shouldSkipFrame(1000, 0, 2000)).toBe(true);
    expect(shouldSkipFrame(1000, -5, 2000)).toBe(true);
  });

  it('should handle very low FPS targets (1fps)', () => {
    // 1fps → 1000ms interval. 500ms elapsed → skip
    expect(shouldSkipFrame(1000, 1, 1500)).toBe(true);
    // 1100ms elapsed → render
    expect(shouldSkipFrame(1000, 1, 2100)).toBe(false);
  });

  it('should handle very high FPS targets (120fps)', () => {
    // 120fps → ~8.3ms interval. 5ms elapsed → skip
    expect(shouldSkipFrame(1000, 120, 1005)).toBe(true);
    // 10ms elapsed → render
    expect(shouldSkipFrame(1000, 120, 1010)).toBe(false);
  });
});

// ── calculateTargetFps ──────────────────────────────────────────────

describe('calculateTargetFps', () => {
  it('should return FOREGROUND fps when focused, on AC, and not idle', () => {
    expect(calculateTargetFps({ isFocused: true, isOnBattery: false, isIdle: false }))
      .toBe(FPS_DEFAULTS.FOREGROUND);
  });

  it('should return BACKGROUND fps when unfocused', () => {
    expect(calculateTargetFps({ isFocused: false, isOnBattery: false, isIdle: false }))
      .toBe(FPS_DEFAULTS.BACKGROUND);
  });

  it('should return BATTERY fps when focused and on battery', () => {
    expect(calculateTargetFps({ isFocused: true, isOnBattery: true, isIdle: false }))
      .toBe(FPS_DEFAULTS.BATTERY);
  });

  it('should return IDLE fps when idle, regardless of focus or battery', () => {
    expect(calculateTargetFps({ isFocused: true, isOnBattery: false, isIdle: true }))
      .toBe(FPS_DEFAULTS.IDLE);
    expect(calculateTargetFps({ isFocused: false, isOnBattery: true, isIdle: true }))
      .toBe(FPS_DEFAULTS.IDLE);
  });

  it('should prioritize idle over background', () => {
    const fps = calculateTargetFps({ isFocused: false, isOnBattery: false, isIdle: true });
    expect(fps).toBe(FPS_DEFAULTS.IDLE);
    expect(fps).toBeLessThan(FPS_DEFAULTS.BACKGROUND);
  });

  it('should handle missing isIdle (defaults to falsy)', () => {
    expect(calculateTargetFps({ isFocused: true, isOnBattery: false }))
      .toBe(FPS_DEFAULTS.FOREGROUND);
  });
});

// ── isIdleAudio ─────────────────────────────────────────────────────

describe('isIdleAudio', () => {
  it('should return false when volume is above the threshold', () => {
    expect(isIdleAudio(50, IDLE_VOLUME_THRESHOLD, IDLE_DURATION_MS, 60000)).toBe(false);
  });

  it('should return false when silence duration is less than idle duration', () => {
    expect(isIdleAudio(0, IDLE_VOLUME_THRESHOLD, IDLE_DURATION_MS, 10000)).toBe(false);
  });

  it('should return true when volume is below threshold for long enough', () => {
    expect(isIdleAudio(1, IDLE_VOLUME_THRESHOLD, IDLE_DURATION_MS, 31000)).toBe(true);
  });

  it('should return true at exactly the idle duration boundary', () => {
    expect(isIdleAudio(0, IDLE_VOLUME_THRESHOLD, IDLE_DURATION_MS, IDLE_DURATION_MS)).toBe(true);
  });

  it('should use custom thresholds correctly', () => {
    // Custom: idle if volume < 5 for 10 seconds
    expect(isIdleAudio(3, 5, 10000, 10000)).toBe(true);
    expect(isIdleAudio(3, 5, 10000, 9999)).toBe(false);
    expect(isIdleAudio(5, 5, 10000, 20000)).toBe(false); // volume = threshold → not silent
  });
});

// ── shouldWarnMemory ────────────────────────────────────────────────

describe('shouldWarnMemory', () => {
  it('should return false when memory is below the default threshold', () => {
    expect(shouldWarnMemory(100)).toBe(false);
  });

  it('should return true when memory exceeds the default threshold', () => {
    expect(shouldWarnMemory(200)).toBe(true);
  });

  it('should return false at exactly the threshold', () => {
    expect(shouldWarnMemory(MEMORY_WARNING_THRESHOLD_MB)).toBe(false);
  });

  it('should return true just above the threshold', () => {
    expect(shouldWarnMemory(MEMORY_WARNING_THRESHOLD_MB + 0.01)).toBe(true);
  });

  it('should accept a custom threshold', () => {
    expect(shouldWarnMemory(80, 100)).toBe(false);
    expect(shouldWarnMemory(120, 100)).toBe(true);
  });
});

// ── calculateBarCount ───────────────────────────────────────────────

describe('calculateBarCount', () => {
  it('should return the default count in normal mode', () => {
    expect(calculateBarCount(40, false, false)).toBe(40);
  });

  it('should halve bar count on battery', () => {
    expect(calculateBarCount(40, true, false)).toBe(20);
  });

  it('should quarter bar count when idle', () => {
    expect(calculateBarCount(40, false, true)).toBe(10);
  });

  it('should prefer idle reduction over battery', () => {
    // idle takes priority
    expect(calculateBarCount(40, true, true)).toBe(10);
  });

  it('should enforce a minimum of 8 bars on battery', () => {
    expect(calculateBarCount(10, true, false)).toBe(8);
  });

  it('should enforce a minimum of 4 bars when idle', () => {
    expect(calculateBarCount(8, false, true)).toBe(4);
  });
});

// ── isSessionExpired ────────────────────────────────────────────────

describe('isSessionExpired', () => {
  it('should return false for a recent session', () => {
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString(); // 1 second ago
    expect(isSessionExpired(recent, 90, now)).toBe(false);
  });

  it('should return true for a session older than maxAgeDays', () => {
    const now = Date.now();
    const old = new Date(now - 91 * 24 * 60 * 60 * 1000).toISOString();
    expect(isSessionExpired(old, 90, now)).toBe(true);
  });

  it('should return false at exactly the boundary', () => {
    const now = Date.now();
    const boundary = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    expect(isSessionExpired(boundary, 90, now)).toBe(false);
  });

  it('should return true for an invalid date string', () => {
    expect(isSessionExpired('not-a-date', 90, Date.now())).toBe(true);
  });
});

// ── fpsToInterval ───────────────────────────────────────────────────

describe('fpsToInterval', () => {
  it('should convert 60fps to ~16.67ms', () => {
    expect(fpsToInterval(60)).toBeCloseTo(16.667, 1);
  });

  it('should convert 30fps to ~33.33ms', () => {
    expect(fpsToInterval(30)).toBeCloseTo(33.333, 1);
  });

  it('should return Infinity for 0fps', () => {
    expect(fpsToInterval(0)).toBe(Infinity);
  });

  it('should return Infinity for negative fps', () => {
    expect(fpsToInterval(-10)).toBe(Infinity);
  });
});

// ── Constants ───────────────────────────────────────────────────────

describe('exported constants', () => {
  it('should export sensible FPS_DEFAULTS', () => {
    expect(FPS_DEFAULTS.FOREGROUND).toBeGreaterThan(FPS_DEFAULTS.BACKGROUND);
    expect(FPS_DEFAULTS.BACKGROUND).toBeGreaterThan(FPS_DEFAULTS.IDLE);
    expect(FPS_DEFAULTS.BATTERY).toBeLessThan(FPS_DEFAULTS.FOREGROUND);
  });

  it('should export MEMORY_WARNING_THRESHOLD_MB as 150', () => {
    expect(MEMORY_WARNING_THRESHOLD_MB).toBe(150);
  });

  it('should export IDLE_DURATION_MS as 30000', () => {
    expect(IDLE_DURATION_MS).toBe(30000);
  });

  it('should export SESSION_MAX_AGE_DAYS as 90', () => {
    expect(SESSION_MAX_AGE_DAYS).toBe(90);
  });
});
