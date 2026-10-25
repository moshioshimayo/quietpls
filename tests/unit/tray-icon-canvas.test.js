import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadModule() {
  const modPath = require.resolve('../../tray-icon-canvas');
  delete require.cache[modPath];
  return require('../../tray-icon-canvas');
}

/**
 * Create a mock Canvas 2D rendering context that records calls.
 */
function createMockCtx() {
  const calls = [];
  const record = (name) => (...args) => calls.push({ name, args });

  return {
    calls,
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arcTo: record('arcTo'),
    closePath: record('closePath'),
    fill: record('fill'),
    fillStyle: '',
    // Helper: count how many fill() calls were made (one per bar)
    get fillCount() {
      return calls.filter((c) => c.name === 'fill').length;
    },
  };
}

describe('tray-icon-canvas', () => {
  let mod;

  beforeEach(() => {
    mod = loadModule();
  });

  // ---- getColorForZone ----

  describe('getColorForZone', () => {
    it('returns amber for quiet zone', () => {
      expect(mod.getColorForZone('quiet')).toBe('#f59e0b');
    });

    it('returns cyan for normal zone', () => {
      expect(mod.getColorForZone('normal')).toBe('#06b6d4');
    });

    it('returns red for loud zone', () => {
      expect(mod.getColorForZone('loud')).toBe('#ef4444');
    });

    it('returns dark red for danger zone', () => {
      expect(mod.getColorForZone('danger')).toBe('#dc2626');
    });

    it('returns gray for inactive zone', () => {
      expect(mod.getColorForZone('inactive')).toBe('#6b7280');
    });

    it('falls back to gray for unknown zone', () => {
      expect(mod.getColorForZone('bogus')).toBe('#6b7280');
      expect(mod.getColorForZone('')).toBe('#6b7280');
      expect(mod.getColorForZone(undefined)).toBe('#6b7280');
    });
  });

  // ---- drawTrayIcon ----

  describe('drawTrayIcon', () => {
    it('clears the canvas before drawing', () => {
      const ctx = createMockCtx();
      mod.drawTrayIcon(ctx, 44, 44, 50, 'normal', [50]);
      expect(ctx.calls[0]).toEqual({ name: 'clearRect', args: [0, 0, 44, 44] });
    });

    it('draws BAR_COUNT bars (fills)', () => {
      const ctx = createMockCtx();
      mod.drawTrayIcon(ctx, 44, 44, 50, 'normal', [10, 20, 30, 40, 50]);
      expect(ctx.fillCount).toBe(mod.BAR_COUNT);
    });

    it('sets fillStyle to zone colour', () => {
      const ctx = createMockCtx();
      mod.drawTrayIcon(ctx, 44, 44, 80, 'loud', [80]);
      expect(ctx.fillStyle).toBe('#ef4444');
    });

    it('handles zero volume without errors', () => {
      const ctx = createMockCtx();
      expect(() => mod.drawTrayIcon(ctx, 44, 44, 0, 'quiet', [0, 0, 0])).not.toThrow();
      expect(ctx.fillCount).toBe(mod.BAR_COUNT);
    });

    it('handles max volume (100) without errors', () => {
      const ctx = createMockCtx();
      expect(() => mod.drawTrayIcon(ctx, 44, 44, 100, 'danger', [100, 100, 100, 100, 100])).not.toThrow();
      expect(ctx.fillCount).toBe(mod.BAR_COUNT);
    });

    it('handles empty history array', () => {
      const ctx = createMockCtx();
      expect(() => mod.drawTrayIcon(ctx, 44, 44, 0, 'inactive', [])).not.toThrow();
      expect(ctx.fillCount).toBe(mod.BAR_COUNT);
    });

    it('handles null/undefined history', () => {
      const ctx = createMockCtx();
      expect(() => mod.drawTrayIcon(ctx, 44, 44, 50, 'normal', null)).not.toThrow();
      expect(ctx.fillCount).toBe(mod.BAR_COUNT);

      const ctx2 = createMockCtx();
      expect(() => mod.drawTrayIcon(ctx2, 44, 44, 50, 'normal', undefined)).not.toThrow();
      expect(ctx2.fillCount).toBe(mod.BAR_COUNT);
    });

    it('handles history longer than BAR_COUNT (takes most recent)', () => {
      const ctx = createMockCtx();
      const longHistory = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      expect(() => mod.drawTrayIcon(ctx, 44, 44, 100, 'danger', longHistory)).not.toThrow();
      expect(ctx.fillCount).toBe(mod.BAR_COUNT);
    });

    it('clamps negative volume to 0', () => {
      const ctx = createMockCtx();
      expect(() => mod.drawTrayIcon(ctx, 44, 44, -10, 'quiet', [-10, -5])).not.toThrow();
      expect(ctx.fillCount).toBe(mod.BAR_COUNT);
    });

    it('clamps volume above 100', () => {
      const ctx = createMockCtx();
      expect(() => mod.drawTrayIcon(ctx, 44, 44, 150, 'danger', [150, 200])).not.toThrow();
      expect(ctx.fillCount).toBe(mod.BAR_COUNT);
    });

    it('works at 1x resolution (22x22)', () => {
      const ctx = createMockCtx();
      expect(() => mod.drawTrayIcon(ctx, 22, 22, 50, 'normal', [50])).not.toThrow();
      expect(ctx.fillCount).toBe(mod.BAR_COUNT);
    });

    it('uses danger colour for danger zone', () => {
      const ctx = createMockCtx();
      mod.drawTrayIcon(ctx, 44, 44, 95, 'danger', [95]);
      expect(ctx.fillStyle).toBe('#dc2626');
    });
  });

  // ---- ZONE_COLORS constant ----

  describe('ZONE_COLORS', () => {
    it('exports all required zone colours', () => {
      expect(mod.ZONE_COLORS).toHaveProperty('quiet');
      expect(mod.ZONE_COLORS).toHaveProperty('normal');
      expect(mod.ZONE_COLORS).toHaveProperty('loud');
      expect(mod.ZONE_COLORS).toHaveProperty('danger');
      expect(mod.ZONE_COLORS).toHaveProperty('inactive');
    });
  });
});
