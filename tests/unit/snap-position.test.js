import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadModule() {
  const modPath = require.resolve('../../snap-position');
  delete require.cache[modPath];
  return require('../../snap-position');
}

describe('snap-position', () => {
  let getSnapAnchors;
  let calculateSnapX;

  beforeEach(() => {
    const mod = loadModule();
    getSnapAnchors = mod.getSnapAnchors;
    calculateSnapX = mod.calculateSnapX;
  });

  // ---- Exports ----

  describe('module exports', () => {
    it('exports getSnapAnchors as a function', () => {
      expect(typeof getSnapAnchors).toBe('function');
    });

    it('exports calculateSnapX as a function', () => {
      expect(typeof calculateSnapX).toBe('function');
    });
  });

  // ---- getSnapAnchors ----

  describe('getSnapAnchors', () => {
    it('returns three anchor X positions for a 1440px screen with 120px window', () => {
      const anchors = getSnapAnchors(1440, 120);
      // leftCenter:  1440 * 0.25 - 60 = 300
      // center:      1440 * 0.50 - 60 = 660
      // rightCenter: 1440 * 0.75 - 60 = 1020
      expect(anchors).toEqual({
        leftCenter: 300,
        center: 660,
        rightCenter: 1020,
      });
    });

    it('returns correct anchors for a 1920px screen with 120px window', () => {
      const anchors = getSnapAnchors(1920, 120);
      expect(anchors).toEqual({
        leftCenter: 420,
        center: 900,
        rightCenter: 1380,
      });
    });

    it('handles odd screen width with rounding', () => {
      const anchors = getSnapAnchors(1001, 120);
      // leftCenter:  round(250.25 - 60) = round(190.25) = 190
      // center:      round(500.5 - 60) = round(440.5) = 441
      // rightCenter: round(750.75 - 60) = round(690.75) = 691
      expect(anchors.leftCenter).toBe(190);
      expect(anchors.center).toBe(441);
      expect(anchors.rightCenter).toBe(691);
    });

    it('handles different window widths', () => {
      const anchors = getSnapAnchors(1440, 200);
      // leftCenter:  1440 * 0.25 - 100 = 260
      // center:      1440 * 0.50 - 100 = 620
      // rightCenter: 1440 * 0.75 - 100 = 980
      expect(anchors).toEqual({
        leftCenter: 260,
        center: 620,
        rightCenter: 980,
      });
    });
  });

  // ---- calculateSnapX ----

  describe('calculateSnapX', () => {
    const SCREEN_WIDTH = 1440;
    const WINDOW_WIDTH = 120;

    it('snaps to center when window is near the center', () => {
      // center anchor X = 660
      const result = calculateSnapX(650, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(result).toBe(660);
    });

    it('snaps to left-center when window is on the far left', () => {
      // leftCenter anchor X = 300
      const result = calculateSnapX(0, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(result).toBe(300);
    });

    it('snaps to right-center when window is on the far right', () => {
      // rightCenter anchor X = 1020
      const result = calculateSnapX(1300, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(result).toBe(1020);
    });

    it('snaps to leftCenter when exactly at leftCenter position', () => {
      const result = calculateSnapX(300, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(result).toBe(300);
    });

    it('snaps to center when exactly at center position', () => {
      const result = calculateSnapX(660, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(result).toBe(660);
    });

    it('snaps to rightCenter when exactly at rightCenter position', () => {
      const result = calculateSnapX(1020, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(result).toBe(1020);
    });

    it('chooses nearest anchor at boundary between left-center and center', () => {
      // Midpoint between leftCenter(300) center and center(660) center is at
      // (300+60 + 660+60)/2 = 540 window center => window X = 540-60 = 480
      // At X=479, closer to leftCenter; at X=481, closer to center
      const nearLeft = calculateSnapX(470, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(nearLeft).toBe(300);

      const nearCenter = calculateSnapX(490, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(nearCenter).toBe(660);
    });

    it('chooses nearest anchor at boundary between center and right-center', () => {
      // Midpoint between center(660) and rightCenter(1020) centers:
      // (660+60 + 1020+60)/2 = 900 center => window X = 900-60 = 840
      const nearCenter = calculateSnapX(830, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(nearCenter).toBe(660);

      const nearRight = calculateSnapX(850, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(nearRight).toBe(1020);
    });

    it('works with a different screen size (1920px)', () => {
      // leftCenter = 420, center = 900, rightCenter = 1380
      const result = calculateSnapX(100, 1920, 120);
      expect(result).toBe(420);
    });

    it('works with negative window position (off-screen left)', () => {
      const result = calculateSnapX(-50, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(result).toBe(300); // snaps to leftCenter
    });

    it('works with window past screen width (off-screen right)', () => {
      const result = calculateSnapX(1500, SCREEN_WIDTH, WINDOW_WIDTH);
      expect(result).toBe(1020); // snaps to rightCenter
    });
  });
});
