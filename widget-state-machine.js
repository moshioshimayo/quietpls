'use strict';

/**
 * Widget State Machine (US-001)
 *
 * Pure-logic finite state machine governing all widget states and transitions.
 * No Electron imports — IPC bridging is handled externally by main.js / preload.js.
 */

const STATES = Object.freeze({
  COMPACT: 'compact',
  EXPANDED: 'expanded',
  ALERT: 'alert',
  SESSION_COMPLETE: 'sessionComplete',
});

// Map of state → Set of valid target states
const TRANSITIONS = Object.freeze({
  [STATES.COMPACT]: new Set([STATES.EXPANDED, STATES.SESSION_COMPLETE]),
  [STATES.EXPANDED]: new Set([STATES.ALERT, STATES.SESSION_COMPLETE, STATES.COMPACT]),
  [STATES.ALERT]: new Set([STATES.EXPANDED, STATES.SESSION_COMPLETE]),
  [STATES.SESSION_COMPLETE]: new Set([STATES.COMPACT]),
});

/**
 * Create a new WidgetStateMachine instance.
 * @param {string} [initialState='compact'] — must be one of STATES values
 * @returns {object} state machine API
 */
function createWidgetStateMachine(initialState) {
  if (initialState === undefined) {
    initialState = STATES.COMPACT;
  }

  if (!Object.values(STATES).includes(initialState)) {
    throw new Error(`Invalid initial state: "${initialState}"`);
  }

  let currentState = initialState;
  const listeners = [];

  function getState() {
    return currentState;
  }

  /**
   * Transition to targetState. Throws on invalid transitions.
   * @param {string} targetState
   * @param {object} [context={}] — arbitrary data forwarded with the event
   * @returns {{ from: string, to: string, context: object }}
   */
  function transition(targetState, context) {
    if (context === undefined) {
      context = {};
    }

    if (!Object.values(STATES).includes(targetState)) {
      throw new Error(`Unknown target state: "${targetState}"`);
    }

    const allowed = TRANSITIONS[currentState];
    if (!allowed || !allowed.has(targetState)) {
      throw new Error(
        `Invalid transition: "${currentState}" → "${targetState}". ` +
        `Allowed targets from "${currentState}": [${allowed ? Array.from(allowed).join(', ') : 'none'}]`
      );
    }

    const payload = { from: currentState, to: targetState, context: context };
    currentState = targetState;

    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i](payload);
      } catch (err) {
        console.error('Widget state machine: listener threw', err);
      }
    }

    return payload;
  }

  /**
   * Register a callback invoked on every successful transition.
   * @param {function} callback — receives { from, to, context }
   * @returns {function} unsubscribe function
   */
  function onTransition(callback) {
    if (typeof callback !== 'function') {
      throw new Error('onTransition expects a function');
    }
    listeners.push(callback);
    return function unsubscribe() {
      const idx = listeners.indexOf(callback);
      if (idx !== -1) {
        listeners.splice(idx, 1);
      }
    };
  }

  return { getState: getState, transition: transition, onTransition: onTransition };
}

module.exports = { createWidgetStateMachine, STATES, TRANSITIONS };
