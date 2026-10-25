'use strict';

/**
 * Widget Animator (US-005)
 *
 * Smoothly resizes the Electron BrowserWindow between Dynamic Island states.
 * Uses setInterval-based animation at ~30fps with easeOutCubic easing.
 * Keeps the window centered on its current horizontal position during resize.
 *
 * No renderer-side imports — this runs entirely in the main process.
 */

const { STATES } = require('./widget-state-machine');

// Target dimensions for each widget state
const STATE_BOUNDS = Object.freeze({
  [STATES.COMPACT]:          { width: 72, height: 28 },
  [STATES.EXPANDED]:         { width: 352, height: 96 },
  [STATES.ALERT]:            { width: 392, height: 106 },
  [STATES.SESSION_COMPLETE]: { width: 300, height: 120 },
});

// Animation configuration
const ANIMATION_DURATION_MS = 350;
const FRAME_INTERVAL_MS = 16; // ~60fps for smoother spring
const TOTAL_FRAMES = Math.round(ANIMATION_DURATION_MS / FRAME_INTERVAL_MS);

/**
 * Spring easing function — overshoots slightly then settles.
 * Creates a premium, physical feel to transitions.
 * @param {number} t — progress from 0 to 1
 * @returns {number} eased value (may exceed 1 briefly)
 */
function easeOutCubic(t) {
  // Spring-damped overshoot: peaks ~1.04 at t≈0.7, settles to 1.0
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  var c4 = (2 * Math.PI) / 4.5;
  return 1 + Math.pow(2, -8 * t) * Math.sin((t * 8 - 1.2) * c4) * 0.15 + (1 - Math.pow(1 - t, 3)) - 1;
}

/**
 * Calculate the target bounds for a given state, centered around a horizontal
 * midpoint and preserving the current y position.
 *
 * @param {string} state — one of STATES values
 * @param {number} centerX — horizontal center of the current window
 * @param {number} y — current y position of the window
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function calculateTargetBounds(state, centerX, y) {
  const dims = STATE_BOUNDS[state];
  if (!dims) {
    throw new Error(`Unknown widget state: "${state}"`);
  }
  return {
    x: Math.round(centerX - dims.width / 2),
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
function createWidgetAnimator(browserWindow) {
  if (!browserWindow) {
    throw new Error('createWidgetAnimator requires a BrowserWindow instance');
  }

  let currentTimer = null;
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

    // If the window has been destroyed, bail out silently
    if (browserWindow.isDestroyed()) {
      return Promise.resolve();
    }

    const currentBounds = browserWindow.getBounds();
    const centerX = currentBounds.x + currentBounds.width / 2;
    const targetBounds = calculateTargetBounds(state, centerX, currentBounds.y);

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
