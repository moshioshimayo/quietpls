import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadModule() {
  const modPath = require.resolve('../../session-animations');
  delete require.cache[modPath];
  return require('../../session-animations');
}

describe('session-animations', () => {
  let mod;

  beforeEach(() => {
    mod = loadModule();
  });

  // ---- ANIMATION_DEFAULTS ----

  describe('ANIMATION_DEFAULTS', () => {
    it('should export frozen animation timing constants', () => {
      expect(Object.isFrozen(mod.ANIMATION_DEFAULTS)).toBe(true);
    });

    it('should have a positive COUNT_UP_DURATION', () => {
      expect(mod.ANIMATION_DEFAULTS.COUNT_UP_DURATION).toBeGreaterThan(0);
    });

    it('should have a positive CELEBRATION_PARTICLE_COUNT', () => {
      expect(mod.ANIMATION_DEFAULTS.CELEBRATION_PARTICLE_COUNT).toBeGreaterThan(0);
    });

    // SCORECARD_SLIDE_DURATION was removed from ANIMATION_DEFAULTS
  });

  // ---- A_RANGE_GRADES ----

  describe('A_RANGE_GRADES', () => {
    it('should contain A+, A, and A-', () => {
      expect(mod.A_RANGE_GRADES).toContain('A+');
      expect(mod.A_RANGE_GRADES).toContain('A');
      expect(mod.A_RANGE_GRADES).toContain('A-');
    });

    it('should be frozen', () => {
      expect(Object.isFrozen(mod.A_RANGE_GRADES)).toBe(true);
    });

    it('should not contain B or C grades', () => {
      expect(mod.A_RANGE_GRADES).not.toContain('B+');
      expect(mod.A_RANGE_GRADES).not.toContain('C');
    });
  });

  // ---- isAGrade ----

  describe('isAGrade', () => {
    it('should return true for A+', () => {
      expect(mod.isAGrade('A+')).toBe(true);
    });

    it('should return true for A', () => {
      expect(mod.isAGrade('A')).toBe(true);
    });

    it('should return true for A-', () => {
      expect(mod.isAGrade('A-')).toBe(true);
    });

    it('should return false for B+', () => {
      expect(mod.isAGrade('B+')).toBe(false);
    });

    it('should return false for B', () => {
      expect(mod.isAGrade('B')).toBe(false);
    });

    it('should return false for C', () => {
      expect(mod.isAGrade('C')).toBe(false);
    });

    it('should return false for F', () => {
      expect(mod.isAGrade('F')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(mod.isAGrade(null)).toBe(false);
      expect(mod.isAGrade(undefined)).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(mod.isAGrade(95)).toBe(false);
      expect(mod.isAGrade({})).toBe(false);
    });
  });

  // ---- computeCountUpValue ----

  describe('computeCountUpValue', () => {
    it('should return 0 at elapsed=0', () => {
      expect(mod.computeCountUpValue(0, 800, 85)).toBe(0);
    });

    it('should return the target value when elapsed >= duration', () => {
      expect(mod.computeCountUpValue(800, 800, 85)).toBe(85);
    });

    it('should return the target value when elapsed exceeds duration', () => {
      expect(mod.computeCountUpValue(1200, 800, 85)).toBe(85);
    });

    it('should return an intermediate value at halfway point', () => {
      const midValue = mod.computeCountUpValue(400, 800, 100);
      // Ease-out cubic at t=0.5: 1 - (1 - 0.5)^3 = 1 - 0.125 = 0.875
      expect(midValue).toBe(88);
    });

    it('should return a rounded integer', () => {
      const value = mod.computeCountUpValue(200, 800, 73);
      expect(Number.isInteger(value)).toBe(true);
    });

    it('should handle targetValue of 0', () => {
      expect(mod.computeCountUpValue(400, 800, 0)).toBe(0);
    });

    it('should handle duration of 0 by returning target immediately', () => {
      expect(mod.computeCountUpValue(0, 0, 85)).toBe(85);
    });

    it('should handle non-number inputs gracefully', () => {
      expect(mod.computeCountUpValue(null, 800, 85)).toBe(0);
      expect(mod.computeCountUpValue(400, null, 85)).toBe(0);
      expect(mod.computeCountUpValue(400, 800, null)).toBe(0);
    });

    it('should produce monotonically increasing values over time', () => {
      const target = 100;
      const duration = 800;
      let prev = -1;
      for (let t = 0; t <= duration; t += 50) {
        const val = mod.computeCountUpValue(t, duration, target);
        expect(val).toBeGreaterThanOrEqual(prev);
        prev = val;
      }
    });
  });

  // ---- generateParticleProps ----

  describe('generateParticleProps', () => {
    it('should return an object with x, y, size, color, delay, angle', () => {
      const props = mod.generateParticleProps(0, 12, 320, 120);
      expect(props).toHaveProperty('x');
      expect(props).toHaveProperty('y');
      expect(props).toHaveProperty('size');
      expect(props).toHaveProperty('color');
      expect(props).toHaveProperty('delay');
      expect(props).toHaveProperty('angle');
    });

    it('should use colors from CONFETTI_COLORS', () => {
      const props = mod.generateParticleProps(0, 12, 320, 120);
      expect(mod.CONFETTI_COLORS).toContain(props.color);
    });

    it('should stagger delays based on index', () => {
      const p0 = mod.generateParticleProps(0, 12, 320, 120);
      const p1 = mod.generateParticleProps(1, 12, 320, 120);
      expect(p1.delay).toBeGreaterThan(p0.delay);
    });

    it('should spread particles across the container width', () => {
      const first = mod.generateParticleProps(0, 12, 320, 120);
      const last = mod.generateParticleProps(11, 12, 320, 120);
      expect(last.x).toBeGreaterThan(first.x);
    });

    it('should produce particle sizes between 4 and 8', () => {
      for (let i = 0; i < 12; i++) {
        const props = mod.generateParticleProps(i, 12, 320, 120);
        expect(props.size).toBeGreaterThanOrEqual(4);
        expect(props.size).toBeLessThanOrEqual(8);
      }
    });

    it('should handle a single particle (totalParticles=1)', () => {
      const props = mod.generateParticleProps(0, 1, 320, 120);
      // spreadFactor = 0.5 when totalParticles=1
      expect(props.x).toBe(160);
    });
  });

  // ---- buildParticleStyle ----

  describe('buildParticleStyle', () => {
    it('should return a CSS string with position:absolute', () => {
      const props = { x: 100, y: 120, size: 6, color: '#ff69b4', delay: 40, angle: 30 };
      const style = mod.buildParticleStyle(props);
      expect(style).toContain('position:absolute');
    });

    it('should include the particle color', () => {
      const props = { x: 100, y: 120, size: 6, color: '#22c55e', delay: 0, angle: 0 };
      const style = mod.buildParticleStyle(props);
      expect(style).toContain('background:#22c55e');
    });

    it('should use border-radius 50% for small particles (size <= 4)', () => {
      const props = { x: 100, y: 120, size: 4, color: '#ff69b4', delay: 0, angle: 0 };
      const style = mod.buildParticleStyle(props);
      expect(style).toContain('border-radius:50%');
    });

    it('should use border-radius 2px for larger particles (size > 4)', () => {
      const props = { x: 100, y: 120, size: 6, color: '#ff69b4', delay: 0, angle: 0 };
      const style = mod.buildParticleStyle(props);
      expect(style).toContain('border-radius:2px');
    });

    it('should include the confetti-particle animation name', () => {
      const props = { x: 100, y: 120, size: 6, color: '#ff69b4', delay: 40, angle: 0 };
      const style = mod.buildParticleStyle(props);
      expect(style).toContain('confetti-particle');
    });

    it('should include the animation delay value', () => {
      const props = { x: 100, y: 120, size: 6, color: '#ff69b4', delay: 120, angle: 0 };
      const style = mod.buildParticleStyle(props);
      expect(style).toContain('120ms');
    });
  });

  // ---- CONFETTI_COLORS ----

  describe('CONFETTI_COLORS', () => {
    it('should be a frozen array of color strings', () => {
      expect(Object.isFrozen(mod.CONFETTI_COLORS)).toBe(true);
      expect(Array.isArray(mod.CONFETTI_COLORS)).toBe(true);
    });

    it('should contain at least 4 colors', () => {
      expect(mod.CONFETTI_COLORS.length).toBeGreaterThanOrEqual(4);
    });

    it('should contain hex color strings', () => {
      for (const color of mod.CONFETTI_COLORS) {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });
  });
});
