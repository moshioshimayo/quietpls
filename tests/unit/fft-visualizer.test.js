import { describe, it, expect } from 'vitest';

/**
 * US-008: FFT Spectrum Visualization Renderer — Unit Tests
 *
 * Tests for color palette selection, interpolation math,
 * height multiplier logic, and frequency bin downsampling.
 */

// Import the module (CJS export)
const {
  getColorPalette,
  lerp,
  getHeightMultiplier,
  downsampleBins,
  COLOR_PALETTES,
  BAR_COUNT,
  BIN_STRIDE,
  FADE_DURATION_MS,
  MIN_BAR_HEIGHT,
  LOUD_HEIGHT_MULT,
} = require('../../fft-visualizer.js');

// ─────────────────────────────────────────────────────────────────────
// Color Palette Selection
// ─────────────────────────────────────────────────────────────────────
describe('FFT Visualizer — Color Palette Selection (US-008)', () => {
  it('should return quiet palette for "quiet" zone', () => {
    const palette = getColorPalette('quiet');
    expect(palette.primary).toBe('#f59e0b');
    expect(palette.secondary).toBe('#d97706');
    expect(palette.glow).toBe('rgba(245, 158, 11, 0.4)');
  });

  it('should return normal palette for "normal" zone', () => {
    const palette = getColorPalette('normal');
    expect(palette.primary).toBe('#06b6d4');
    expect(palette.secondary).toBe('#0ea5e9');
  });

  it('should return loud palette for "loud" zone', () => {
    const palette = getColorPalette('loud');
    expect(palette.primary).toBe('#ef4444');
    expect(palette.secondary).toBe('#f97316');
  });

  it('should return danger palette for "danger" zone', () => {
    const palette = getColorPalette('danger');
    expect(palette.primary).toBe('#dc2626');
    expect(palette.secondary).toBe('#b91c1c');
  });

  it('should fall back to quiet palette for unknown zone', () => {
    const palette = getColorPalette('nonexistent');
    expect(palette).toEqual(COLOR_PALETTES.quiet);
  });

  it('should fall back to quiet palette for undefined zone', () => {
    const palette = getColorPalette(undefined);
    expect(palette).toEqual(COLOR_PALETTES.quiet);
  });

  it('should fall back to quiet palette for null zone', () => {
    const palette = getColorPalette(null);
    expect(palette).toEqual(COLOR_PALETTES.quiet);
  });

  it('all four zone palettes should have primary, secondary, and glow', () => {
    for (const zone of ['quiet', 'normal', 'loud', 'danger']) {
      const p = COLOR_PALETTES[zone];
      expect(p).toHaveProperty('primary');
      expect(p).toHaveProperty('secondary');
      expect(p).toHaveProperty('glow');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Interpolation Math (lerp)
// ─────────────────────────────────────────────────────────────────────
describe('FFT Visualizer — lerp (US-008)', () => {
  it('should return a when t=0', () => {
    expect(lerp(10, 20, 0)).toBe(10);
  });

  it('should return b when t=1', () => {
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it('should return midpoint when t=0.5', () => {
    expect(lerp(0, 100, 0.5)).toBe(50);
  });

  it('should handle negative values', () => {
    expect(lerp(-10, 10, 0.5)).toBe(0);
  });

  it('should extrapolate for t > 1', () => {
    expect(lerp(0, 10, 2)).toBe(20);
  });

  it('should extrapolate for t < 0', () => {
    expect(lerp(0, 10, -1)).toBe(-10);
  });

  it('should return exact value when a equals b', () => {
    expect(lerp(5, 5, 0.7)).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Height Multiplier
// ─────────────────────────────────────────────────────────────────────
describe('FFT Visualizer — Height Multiplier (US-008)', () => {
  it('should return 1.0 for quiet zone', () => {
    expect(getHeightMultiplier('quiet')).toBe(1.0);
  });

  it('should return 1.0 for normal zone', () => {
    expect(getHeightMultiplier('normal')).toBe(1.0);
  });

  it('should return LOUD_HEIGHT_MULT for loud zone', () => {
    expect(getHeightMultiplier('loud')).toBe(LOUD_HEIGHT_MULT);
    expect(getHeightMultiplier('loud')).toBeGreaterThan(1.0);
  });

  it('should return LOUD_HEIGHT_MULT for danger zone', () => {
    expect(getHeightMultiplier('danger')).toBe(LOUD_HEIGHT_MULT);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Frequency Bin Downsampling
// ─────────────────────────────────────────────────────────────────────
describe('FFT Visualizer — downsampleBins (US-008)', () => {
  it('should produce the correct number of bars', () => {
    const data = new Uint8Array(256).fill(128);
    const bars = downsampleBins(data, 40, 6);
    expect(bars).toHaveLength(40);
  });

  it('should average bins correctly for uniform data', () => {
    const data = new Uint8Array(256).fill(200);
    const bars = downsampleBins(data, 40, 6);
    bars.forEach(bar => {
      expect(bar).toBe(200);
    });
  });

  it('should compute averages for varying data', () => {
    const data = new Uint8Array(256).fill(0);
    // First 6 bins: 0, 10, 20, 30, 40, 50 => average = 25
    data[0] = 0; data[1] = 10; data[2] = 20;
    data[3] = 30; data[4] = 40; data[5] = 50;
    const bars = downsampleBins(data, 40, 6);
    expect(bars[0]).toBe(25);
  });

  it('should handle data shorter than barCount * binStride', () => {
    // Only 10 bins — some bars will read beyond end
    const data = new Uint8Array(10).fill(100);
    const bars = downsampleBins(data, 4, 6);
    expect(bars).toHaveLength(4);
    // First bar: bins 0-5 = avg 100
    expect(bars[0]).toBe(100);
    // Second bar: bins 6-9 (only 4 of 6) = avg 100
    expect(bars[1]).toBe(100);
    // Third bar: bins 12-17 => all out of range => 0
    expect(bars[2]).toBe(0);
  });

  it('should return 0 for empty data', () => {
    const data = new Uint8Array(0);
    const bars = downsampleBins(data, 4, 6);
    bars.forEach(bar => {
      expect(bar).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Constants Sanity Checks
// ─────────────────────────────────────────────────────────────────────
describe('FFT Visualizer — Constants (US-008)', () => {
  it('BAR_COUNT should be between 32 and 48', () => {
    expect(BAR_COUNT).toBeGreaterThanOrEqual(32);
    expect(BAR_COUNT).toBeLessThanOrEqual(48);
  });

  it('BIN_STRIDE should cover most of 256 bins', () => {
    expect(BAR_COUNT * BIN_STRIDE).toBeLessThanOrEqual(256);
    expect(BAR_COUNT * BIN_STRIDE).toBeGreaterThanOrEqual(192);
  });

  it('FADE_DURATION_MS should be ~500ms', () => {
    expect(FADE_DURATION_MS).toBe(500);
  });

  it('MIN_BAR_HEIGHT should be positive', () => {
    expect(MIN_BAR_HEIGHT).toBeGreaterThan(0);
  });

  it('LOUD_HEIGHT_MULT should be > 1', () => {
    expect(LOUD_HEIGHT_MULT).toBeGreaterThan(1.0);
  });
});
