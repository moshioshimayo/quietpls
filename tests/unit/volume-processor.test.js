import { describe, it, expect } from 'vitest';

// Extract the volume computation logic from volume-processor.js for testing.
// The AudioWorkletProcessor class is not available in Node, so we replicate
// the exact same math here — any change to volume-processor.js must be
// mirrored in these helpers (or the processor should be refactored to
// export pure functions).

function computeRms(samples) {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length) * 100;
}

function mapVolume(rms) {
  let volume;
  if (rms < 0.3) {
    volume = rms * 16.67;
  } else if (rms < 1) {
    volume = 5 + ((rms - 0.3) / 0.7) * 15;
  } else if (rms < 2) {
    volume = 20 + ((rms - 1) / 1) * 15;
  } else if (rms < 3.5) {
    volume = 35 + ((rms - 2) / 1.5) * 30;
  } else if (rms < 5) {
    volume = 65 + ((rms - 3.5) / 1.5) * 20;
  } else {
    volume = 85 + Math.min((rms - 5) * 10, 15);
  }
  return Math.min(100, Math.max(0, volume));
}

describe('VolumeProcessor', () => {
  describe('RMS calculation', () => {
    it('should return 0 for all-zero samples', () => {
      const samples = new Float32Array(128).fill(0);
      expect(computeRms(samples)).toBe(0);
    });

    it('should return ~50 for all-0.5 samples', () => {
      const samples = new Float32Array(128).fill(0.5);
      const rms = computeRms(samples);
      // RMS of constant 0.5 = 0.5 * 100 = 50
      expect(rms).toBeCloseTo(50, 1);
    });

    it('should return 100 for all-1.0 samples', () => {
      const samples = new Float32Array(128).fill(1.0);
      const rms = computeRms(samples);
      expect(rms).toBeCloseTo(100, 1);
    });

    it('should handle negative samples correctly', () => {
      const samples = new Float32Array(128).fill(-0.5);
      const rms = computeRms(samples);
      // RMS of constant -0.5 = 0.5 * 100 = 50 (same as positive)
      expect(rms).toBeCloseTo(50, 1);
    });

    it('should handle mixed samples', () => {
      // Alternating +0.5 and -0.5 should give same RMS as constant 0.5
      const samples = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        samples[i] = i % 2 === 0 ? 0.5 : -0.5;
      }
      const rms = computeRms(samples);
      expect(rms).toBeCloseTo(50, 1);
    });
  });

  describe('Piecewise mapping', () => {
    it('should map rms=0 to volume=0', () => {
      expect(mapVolume(0)).toBe(0);
    });

    it('should map rms=0.3 boundary to volume=~5', () => {
      // At rms=0.3: volume = 0.3 * 16.67 = 5.001
      expect(mapVolume(0.3)).toBeCloseTo(5, 0);
    });

    it('should map rms=1.0 boundary to volume=20', () => {
      // At rms=1.0: volume = 5 + ((1.0 - 0.3) / 0.7) * 15 = 5 + 15 = 20
      expect(mapVolume(1.0)).toBeCloseTo(20, 0);
    });

    it('should map rms=2.0 boundary to volume=35', () => {
      // At rms=2.0: volume = 20 + ((2.0 - 1) / 1) * 15 = 20 + 15 = 35
      expect(mapVolume(2.0)).toBeCloseTo(35, 0);
    });

    it('should map rms=3.5 boundary to volume=65', () => {
      // At rms=3.5: volume = 35 + ((3.5 - 2) / 1.5) * 30 = 35 + 30 = 65
      expect(mapVolume(3.5)).toBeCloseTo(65, 0);
    });

    it('should map rms=5.0 boundary to volume=85', () => {
      // At rms=5.0: volume = 65 + ((5.0 - 3.5) / 1.5) * 20 = 65 + 20 = 85
      expect(mapVolume(5.0)).toBeCloseTo(85, 0);
    });

    it('should map very high rms to capped 100', () => {
      // At rms=6.5: volume = 85 + min((6.5-5)*10, 15) = 85 + 15 = 100
      expect(mapVolume(6.5)).toBe(100);
      // Even higher should still be 100
      expect(mapVolume(50)).toBe(100);
      expect(mapVolume(100)).toBe(100);
    });

    it('should clamp output to 0-100 range', () => {
      // Low end
      expect(mapVolume(0)).toBeGreaterThanOrEqual(0);
      // High end
      expect(mapVolume(1000)).toBeLessThanOrEqual(100);
    });

    it('should produce continuous values within tiers', () => {
      // Mid-point of tier 2 (rms=0.65): volume = 5 + ((0.65-0.3)/0.7)*15 = 5 + 7.5 = 12.5
      expect(mapVolume(0.65)).toBeCloseTo(12.5, 1);

      // Mid-point of tier 4 (rms=2.75): volume = 35 + ((2.75-2)/1.5)*30 = 35 + 15 = 50
      expect(mapVolume(2.75)).toBeCloseTo(50, 1);
    });
  });

  describe('End-to-end: samples to volume', () => {
    it('should produce 0 volume for silence', () => {
      const samples = new Float32Array(128).fill(0);
      const rms = computeRms(samples);
      const volume = mapVolume(rms);
      expect(volume).toBe(0);
    });

    it('should produce high volume for loud input', () => {
      const samples = new Float32Array(128).fill(0.8);
      const rms = computeRms(samples);
      const volume = mapVolume(rms);
      // rms = 80, well above 5 threshold -> volume should be 100
      expect(volume).toBe(100);
    });
  });
});
