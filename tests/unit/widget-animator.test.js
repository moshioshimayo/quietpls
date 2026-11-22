import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadModule() {
  const modPath = require.resolve('../../widget-animator');
  delete require.cache[modPath];
  // Also reload the state machine dependency to ensure clean state
  const smPath = require.resolve('../../widget-state-machine');
  delete require.cache[smPath];
  return require('../../widget-animator');
}

function loadStateMachine() {
  const smPath = require.resolve('../../widget-state-machine');
  delete require.cache[smPath];
  return require('../../widget-state-machine');
}

/**
 * Create a mock BrowserWindow with getBounds/setBounds tracking.
 */
function createMockWindow(initialBounds) {
  const bounds = { ...initialBounds };
  let destroyed = false;
  return {
    getBounds() {
      return { ...bounds };
    },
    setBounds(newBounds) {
      Object.assign(bounds, newBounds);
    },
    isDestroyed() {
      return destroyed;
    },
    _destroy() {
      destroyed = true;
    },
    _getBoundsRef() {
      return bounds;
    },
  };
}

describe('widget-animator', () => {
  let mod;

  beforeEach(() => {
    vi.useFakeTimers();
    mod = loadModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Module exports ----

  describe('module exports', () => {
    it('exports createWidgetAnimator as a function', () => {
      expect(typeof mod.createWidgetAnimator).toBe('function');
    });

    it('exports STATE_BOUNDS for the three states (no alert state)', () => {
      expect(Object.keys(mod.STATE_BOUNDS).sort()).toEqual(['compact', 'expanded', 'sessionComplete']);
    });

    it('exports animation constants', () => {
      expect(mod.ANIMATION_DURATION_MS).toBe(350);
      expect(mod.FRAME_INTERVAL_MS).toBe(16);
      expect(mod.TOTAL_FRAMES).toBeGreaterThan(0);
    });

    it('exports easeOutCubic, calculateTargetBounds, interpolateBounds', () => {
      expect(typeof mod.easeOutCubic).toBe('function');
      expect(typeof mod.calculateTargetBounds).toBe('function');
      expect(typeof mod.interpolateBounds).toBe('function');
    });
  });

  // ---- STATE_BOUNDS ----

  describe('STATE_BOUNDS', () => {
    it('compact has correct dimensions', () => {
      expect(mod.STATE_BOUNDS.compact).toEqual({ width: 188, height: 32 });
    });

    it('expanded has correct dimensions', () => {
      // Details/calibration: fixed 320x240 content, including padding/border.
      expect(mod.STATE_BOUNDS.expanded).toEqual({ width: 320, height: 240 });
    });

    it('sessionComplete has correct dimensions', () => {
      expect(mod.STATE_BOUNDS.sessionComplete).toEqual({ width: 300, height: 120 });
    });
  });

  // ---- easeOutCubic ----

  describe('easeOutCubic', () => {
    it('returns 0 at t=0', () => {
      expect(mod.easeOutCubic(0)).toBe(0);
    });

    it('returns 1 at t=1', () => {
      expect(mod.easeOutCubic(1)).toBe(1);
    });

    it('returns 0.5 < result < 1 at t=0.5 (ease-out curves fast early)', () => {
      const result = mod.easeOutCubic(0.5);
      expect(result).toBeGreaterThan(0.5);
      expect(result).toBeLessThan(1);
    });

    it('is monotonically increasing', () => {
      let prev = 0;
      for (let t = 0.1; t <= 1.0; t += 0.1) {
        const val = mod.easeOutCubic(t);
        expect(val).toBeGreaterThan(prev);
        prev = val;
      }
    });
  });

  // ---- calculateTargetBounds ----

  describe('calculateTargetBounds', () => {
    it('centers the compact state on the given centerX', () => {
      const bounds = mod.calculateTargetBounds('compact', 500, 60);
      expect(bounds.width).toBe(188);
      expect(bounds.height).toBe(32);
      // x = 500 - 188/2 = 406
      expect(bounds.x).toBe(406);
      expect(bounds.y).toBe(60);
    });

    it('centers the expanded state on the given centerX', () => {
      const bounds = mod.calculateTargetBounds('expanded', 500, 60);
      expect(bounds.width).toBe(320);
      expect(bounds.height).toBe(240);
      // x = 500 - 320/2 = 340
      expect(bounds.x).toBe(340);
      expect(bounds.y).toBe(60);
    });

    it('centers the sessionComplete state on the given centerX', () => {
      const bounds = mod.calculateTargetBounds('sessionComplete', 500, 60);
      expect(bounds.width).toBe(300);
      expect(bounds.height).toBe(120);
      // x = 500 - 300/2 = 350
      expect(bounds.x).toBe(350);
      expect(bounds.y).toBe(60);
    });

    it('rounds x to nearest integer for odd-width centering', () => {
      // centerX=101, expanded width=320 → 101 - 160 = -59 (exact)
      const bounds = mod.calculateTargetBounds('expanded', 101, 10);
      expect(bounds.x).toBe(-59);
      expect(Number.isInteger(bounds.x)).toBe(true);
    });

    it('throws for unknown state', () => {
      expect(() => mod.calculateTargetBounds('unknown', 500, 60)).toThrow('Unknown widget state');
    });
  });

  // ---- interpolateBounds ----

  describe('interpolateBounds', () => {
    const start = { x: 406, y: 60, width: 188, height: 32 };
    const end = { x: 340, y: 60, width: 320, height: 240 };

    it('returns start bounds at progress 0', () => {
      expect(mod.interpolateBounds(start, end, 0)).toEqual(start);
    });

    it('returns end bounds at progress 1', () => {
      expect(mod.interpolateBounds(start, end, 1)).toEqual(end);
    });

    it('returns midpoint at progress 0.5', () => {
      const mid = mod.interpolateBounds(start, end, 0.5);
      expect(mid.x).toBe(373);          // 406 + (340-406)*0.5
      expect(mid.y).toBe(60);
      expect(mid.width).toBe(254);       // 188 + (320-188)*0.5
      expect(mid.height).toBe(136);      // 32 + (240-32)*0.5
    });

    it('always returns integer values', () => {
      const result = mod.interpolateBounds(start, end, 0.33);
      expect(Number.isInteger(result.x)).toBe(true);
      expect(Number.isInteger(result.y)).toBe(true);
      expect(Number.isInteger(result.width)).toBe(true);
      expect(Number.isInteger(result.height)).toBe(true);
    });
  });

  // ---- createWidgetAnimator ----

  describe('createWidgetAnimator', () => {
    it('throws if no BrowserWindow provided', () => {
      expect(() => mod.createWidgetAnimator(null)).toThrow('requires a BrowserWindow');
      expect(() => mod.createWidgetAnimator(undefined)).toThrow('requires a BrowserWindow');
    });

    it('returns an object with transitionTo, connectStateMachine, destroy', () => {
      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);
      expect(typeof animator.transitionTo).toBe('function');
      expect(typeof animator.connectStateMachine).toBe('function');
      expect(typeof animator.destroy).toBe('function');
    });
  });

  // ---- transitionTo animation ----

  describe('transitionTo', () => {
    it('animates window from compact to expanded over multiple frames', () => {
      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);
      const setBoundsSpy = vi.spyOn(win, 'setBounds');

      animator.transitionTo('expanded');

      // Advance one frame
      vi.advanceTimersByTime(16);
      expect(setBoundsSpy).toHaveBeenCalledTimes(1);

      // Advance all remaining frames
      vi.advanceTimersByTime(33 * mod.TOTAL_FRAMES);

      // Final bounds should match expanded state centered at x=500
      const finalBounds = win.getBounds();
      expect(finalBounds.width).toBe(320);
      expect(finalBounds.height).toBe(240);
      // centerX was 406 + 188/2 = 500, so x = 500 - 320/2 = 340
      expect(finalBounds.x).toBe(340);
    });

    it('resolves the returned promise when animation completes', async () => {
      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);
      let resolved = false;

      const promise = animator.transitionTo('expanded').then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false);

      // Advance through all frames
      vi.advanceTimersByTime(33 * (mod.TOTAL_FRAMES + 1));
      await promise;

      expect(resolved).toBe(true);
    });

    it('resolves immediately if already at target bounds', async () => {
      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);

      const promise = animator.transitionTo('compact');
      // Should resolve immediately (no animation needed)
      await promise;
      // No setBounds calls needed
    });

    it('cancels previous animation when a new one starts', () => {
      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);

      animator.transitionTo('expanded');
      vi.advanceTimersByTime(33 * 2); // partial animation

      // Start a new animation before the first finishes
      animator.transitionTo('sessionComplete');
      vi.advanceTimersByTime(33 * (mod.TOTAL_FRAMES + 1));

      // Should end at sessionComplete dimensions, not expanded
      const finalBounds = win.getBounds();
      expect(finalBounds.width).toBe(300);
      expect(finalBounds.height).toBe(120);
    });

    it('resolves immediately if window is destroyed', async () => {
      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);
      win._destroy();

      const promise = animator.transitionTo('expanded');
      await promise;
      // Should not throw
    });

    it('stops animation if window is destroyed mid-animation', async () => {
      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);

      const promise = animator.transitionTo('expanded');
      vi.advanceTimersByTime(16); // one frame

      // Destroy mid-animation
      win._destroy();
      vi.advanceTimersByTime(33 * mod.TOTAL_FRAMES);
      await promise;
      // Should not throw
    });

    it('maintains horizontal center during expansion', () => {
      // Window centered at x=500 (406 + 188/2)
      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);

      animator.transitionTo('expanded');

      // Check each frame maintains centering
      for (let i = 0; i < mod.TOTAL_FRAMES; i++) {
        vi.advanceTimersByTime(16);
        const bounds = win.getBounds();
        const center = bounds.x + bounds.width / 2;
        // Allow 1px rounding tolerance
        expect(Math.abs(center - 500)).toBeLessThanOrEqual(1);
      }
    });
  });

  // ---- connectStateMachine ----

  describe('connectStateMachine', () => {
    it('automatically animates on state machine transitions', () => {
      const { createWidgetStateMachine, STATES } = loadStateMachine();
      const sm = createWidgetStateMachine(STATES.COMPACT);

      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);
      animator.connectStateMachine(sm);

      // Trigger a transition
      sm.transition(STATES.EXPANDED);

      // Advance animation to completion
      vi.advanceTimersByTime(33 * (mod.TOTAL_FRAMES + 1));

      const bounds = win.getBounds();
      expect(bounds.width).toBe(320);
      expect(bounds.height).toBe(240);
    });

    it('returns an unsubscribe function', () => {
      const { createWidgetStateMachine, STATES } = loadStateMachine();
      const sm = createWidgetStateMachine(STATES.COMPACT);

      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);
      const unsub = animator.connectStateMachine(sm);

      unsub();

      // Transition should NOT trigger animation
      sm.transition(STATES.EXPANDED);
      vi.advanceTimersByTime(33 * (mod.TOTAL_FRAMES + 1));

      // Window should not have changed
      const bounds = win.getBounds();
      expect(bounds.width).toBe(188);
    });

    it('disconnects previous state machine when connecting a new one', () => {
      const { createWidgetStateMachine, STATES } = loadStateMachine();
      const sm1 = createWidgetStateMachine(STATES.COMPACT);
      const sm2 = createWidgetStateMachine(STATES.COMPACT);

      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);

      animator.connectStateMachine(sm1);
      animator.connectStateMachine(sm2); // replaces sm1 connection

      // sm1 transition should not animate
      sm1.transition(STATES.EXPANDED);
      vi.advanceTimersByTime(33 * (mod.TOTAL_FRAMES + 1));
      expect(win.getBounds().width).toBe(188);

      // sm2 transition should animate
      sm2.transition(STATES.EXPANDED);
      vi.advanceTimersByTime(33 * (mod.TOTAL_FRAMES + 1));
      expect(win.getBounds().width).toBe(320);
    });
  });

  // ---- destroy ----

  describe('destroy', () => {
    it('cancels in-progress animation', () => {
      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);
      const setBoundsSpy = vi.spyOn(win, 'setBounds');

      animator.transitionTo('expanded');
      vi.advanceTimersByTime(16);
      const callsAfterOneFrame = setBoundsSpy.mock.calls.length;

      animator.destroy();
      vi.advanceTimersByTime(33 * mod.TOTAL_FRAMES);

      // No more setBounds calls after destroy
      expect(setBoundsSpy.mock.calls.length).toBe(callsAfterOneFrame);
    });

    it('disconnects from state machine', () => {
      const { createWidgetStateMachine, STATES } = loadStateMachine();
      const sm = createWidgetStateMachine(STATES.COMPACT);

      const win = createMockWindow({ x: 406, y: 60, width: 188, height: 32 });
      const animator = mod.createWidgetAnimator(win);
      animator.connectStateMachine(sm);

      animator.destroy();

      sm.transition(STATES.EXPANDED);
      vi.advanceTimersByTime(33 * (mod.TOTAL_FRAMES + 1));

      expect(win.getBounds().width).toBe(188);
    });
  });
});
