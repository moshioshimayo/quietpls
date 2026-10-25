import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadModule() {
  const modPath = require.resolve('../../micro-animations');
  delete require.cache[modPath];
  return require('../../micro-animations');
}

describe('micro-animations', () => {
  let mod;

  beforeEach(() => {
    mod = loadModule();
  });

  // ---- WIDGET_STATES ----

  describe('WIDGET_STATES', () => {
    it('should export all four widget states', () => {
      expect(mod.WIDGET_STATES.COMPACT).toBe('compact');
      expect(mod.WIDGET_STATES.EXPANDED).toBe('expanded');
      expect(mod.WIDGET_STATES.ALERT).toBe('alert');
      expect(mod.WIDGET_STATES.SESSION_COMPLETE).toBe('sessionComplete');
    });

    it('should be frozen (immutable)', () => {
      expect(Object.isFrozen(mod.WIDGET_STATES)).toBe(true);
    });
  });

  // ---- getTransitionClasses ----

  describe('getTransitionClasses', () => {
    it('compact → expanded returns spring-in entrance', () => {
      const result = mod.getTransitionClasses('compact', 'expanded');
      expect(result.entrance).toBe('animate-spring-in');
      expect(result.exit).toBe('transitioning-out');
    });

    it('expanded → alert returns danger-shake entrance', () => {
      const result = mod.getTransitionClasses('expanded', 'alert');
      expect(result.entrance).toBe('animate-danger-shake');
      expect(result.exit).toBe('transitioning-out');
    });

    it('alert → expanded returns glow-shift entrance', () => {
      const result = mod.getTransitionClasses('alert', 'expanded');
      expect(result.entrance).toBe('animate-glow-shift');
      expect(result.exit).toBe('transitioning-out');
    });

    it('expanded → sessionComplete returns celebration-bounce entrance', () => {
      const result = mod.getTransitionClasses('expanded', 'sessionComplete');
      expect(result.entrance).toBe('animate-celebration-bounce');
    });

    it('alert → sessionComplete returns celebration-bounce entrance', () => {
      const result = mod.getTransitionClasses('alert', 'sessionComplete');
      expect(result.entrance).toBe('animate-celebration-bounce');
    });

    it('sessionComplete → compact returns slide-down-fade exit and spring-in entrance', () => {
      const result = mod.getTransitionClasses('sessionComplete', 'compact');
      expect(result.exit).toBe('animate-slide-down-fade');
      expect(result.entrance).toBe('animate-spring-in');
    });

    it('unknown transition returns default fade classes', () => {
      const result = mod.getTransitionClasses('unknown', 'also-unknown');
      expect(result.exit).toBe('transitioning-out');
      expect(result.entrance).toBe('transitioning-in');
    });
  });

  // ---- getGlowColorsForZone ----

  describe('getGlowColorsForZone', () => {
    it('returns quiet zone colors for "quiet"', () => {
      const colors = mod.getGlowColorsForZone('quiet');
      expect(colors.glowColor).toContain('99, 102, 241');
    });

    it('returns normal zone colors for "normal"', () => {
      const colors = mod.getGlowColorsForZone('normal');
      expect(colors.glowColor).toContain('255, 105, 180');
    });

    it('returns danger zone colors for "danger"', () => {
      const colors = mod.getGlowColorsForZone('danger');
      expect(colors.glowColor).toContain('220, 38, 38');
    });

    it('returns loud zone colors for "warning" (alias)', () => {
      const colors = mod.getGlowColorsForZone('warning');
      expect(colors.glowColor).toContain('239, 68, 68');
    });

    it('falls back to quiet for unknown zone', () => {
      const colors = mod.getGlowColorsForZone('nonexistent');
      expect(colors.glowColor).toContain('99, 102, 241');
    });
  });

  // ---- isVolumeSpiking ----

  describe('isVolumeSpiking', () => {
    it('returns true when volume exceeds threshold', () => {
      expect(mod.isVolumeSpiking(80, 70)).toBe(true);
    });

    it('returns false when volume is at threshold', () => {
      expect(mod.isVolumeSpiking(70, 70)).toBe(false);
    });

    it('returns false when volume is below threshold', () => {
      expect(mod.isVolumeSpiking(50, 70)).toBe(false);
    });

    it('returns false for invalid inputs', () => {
      expect(mod.isVolumeSpiking(null, 70)).toBe(false);
      expect(mod.isVolumeSpiking(80, null)).toBe(false);
      expect(mod.isVolumeSpiking('high', 70)).toBe(false);
    });
  });

  // ---- computeGlowIntensity ----

  describe('computeGlowIntensity', () => {
    it('returns 0 for zero volume', () => {
      expect(mod.computeGlowIntensity(0)).toBe(0);
    });

    it('returns 1 for volume at or above 100', () => {
      expect(mod.computeGlowIntensity(100)).toBe(1);
      expect(mod.computeGlowIntensity(150)).toBe(1);
    });

    it('returns 0.5 for volume of 50', () => {
      expect(mod.computeGlowIntensity(50)).toBe(0.5);
    });

    it('returns 0 for negative or invalid input', () => {
      expect(mod.computeGlowIntensity(-10)).toBe(0);
      expect(mod.computeGlowIntensity(null)).toBe(0);
      expect(mod.computeGlowIntensity(undefined)).toBe(0);
    });
  });

  // ---- buildGlowShadow ----

  describe('buildGlowShadow', () => {
    it('returns a valid CSS box-shadow string', () => {
      const shadow = mod.buildGlowShadow('quiet', 0.5);
      expect(shadow).toMatch(/^0 0 \d+px rgba\(/);
    });

    it('increases spread with higher intensity', () => {
      const low = mod.buildGlowShadow('normal', 0.1);
      const high = mod.buildGlowShadow('normal', 0.9);
      // Extract spread values
      const lowSpread = parseInt(low.match(/0 0 (\d+)px/)[1], 10);
      const highSpread = parseInt(high.match(/0 0 (\d+)px/)[1], 10);
      expect(highSpread).toBeGreaterThan(lowSpread);
    });

    it('uses intense color when intensity > 0.6', () => {
      const shadow = mod.buildGlowShadow('danger', 0.8);
      // Danger intense color has 0.8 alpha
      expect(shadow).toContain('0.8');
    });

    it('uses normal color when intensity <= 0.6', () => {
      const shadow = mod.buildGlowShadow('danger', 0.3);
      // Danger normal color has 0.5 alpha
      expect(shadow).toContain('0.5');
    });
  });

  // ---- MANAGED_CLASSES ----

  describe('MANAGED_CLASSES', () => {
    it('contains all expected animation class names', () => {
      expect(mod.MANAGED_CLASSES).toContain('transitioning-out');
      expect(mod.MANAGED_CLASSES).toContain('transitioning-in');
      expect(mod.MANAGED_CLASSES).toContain('animate-spring-in');
      expect(mod.MANAGED_CLASSES).toContain('animate-danger-shake');
      expect(mod.MANAGED_CLASSES).toContain('animate-celebration-bounce');
      expect(mod.MANAGED_CLASSES).toContain('animate-slide-down-fade');
      expect(mod.MANAGED_CLASSES).toContain('volume-spike');
      expect(mod.MANAGED_CLASSES).toContain('glow-intense');
    });
  });
});
