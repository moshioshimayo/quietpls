'use strict';

/**
 * US-009: Unit tests for expanded-state pure logic functions
 * (deriveVolumeZone, volumeToDbString) extracted from renderer.js
 */

const { deriveVolumeZone, volumeToDbString } = require('../../renderer');

describe('deriveVolumeZone', () => {
  const thresholds = { quietThreshold: 30, normalThreshold: 50, warningThreshold: 78 };

  it('returns quiet zone below quietThreshold', () => {
    expect(deriveVolumeZone(0, thresholds)).toEqual({ zone: 'quiet', label: 'Speak up' });
    expect(deriveVolumeZone(29, thresholds)).toEqual({ zone: 'quiet', label: 'Speak up' });
  });

  it('returns normal zone between quiet and normal thresholds', () => {
    expect(deriveVolumeZone(30, thresholds)).toEqual({ zone: 'normal', label: 'Good' });
    expect(deriveVolumeZone(49, thresholds)).toEqual({ zone: 'normal', label: 'Good' });
  });

  it('returns warning zone between normal and warning thresholds', () => {
    expect(deriveVolumeZone(50, thresholds)).toEqual({ zone: 'warning', label: 'Loud' });
    expect(deriveVolumeZone(77, thresholds)).toEqual({ zone: 'warning', label: 'Loud' });
  });

  it('returns danger zone at or above warningThreshold', () => {
    expect(deriveVolumeZone(78, thresholds)).toEqual({ zone: 'danger', label: 'Too loud!' });
    expect(deriveVolumeZone(100, thresholds)).toEqual({ zone: 'danger', label: 'Too loud!' });
  });

  it('handles edge case where volume is exactly at threshold', () => {
    expect(deriveVolumeZone(30, thresholds).zone).toBe('normal');
    expect(deriveVolumeZone(50, thresholds).zone).toBe('warning');
    expect(deriveVolumeZone(78, thresholds).zone).toBe('danger');
  });

  it('works with custom thresholds', () => {
    const custom = { quietThreshold: 10, normalThreshold: 50, warningThreshold: 90 };
    expect(deriveVolumeZone(5, custom).zone).toBe('quiet');
    expect(deriveVolumeZone(30, custom).zone).toBe('normal');
    expect(deriveVolumeZone(70, custom).zone).toBe('warning');
    expect(deriveVolumeZone(95, custom).zone).toBe('danger');
  });
});

describe('volumeToDbString', () => {
  it('returns "-- dB" for zero volume', () => {
    expect(volumeToDbString(0)).toBe('-- dB');
  });

  it('returns "-- dB" for negative volume', () => {
    expect(volumeToDbString(-5)).toBe('-- dB');
  });

  it('returns "100 dB" for full volume (100)', () => {
    // volume=100 → 30 + (100/100)*70 = 100
    expect(volumeToDbString(100)).toBe('100 dB');
  });

  it('returns approximately 31 dB for very low volume', () => {
    // volume=1 → 30 + (1/100)*70 = 30.7 → rounds to 31
    expect(volumeToDbString(1)).toBe('31 dB');
  });

  it('returns approximately 65 dB for mid-range volume', () => {
    // volume=50 → 30 + (50/100)*70 = 65
    expect(volumeToDbString(50)).toBe('65 dB');
  });

  it('includes " dB" suffix for all non-zero values', () => {
    expect(volumeToDbString(25)).toMatch(/dB$/);
    expect(volumeToDbString(75)).toMatch(/dB$/);
  });
});
