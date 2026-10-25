import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadModule() {
  const modPath = require.resolve('../../widget-state-machine');
  delete require.cache[modPath];
  return require('../../widget-state-machine');
}

describe('widget-state-machine', () => {
  let createWidgetStateMachine;
  let STATES;
  let TRANSITIONS;

  beforeEach(() => {
    const mod = loadModule();
    createWidgetStateMachine = mod.createWidgetStateMachine;
    STATES = mod.STATES;
    TRANSITIONS = mod.TRANSITIONS;
  });

  // ---- Exports ----

  describe('module exports', () => {
    it('exports createWidgetStateMachine as a function', () => {
      expect(typeof createWidgetStateMachine).toBe('function');
    });

    it('exports STATES with correct values', () => {
      expect(STATES).toEqual({
        COMPACT: 'compact',
        EXPANDED: 'expanded',
        ALERT: 'alert',
        SESSION_COMPLETE: 'sessionComplete',
      });
    });

    it('exports TRANSITIONS mapping for all states', () => {
      for (const state of Object.values(STATES)) {
        expect(TRANSITIONS).toHaveProperty(state);
      }
    });

    it('STATES is frozen', () => {
      expect(Object.isFrozen(STATES)).toBe(true);
    });

    it('TRANSITIONS is frozen', () => {
      expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    });
  });

  // ---- Instantiation ----

  describe('createWidgetStateMachine()', () => {
    it('defaults to compact state', () => {
      const sm = createWidgetStateMachine();
      expect(sm.getState()).toBe('compact');
    });

    it('accepts a custom initial state', () => {
      const sm = createWidgetStateMachine('expanded');
      expect(sm.getState()).toBe('expanded');
    });

    it('throws on invalid initial state', () => {
      expect(() => createWidgetStateMachine('bogus')).toThrow(/Invalid initial state/);
    });

    it('exposes getState, transition, onTransition', () => {
      const sm = createWidgetStateMachine();
      expect(typeof sm.getState).toBe('function');
      expect(typeof sm.transition).toBe('function');
      expect(typeof sm.onTransition).toBe('function');
    });
  });

  // ---- Valid transitions ----

  describe('valid transitions', () => {
    const validPaths = [
      ['compact', 'expanded'],
      ['compact', 'sessionComplete'],
      ['expanded', 'alert'],
      ['alert', 'expanded'],
      ['expanded', 'sessionComplete'],
      ['expanded', 'compact'],
      ['sessionComplete', 'compact'],
      ['alert', 'sessionComplete'],
    ];

    for (const [from, to] of validPaths) {
      it(`${from} → ${to}`, () => {
        const sm = createWidgetStateMachine(from);
        sm.transition(to);
        expect(sm.getState()).toBe(to);
      });
    }
  });

  // ---- Invalid transitions ----

  describe('invalid transitions throw', () => {
    const invalidPaths = [
      ['compact', 'alert'],
      ['compact', 'compact'],
      ['expanded', 'expanded'],
      ['alert', 'compact'],
      ['alert', 'alert'],
      ['sessionComplete', 'expanded'],
      ['sessionComplete', 'alert'],
      ['sessionComplete', 'sessionComplete'],
    ];

    for (const [from, to] of invalidPaths) {
      it(`${from} → ${to} throws`, () => {
        const sm = createWidgetStateMachine(from);
        expect(() => sm.transition(to)).toThrow(/Invalid transition/);
        // State should remain unchanged
        expect(sm.getState()).toBe(from);
      });
    }

    it('throws on unknown target state', () => {
      const sm = createWidgetStateMachine();
      expect(() => sm.transition('unknown')).toThrow(/Unknown target state/);
    });
  });

  // ---- Event payloads ----

  describe('transition events', () => {
    it('emits event with { from, to, context } on valid transition', () => {
      const sm = createWidgetStateMachine('compact');
      const events = [];
      sm.onTransition((e) => events.push(e));

      sm.transition('expanded', { reason: 'click' });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        from: 'compact',
        to: 'expanded',
        context: { reason: 'click' },
      });
    });

    it('defaults context to empty object when omitted', () => {
      const sm = createWidgetStateMachine('compact');
      const events = [];
      sm.onTransition((e) => events.push(e));

      sm.transition('expanded');

      expect(events[0].context).toEqual({});
    });

    it('does not emit on invalid transition', () => {
      const sm = createWidgetStateMachine('compact');
      const events = [];
      sm.onTransition((e) => events.push(e));

      expect(() => sm.transition('alert')).toThrow();
      expect(events).toHaveLength(0);
    });

    it('transition() returns the payload', () => {
      const sm = createWidgetStateMachine('compact');
      const result = sm.transition('expanded', { x: 1 });
      expect(result).toEqual({ from: 'compact', to: 'expanded', context: { x: 1 } });
    });
  });

  // ---- Listener management ----

  describe('onTransition listener management', () => {
    it('supports multiple listeners', () => {
      const sm = createWidgetStateMachine('compact');
      const calls1 = [];
      const calls2 = [];
      sm.onTransition((e) => calls1.push(e));
      sm.onTransition((e) => calls2.push(e));

      sm.transition('expanded');
      expect(calls1).toHaveLength(1);
      expect(calls2).toHaveLength(1);
    });

    it('returns an unsubscribe function', () => {
      const sm = createWidgetStateMachine('compact');
      const calls = [];
      const unsub = sm.onTransition((e) => calls.push(e));

      sm.transition('expanded');
      expect(calls).toHaveLength(1);

      unsub();
      sm.transition('compact');
      expect(calls).toHaveLength(1); // no new call
    });

    it('throws if callback is not a function', () => {
      const sm = createWidgetStateMachine();
      expect(() => sm.onTransition('not a fn')).toThrow(/expects a function/);
    });

    it('does not crash if a listener throws', () => {
      const sm = createWidgetStateMachine('compact');
      const calls = [];
      sm.onTransition(() => { throw new Error('boom'); });
      sm.onTransition((e) => calls.push(e));

      // Should not throw despite first listener throwing
      sm.transition('expanded');
      expect(calls).toHaveLength(1);
    });
  });

  // ---- Rapid transition sequences ----

  describe('rapid transition sequences', () => {
    it('handles compact→expanded→alert→expanded→compact sequence', () => {
      const sm = createWidgetStateMachine('compact');
      const events = [];
      sm.onTransition((e) => events.push(e));

      sm.transition('expanded');
      sm.transition('alert');
      sm.transition('expanded');
      sm.transition('compact');

      expect(sm.getState()).toBe('compact');
      expect(events).toHaveLength(4);
      expect(events.map((e) => `${e.from}→${e.to}`)).toEqual([
        'compact→expanded',
        'expanded→alert',
        'alert→expanded',
        'expanded→compact',
      ]);
    });

    it('handles compact→expanded→sessionComplete→compact cycle', () => {
      const sm = createWidgetStateMachine('compact');

      sm.transition('expanded');
      sm.transition('sessionComplete');
      sm.transition('compact');
      expect(sm.getState()).toBe('compact');
    });

    it('handles alert→sessionComplete→compact path', () => {
      const sm = createWidgetStateMachine('alert');

      sm.transition('sessionComplete');
      sm.transition('compact');
      expect(sm.getState()).toBe('compact');
    });

    it('supports many rapid transitions without issue', () => {
      const sm = createWidgetStateMachine('compact');
      const loop = ['expanded', 'compact']; // valid back-and-forth

      for (let i = 0; i < 1000; i++) {
        sm.transition(loop[i % 2]);
      }
      // After 1000 transitions (even number), should be back to compact
      expect(sm.getState()).toBe('compact');
    });

    it('preserves context through rapid transitions', () => {
      const sm = createWidgetStateMachine('compact');
      const events = [];
      sm.onTransition((e) => events.push(e));

      sm.transition('expanded', { step: 1 });
      sm.transition('alert', { step: 2 });
      sm.transition('sessionComplete', { step: 3 });
      sm.transition('compact', { step: 4 });

      expect(events[0].context).toEqual({ step: 1 });
      expect(events[1].context).toEqual({ step: 2 });
      expect(events[2].context).toEqual({ step: 3 });
      expect(events[3].context).toEqual({ step: 4 });
    });
  });

  // ---- Independent instances ----

  describe('instance isolation', () => {
    it('two instances do not share state', () => {
      const sm1 = createWidgetStateMachine('compact');
      const sm2 = createWidgetStateMachine('expanded');

      sm1.transition('expanded');
      expect(sm1.getState()).toBe('expanded');
      expect(sm2.getState()).toBe('expanded'); // unchanged — started there

      sm2.transition('compact');
      expect(sm1.getState()).toBe('expanded');
      expect(sm2.getState()).toBe('compact');
    });
  });
});
