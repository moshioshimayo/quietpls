'use strict';

/**
 * Widget Animator (US-005)
 *
 * Resizes the floating window while keeping the pill's right edge in place.
 *
 * No renderer-side imports — this runs entirely in the main process.
 */

const { STATES } = require('./widget-state-machine');

// Target dimensions for each widget state
const STATE_BOUNDS = Object.freeze({
  [STATES.COMPACT]:          { width: 240, height: 94 },
  [STATES.EXPANDED]:         { width: 368, height: 330 },
  [STATES.SESSION_COMPLETE]: { width: 368, height: 300 },
});

// Animation configuration
const ANIMATION_DURATION_MS = 180;
const FRAME_INTERVAL_MS = 16;
const TOTAL_FRAMES = Math.round(ANIMATION_DURATION_MS / FRAME_INTERVAL_MS);

/**
 * Ease out without overshoot.
 * @param {number} t — progress from 0 to 1
 * @returns {number} eased value from 0 to 1
 */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
}

/**
 * Keep the right edge and y position of the current window.
 *
 * @param {string} state — one of STATES values
 * @param {number} rightX — right edge of the current window
 * @param {number} y — current y position of the window
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function calculateTargetBounds(state, rightX, y) {
  const dims = STATE_BOUNDS[state];
  if (!dims) {
    throw new Error(`Unknown widget state: "${state}"`);
  }
  return {
    x: Math.round(rightX - dims.width),
    y: y,
    width: dims.width,
    height: dims.height,
  };
}

/**
 * Interpolate between start and end bounds at a given eased progress.
 *
 * @param {{ x: number, y: number, width: number, height: number }} start
 * @param {{ x: number, y: number, width: number, height: number }} end
 * @param {number} progress — eased progress from 0 to 1
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function interpolateBounds(start, end, progress) {
  return {
    x: Math.round(start.x + (end.x - start.x) * progress),
    y: Math.round(start.y + (end.y - start.y) * progress),
    width: Math.round(start.width + (end.width - start.width) * progress),
    height: Math.round(start.height + (end.height - start.height) * progress),
  };
}

/**
 * Create a WidgetAnimator bound to a BrowserWindow.
 *
 * @param {import('electron').BrowserWindow} browserWindow
 * @returns {object} animator API: { transitionTo, connectStateMachine, destroy }
 */
function createWidgetAnimator(browserWindow, options = {}) {
  if (!browserWindow) {
    throw new Error('createWidgetAnimator requires a BrowserWindow instance');
  }

  let currentTimer = null;
  let currentState = STATES.COMPACT;
  let reducedMotion = false;
  const heights = {};
  let unsubscribeStateMachine = null;

  /**
   * Cancel any in-progress animation.
   */
  function cancelAnimation() {
    if (currentTimer !== null) {
      clearInterval(currentTimer);
      currentTimer = null;
    }
  }

  /**
   * Animate the window to the bounds for the given state.
   *
   * @param {string} state — one of STATES values
   * @returns {Promise<void>} resolves when animation completes
   */
  function transitionTo(state) {
    cancelAnimation();
    currentState = state;

    // If the window has been destroyed, bail out silently
    if (browserWindow.isDestroyed()) {
      return Promise.resolve();
    }

    const currentBounds = browserWindow.getBounds();
    const rightX = currentBounds.x + currentBounds.width;
    const targetBounds = calculateTargetBounds(state, rightX, currentBounds.y);
    if (heights[state]) targetBounds.height = heights[state];
    const area = options.getWorkArea && options.getWorkArea(currentBounds);
    if (area) {
      targetBounds.x = Math.max(area.x, Math.min(targetBounds.x, area.x + area.width - targetBounds.width));
      targetBounds.y = Math.max(area.y, Math.min(targetBounds.y, area.y + area.height - targetBounds.height));
    }
    if (reducedMotion) {
      browserWindow.setBounds(targetBounds);
      return Promise.resolve();
    }

    // If already at target bounds, nothing to animate
    if (
      currentBounds.x === targetBounds.x &&
      currentBounds.y === targetBounds.y &&
      currentBounds.width === targetBounds.width &&
      currentBounds.height === targetBounds.height
    ) {
      return Promise.resolve();
    }

    const startBounds = {
      x: currentBounds.x,
      y: currentBounds.y,
      width: currentBounds.width,
      height: currentBounds.height,
    };

    return new Promise(function animationPromise(resolve) {
      let frame = 0;

      currentTimer = setInterval(function onFrame() {
        frame++;
        var progress = Math.min(frame / TOTAL_FRAMES, 1);
        var easedProgress = easeOutCubic(progress);

        if (browserWindow.isDestroyed()) {
          cancelAnimation();
          resolve();
          return;
        }

        var newBounds = interpolateBounds(startBounds, targetBounds, easedProgress);

        // Ensure minimum dimensions (Electron enforces this but be explicit)
        newBounds.width = Math.max(newBounds.width, 1);
        newBounds.height = Math.max(newBounds.height, 1);

        browserWindow.setBounds(newBounds);

        if (progress >= 1) {
          cancelAnimation();
          resolve();
        }
      }, FRAME_INTERVAL_MS);
    });
  }

  /**
   * Connect to a WidgetStateMachine instance so transitions automatically
   * trigger window animations.
   *
   * @param {object} stateMachine — created by createWidgetStateMachine()
   * @returns {function} unsubscribe function
   */
  function connectStateMachine(stateMachine) {
    // Disconnect any previous subscription
    if (unsubscribeStateMachine) {
      unsubscribeStateMachine();
    }

    unsubscribeStateMachine = stateMachine.onTransition(function onStateChange(payload) {
      transitionTo(payload.to);
    });

    return unsubscribeStateMachine;
  }

  /**
   * Tear down: cancel animations and disconnect from state machine.
   */
  function destroy() {
    cancelAnimation();
    if (unsubscribeStateMachine) {
      unsubscribeStateMachine();
      unsubscribeStateMachine = null;
    }
  }

  return {
    setContentHeight(height) {
      const next = Math.round(Math.max(94, Math.min(800, height)));
      if (heights[currentState] === next) return;
      heights[currentState] = next;
      transitionTo(currentState);
    },
    setReducedMotion(value) { reducedMotion = !!value; },
    transitionTo: transitionTo,
    connectStateMachine: connectStateMachine,
    destroy: destroy,
  };
}

module.exports = {
  createWidgetAnimator,
  // Exported for testing
  STATE_BOUNDS,
  ANIMATION_DURATION_MS,
  FRAME_INTERVAL_MS,
  TOTAL_FRAMES,
  easeOutCubic,
  calculateTargetBounds,
  interpolateBounds,
};
