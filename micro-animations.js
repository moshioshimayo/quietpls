'use strict';

/**
 * Micro-Animations Orchestrator (US-024)
 *
 * Manages CSS-based micro-animations for widget state transitions,
 * volume-reactive glow effects, and volume spike pulses.
 *
 * All animation logic is CSS-driven for performance — this module
 * only orchestrates class additions/removals and inline style updates.
 *
 * CommonJS module — pure functions exported for testing, DOM-dependent
 * functions guarded behind a window check.
 */

// ---- Animation class mappings (pure, testable) ----

/**
 * Valid widget states.
 */
const WIDGET_STATES = Object.freeze({
  COMPACT: 'compact',
  EXPANDED: 'expanded',
  ALERT: 'alert',
  SESSION_COMPLETE: 'sessionComplete',
});

/**
 * Map a state transition (from → to) to the CSS animation classes to apply.
 * Returns { exit: string|null, entrance: string } where exit is applied to
 * the outgoing element and entrance to the incoming element.
 *
 * Pure function — no DOM dependencies.
 *
 * @param {string} fromState
 * @param {string} toState
 * @returns {{ exit: string|null, entrance: string }}
 */
function getTransitionClasses(fromState, toState) {
  // Compact → Expanded: spring-in with fade
  if (fromState === WIDGET_STATES.COMPACT && toState === WIDGET_STATES.EXPANDED) {
    return { exit: 'transitioning-out', entrance: 'animate-spring-in' };
  }

  // Expanded → Alert: danger-shake entrance
  if (fromState === WIDGET_STATES.EXPANDED && toState === WIDGET_STATES.ALERT) {
    return { exit: 'transitioning-out', entrance: 'animate-danger-shake' };
  }

  // Alert → Expanded: glow-shift fade back to normal
  if (fromState === WIDGET_STATES.ALERT && toState === WIDGET_STATES.EXPANDED) {
    return { exit: 'transitioning-out', entrance: 'animate-glow-shift' };
  }

  // Expanded → Session Complete: celebration bounce
  if (fromState === WIDGET_STATES.EXPANDED && toState === WIDGET_STATES.SESSION_COMPLETE) {
    return { exit: 'transitioning-out', entrance: 'animate-celebration-bounce' };
  }

  // Alert → Session Complete: celebration bounce
  if (fromState === WIDGET_STATES.ALERT && toState === WIDGET_STATES.SESSION_COMPLETE) {
    return { exit: 'transitioning-out', entrance: 'animate-celebration-bounce' };
  }

  // Compact → Session Complete: spring-in (pill auto-collapses during monitoring,
  // so this is the most common path when the user stops monitoring after 3+ seconds)
  if (fromState === WIDGET_STATES.COMPACT && toState === WIDGET_STATES.SESSION_COMPLETE) {
    return { exit: 'transitioning-out', entrance: 'animate-spring-in' };
  }

  // Session Complete → Compact: slide-down-fade exit, spring-in entrance
  if (fromState === WIDGET_STATES.SESSION_COMPLETE && toState === WIDGET_STATES.COMPACT) {
    return { exit: 'animate-slide-down-fade', entrance: 'animate-spring-in' };
  }

  // Default fallback: simple fade
  return { exit: 'transitioning-out', entrance: 'transitioning-in' };
}

/**
 * Map a volume zone string to glow CSS custom property values.
 * Pure function — returns the shadow string for box-shadow.
 *
 * @param {string} zone — 'quiet' | 'normal' | 'warning' | 'loud' | 'danger'
 * @returns {{ glowColor: string, glowIntenseColor: string }}
 */
function getGlowColorsForZone(zone) {
  var colors = {
    quiet:   { glowColor: 'rgba(99, 102, 241, 0.4)',  glowIntenseColor: 'rgba(99, 102, 241, 0.7)' },
    normal:  { glowColor: 'rgba(255, 105, 180, 0.4)', glowIntenseColor: 'rgba(255, 105, 180, 0.7)' },
    warning: { glowColor: 'rgba(239, 68, 68, 0.4)',   glowIntenseColor: 'rgba(239, 68, 68, 0.7)' },
    loud:    { glowColor: 'rgba(239, 68, 68, 0.4)',   glowIntenseColor: 'rgba(239, 68, 68, 0.7)' },
    danger:  { glowColor: 'rgba(220, 38, 38, 0.5)',   glowIntenseColor: 'rgba(220, 38, 38, 0.8)' },
  };

  return colors[zone] || colors.quiet;
}

/**
 * Determine whether a volume spike is occurring.
 * Pure function — no side effects.
 *
 * @param {number} volume — current normalized volume 0–100
 * @param {number} threshold — spike threshold 0–100
 * @returns {boolean} true if volume exceeds threshold
 */
function isVolumeSpiking(volume, threshold) {
  return typeof volume === 'number' && typeof threshold === 'number' && volume > threshold;
}

/**
 * Compute dynamic glow intensity as a 0–1 factor from volume.
 * Pure function.
 *
 * @param {number} volume — normalized volume 0–100
 * @returns {number} intensity factor 0–1
 */
function computeGlowIntensity(volume) {
  if (typeof volume !== 'number' || volume <= 0) return 0;
  if (volume >= 100) return 1;
  return volume / 100;
}

/**
 * Build a box-shadow CSS value for a given zone and intensity.
 * Pure function.
 *
 * @param {string} zone — volume zone
 * @param {number} intensity — 0–1
 * @returns {string} CSS box-shadow value
 */
function buildGlowShadow(zone, intensity) {
  var colors = getGlowColorsForZone(zone);
  // Primary glow: 14-36px spread
  var spread = Math.round(14 + intensity * 22);
  // Ambient outer glow: 40-90px spread, softer
  var outerSpread = Math.round(40 + intensity * 50);
  var color = intensity > 0.6 ? colors.glowIntenseColor : colors.glowColor;
  // Outer glow uses lower opacity version
  var outerColor = colors.glowColor.replace(/[\d.]+\)$/, (intensity * 0.2).toFixed(2) + ')');
  return '0 0 ' + spread + 'px ' + color + ', 0 0 ' + outerSpread + 'px ' + outerColor;
}

// ---- All CSS animation class names that this module manages ----
var MANAGED_CLASSES = [
  'transitioning-out',
  'transitioning-in',
  'animate-spring-in',
  'animate-danger-shake',
  'animate-glow-shift',
  'animate-celebration-bounce',
  'animate-slide-down-fade',
  'volume-spike',
  'glow-intense',
];

// Export pure functions for testing (Node.js / vitest)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WIDGET_STATES: WIDGET_STATES,
    getTransitionClasses: getTransitionClasses,
    getGlowColorsForZone: getGlowColorsForZone,
    isVolumeSpiking: isVolumeSpiking,
    computeGlowIntensity: computeGlowIntensity,
    buildGlowShadow: buildGlowShadow,
    MANAGED_CLASSES: MANAGED_CLASSES,
  };
}

// ---- Guard: stop here when loaded in Node.js (tests) ----
if (typeof window === 'undefined') { /* no-op */ }
else {
// ---- Renderer-only code ----

/**
 * Remove all managed animation classes from an element.
 * @param {HTMLElement} el
 */
function clearAnimationClasses(el) {
  if (!el) return;
  for (var i = 0; i < MANAGED_CLASSES.length; i++) {
    el.classList.remove(MANAGED_CLASSES[i]);
  }
}

/**
 * Apply state transition animation to an element.
 * Adds exit animation to the current panel, then entrance animation to the target.
 *
 * @param {HTMLElement} exitElement — the element leaving view (may be null)
 * @param {HTMLElement} enterElement — the element entering view
 * @param {string} fromState — widget state being left
 * @param {string} toState — widget state being entered
 */
function applyStateTransitionAnimation(exitElement, enterElement, fromState, toState) {
  var classes = getTransitionClasses(fromState, toState);

  // Clean up previous animation classes
  if (exitElement) {
    clearAnimationClasses(exitElement);
    // Force reflow before adding new class
    void exitElement.offsetWidth;
    if (classes.exit) {
      exitElement.classList.add(classes.exit);
    }
  }

  if (enterElement) {
    clearAnimationClasses(enterElement);
    // Force reflow to restart animation
    void enterElement.offsetWidth;
    enterElement.classList.add(classes.entrance);
  }
}

/**
 * Apply dynamic glow effect to an element based on volume zone and level.
 *
 * @param {HTMLElement} element
 * @param {string} zone — 'quiet' | 'normal' | 'warning' | 'loud' | 'danger'
 * @param {number} volume — normalized volume 0–100
 */
function createGlowEffect(element, zone, volume) {
  if (!element) return;
  var intensity = computeGlowIntensity(volume);
  var shadow = buildGlowShadow(zone, intensity);
  element.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.4), ' + shadow;

  // Toggle intense class when volume is high
  if (intensity > 0.6) {
    element.classList.add('glow-intense');
  } else {
    element.classList.remove('glow-intense');
  }
}

/**
 * Apply a micro-pulse animation when volume spikes above threshold.
 *
 * @param {HTMLElement} element
 * @param {number} volume — normalized volume 0–100
 * @param {number} threshold — spike threshold
 */
function pulseOnVolumeSpike(element, volume, threshold) {
  if (!element) return;

  if (isVolumeSpiking(volume, threshold)) {
    if (!element.classList.contains('volume-spike')) {
      element.classList.add('volume-spike');
      // Remove after animation completes (300ms)
      setTimeout(function () {
        element.classList.remove('volume-spike');
      }, 300);
    }
  }
}

// Expose to renderer via window
window.MicroAnimations = {
  applyStateTransitionAnimation: applyStateTransitionAnimation,
  createGlowEffect: createGlowEffect,
  pulseOnVolumeSpike: pulseOnVolumeSpike,
  clearAnimationClasses: clearAnimationClasses,
};

} // end of else block (renderer-only code)
