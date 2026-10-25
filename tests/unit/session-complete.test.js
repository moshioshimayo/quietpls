import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { formatDuration } = require('../../renderer');

// ===========================================================================
// formatDuration — US-014 duration formatting
// ===========================================================================

describe('formatDuration (US-014)', () => {
  it('should return "< 1m" for null', () => {
    expect(formatDuration(null)).toBe('< 1m');
  });

  it('should return "< 1m" for undefined', () => {
    expect(formatDuration(undefined)).toBe('< 1m');
  });

  it('should return "< 1m" for 0 seconds', () => {
    expect(formatDuration(0)).toBe('< 1m');
  });

  it('should return "< 1m" for less than 60 seconds', () => {
    expect(formatDuration(59)).toBe('< 1m');
    expect(formatDuration(30)).toBe('< 1m');
  });

  it('should return "1m" for 60 seconds', () => {
    expect(formatDuration(60)).toBe('1m');
  });

  it('should return "5m" for 300 seconds', () => {
    expect(formatDuration(300)).toBe('5m');
  });

  it('should return "30m" for 1800 seconds', () => {
    expect(formatDuration(1800)).toBe('30m');
  });

  it('should return "1h 0m" for 3600 seconds', () => {
    expect(formatDuration(3600)).toBe('1h 0m');
  });

  it('should return "1h 23m" for 4980 seconds', () => {
    expect(formatDuration(4980)).toBe('1h 23m');
  });

  it('should return "2h 30m" for 9000 seconds', () => {
    expect(formatDuration(9000)).toBe('2h 30m');
  });
});
