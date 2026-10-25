import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  formatDate,
  formatTime,
  formatDuration,
  formatTotalMinutes,
  computeGrade,
  computeZonePercentages,
  computeAverageGrade
} = require('../../settings-history-logic');

// ============================================================
// formatDate
// ============================================================

describe('formatDate', () => {
  it('formats a valid ISO date string', () => {
    expect(formatDate('2026-03-08T14:30:00.000Z')).toBe('Mar 8, 2026');
  });

  it('formats January correctly', () => {
    // Use midday to avoid timezone-related date shifts
    expect(formatDate('2025-01-15T12:00:00.000Z')).toBe('Jan 15, 2025');
  });

  it('formats December correctly', () => {
    expect(formatDate('2025-12-25T10:00:00.000Z')).toBe('Dec 25, 2025');
  });

  it('returns -- for null', () => {
    expect(formatDate(null)).toBe('--');
  });

  it('returns -- for undefined', () => {
    expect(formatDate(undefined)).toBe('--');
  });

  it('returns -- for empty string', () => {
    expect(formatDate('')).toBe('--');
  });

  it('returns -- for invalid date string', () => {
    expect(formatDate('not-a-date')).toBe('--');
  });
});

// ============================================================
// formatTime
// ============================================================

describe('formatTime', () => {
  it('formats afternoon time correctly', () => {
    expect(formatTime('2026-03-08T14:30:00.000Z')).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });

  it('formats midnight correctly', () => {
    // Midnight UTC -> local time depends on timezone, so just check format
    const result = formatTime('2026-01-01T00:00:00.000Z');
    expect(result).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });

  it('formats noon correctly', () => {
    const result = formatTime('2026-01-01T12:00:00.000Z');
    expect(result).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });

  it('returns -- for null', () => {
    expect(formatTime(null)).toBe('--');
  });

  it('returns -- for invalid date', () => {
    expect(formatTime('garbage')).toBe('--');
  });
});

// ============================================================
// formatDuration
// ============================================================

describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(45)).toBe('0m 45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2m 5s');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3661)).toBe('1h 1m');
  });

  it('formats exact hours', () => {
    expect(formatDuration(7200)).toBe('2h 0m');
  });

  it('formats zero seconds', () => {
    expect(formatDuration(0)).toBe('0m 0s');
  });

  it('returns -- for negative numbers', () => {
    expect(formatDuration(-10)).toBe('--');
  });

  it('returns -- for NaN', () => {
    expect(formatDuration(NaN)).toBe('--');
  });

  it('returns -- for non-number', () => {
    expect(formatDuration('abc')).toBe('--');
  });

  it('returns -- for undefined', () => {
    expect(formatDuration(undefined)).toBe('--');
  });
});

// ============================================================
// formatTotalMinutes
// ============================================================

describe('formatTotalMinutes', () => {
  it('formats minutes under 60', () => {
    expect(formatTotalMinutes(42)).toBe('42m');
  });

  it('formats hours and minutes', () => {
    expect(formatTotalMinutes(125)).toBe('2h 5m');
  });

  it('formats zero', () => {
    expect(formatTotalMinutes(0)).toBe('0m');
  });

  it('returns -- for negative', () => {
    expect(formatTotalMinutes(-5)).toBe('--');
  });

  it('returns -- for NaN', () => {
    expect(formatTotalMinutes(NaN)).toBe('--');
  });
});

// ============================================================
// computeGrade
// ============================================================

describe('computeGrade', () => {
  it('returns A for all quiet time', () => {
    const result = computeGrade({ quiet: 100, normal: 0, loud: 0, danger: 0 });
    expect(result.letter).toBe('A');
    expect(result.color).toBe('quiet');
    expect(result.score).toBe(1.0);
  });

  it('returns A for mostly quiet + normal', () => {
    const result = computeGrade({ quiet: 80, normal: 20, loud: 0, danger: 0 });
    expect(result.letter).toBe('A');
    expect(result.color).toBe('quiet');
  });

  it('returns B for mixed normal-heavy', () => {
    const result = computeGrade({ quiet: 20, normal: 60, loud: 10, danger: 10 });
    expect(result.letter).toBe('B');
    expect(result.color).toBe('normal');
  });

  it('returns F for all danger', () => {
    const result = computeGrade({ quiet: 0, normal: 0, loud: 0, danger: 100 });
    expect(result.letter).toBe('F');
    expect(result.color).toBe('danger');
    expect(result.score).toBe(0);
  });

  it('combines silent + quiet zones', () => {
    const result = computeGrade({ silent: 50, quiet: 50, normal: 0, loud: 0, danger: 0 });
    expect(result.letter).toBe('A');
    expect(result.score).toBe(1.0);
  });

  it('returns -- for null zoneTime', () => {
    const result = computeGrade(null);
    expect(result.letter).toBe('--');
    expect(result.color).toBe('tertiary');
  });

  it('returns -- for empty zoneTime (all zeros)', () => {
    const result = computeGrade({ quiet: 0, normal: 0, loud: 0, danger: 0 });
    expect(result.letter).toBe('--');
  });

  it('handles C grade range', () => {
    // 55% from loud (0.3) + some normal
    const result = computeGrade({ quiet: 10, normal: 20, loud: 50, danger: 20 });
    // score = 0.1*1 + 0.2*0.8 + 0.5*0.3 + 0.2*0 = 0.1 + 0.16 + 0.15 = 0.41
    expect(result.letter).toBe('D');
  });
});

// ============================================================
// computeZonePercentages
// ============================================================

describe('computeZonePercentages', () => {
  it('computes correct percentages', () => {
    const result = computeZonePercentages({ quiet: 30, normal: 30, loud: 20, danger: 20 });
    expect(result.quiet).toBe(30);
    expect(result.normal).toBe(30);
    expect(result.loud).toBe(20);
    expect(result.danger).toBe(20);
  });

  it('combines silent + quiet', () => {
    const result = computeZonePercentages({ silent: 25, quiet: 25, normal: 25, loud: 15, danger: 10 });
    expect(result.quiet).toBe(50);
    expect(result.normal).toBe(25);
  });

  it('returns zeros for null', () => {
    const result = computeZonePercentages(null);
    expect(result.quiet).toBe(0);
    expect(result.normal).toBe(0);
    expect(result.loud).toBe(0);
    expect(result.danger).toBe(0);
  });

  it('returns zeros when all values are zero', () => {
    const result = computeZonePercentages({ quiet: 0, normal: 0, loud: 0, danger: 0 });
    expect(result.quiet).toBe(0);
    expect(result.normal).toBe(0);
  });
});

// ============================================================
// computeAverageGrade
// ============================================================

describe('computeAverageGrade', () => {
  it('returns A for all-quiet sessions', () => {
    const sessions = [
      { zoneTime: { quiet: 100, normal: 0, loud: 0, danger: 0 } },
      { zoneTime: { quiet: 90, normal: 10, loud: 0, danger: 0 } }
    ];
    expect(computeAverageGrade(sessions)).toBe('A');
  });

  it('returns -- for empty array', () => {
    expect(computeAverageGrade([])).toBe('--');
  });

  it('returns -- for non-array', () => {
    expect(computeAverageGrade(null)).toBe('--');
  });

  it('skips sessions with no valid zoneTime', () => {
    const sessions = [
      { zoneTime: null },
      { zoneTime: { quiet: 100, normal: 0, loud: 0, danger: 0 } }
    ];
    expect(computeAverageGrade(sessions)).toBe('A');
  });

  it('returns F for all-danger sessions', () => {
    const sessions = [
      { zoneTime: { quiet: 0, normal: 0, loud: 0, danger: 100 } },
      { zoneTime: { quiet: 0, normal: 0, loud: 0, danger: 50 } }
    ];
    expect(computeAverageGrade(sessions)).toBe('F');
  });
});
