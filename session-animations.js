'use strict';

/**
 * Session Animations Module (US-025)
 *
 * Provides session-specific animations for the session complete panel:
 * - Grade reveal with animated count-up
 * - Confetti/celebration effect for A-range grades
 * - Scorecard slide-in animation
 *
 * CommonJS module — pure functions exported for testing, DOM-dependent
 * functions guarded behind a window check.
 */

// ---- Animation timing constants (pure, testable) ----

/**
 * Default animation timing constants (in milliseconds).
 */
var ANIMATION_DEFAULTS = Object.freeze({
  COUNT_UP_DURATION: 800,
  COUNT_UP_INTERVAL: 16,
  GRADE_REVEAL_DELAY: 200,
  CELEBRATION_DURATION: 1500,
  CELEBRATION_PARTICLE_COUNT: 12,
});

/**
 * Letter grades that qualify as "A-range" for celebration effects.
 */
var A_RANGE_GRADES = Object.freeze(['A+', 'A', 'A-']);

/**
 * Confetti particle color palette — matches the design system celebration colors.
 */
var CONFETTI_COLORS = Object.freeze([
  '#22c55e', // green (grade A)
  '#06b6d4', // cyan (normal zone)
  '#f59e0b', // amber (quiet zone)
  '#facc15', // gold
  '#0ea5e9', // sky blue
  '#14b8a6', // teal
]);

// ---- Pure helper functions (testable without DOM) ----

/**
 * Determine whether a letter grade is in the A-range (A+, A, A-).
 * Pure function — no DOM dependencies.
 *
 * @param {string} letterGrade
 * @returns {boolean}
 */
function isAGrade(letterGrade) {
  return typeof letterGrade === 'string' && A_RANGE_GRADES.indexOf(letterGrade) !== -1;
}

/**
 * Compute the intermediate count-up value at a given elapsed time.
 * Uses an ease-out curve for natural deceleration.
 * Pure function — no DOM dependencies.
 *
 * @param {number} elapsed — ms since animation start
 * @param {number} duration — total animation duration in ms
 * @param {number} targetValue — final numeric value
 * @returns {number} the current display value (integer)
 */
function computeCountUpValue(elapsed, duration, targetValue) {
  if (typeof elapsed !== 'number' || typeof duration !== 'number' || typeof targetValue !== 'number') {
    return 0;
  }
  if (duration <= 0) return Math.round(targetValue);
  var progress = Math.min(elapsed / duration, 1);
  // Ease-out: 1 - (1 - t)^3
  var eased = 1 - Math.pow(1 - progress, 3);
  return Math.round(eased * targetValue);
}

/**
 * Generate a random position and size for a confetti particle.
 * Pure function — returns an object describing the particle.
 *
 * @param {number} index — particle index (0-based)
 * @param {number} totalParticles — total number of particles
 * @param {number} containerWidth — container width in px
 * @param {number} containerHeight — container height in px
 * @returns {{ x: number, y: number, size: number, color: string, delay: number, angle: number }}
 */
function generateParticleProps(index, totalParticles, containerWidth, containerHeight) {
  var colors = CONFETTI_COLORS;
  var color = colors[index % colors.length];
  // Spread particles across container width
  var spreadFactor = totalParticles > 1 ? index / (totalParticles - 1) : 0.5;
  var x = spreadFactor * (containerWidth || 320);
  var y = (containerHeight || 120);
  var size = 4 + (index % 3) * 2; // 4, 6, or 8px
  var delay = (index * 40); // stagger each particle by 40ms
  var angle = -60 + (spreadFactor * 120); // spray angle -60 to +60 degrees

  return {
    x: x,
    y: y,
    size: size,
    color: color,
    delay: delay,
    angle: angle,
  };
}

/**
 * Build the CSS text for animating a confetti particle element.
 * Pure function.
 *
 * @param {{ x: number, y: number, size: number, color: string, delay: number }} props
 * @returns {string} CSS inline style string
 */
function buildParticleStyle(props) {
  return 'position:absolute;' +
    'left:' + Math.round(props.x) + 'px;' +
    'bottom:0;' +
    'width:' + props.size + 'px;' +
    'height:' + props.size + 'px;' +
    'background:' + props.color + ';' +
    'border-radius:' + (props.size <= 4 ? '50%' : '2px') + ';' +
    'pointer-events:none;' +
    'animation:confetti-particle ' + ANIMATION_DEFAULTS.CELEBRATION_DURATION + 'ms var(--ease-spring-soft, cubic-bezier(0.22, 1.0, 0.36, 1)) ' + props.delay + 'ms both;' +
    'opacity:0;';
}

// ---- Exports for testing (Node.js / vitest) ----

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ANIMATION_DEFAULTS: ANIMATION_DEFAULTS,
    A_RANGE_GRADES: A_RANGE_GRADES,
    CONFETTI_COLORS: CONFETTI_COLORS,
    isAGrade: isAGrade,
    computeCountUpValue: computeCountUpValue,
    generateParticleProps: generateParticleProps,
    buildParticleStyle: buildParticleStyle,
  };
}

// ---- Guard: stop here when loaded in Node.js (tests) ----
if (typeof window === 'undefined') { /* no-op */ }
else {
// ---- Renderer-only code ----

/**
 * Animate a numeric count-up on an element.
 * Updates element.textContent from 0 to targetValue over durationMs.
 *
 * @param {HTMLElement} element — DOM element to update
 * @param {number} targetValue — final number to display
 * @param {number} [durationMs] — animation duration (default: 800)
 * @param {string} [suffix] — optional suffix to append (e.g. '/100')
 * @returns {Promise<void>} resolves when animation completes
 */
function animateCountUp(element, targetValue, durationMs, suffix) {
  var duration = durationMs || ANIMATION_DEFAULTS.COUNT_UP_DURATION;
  var sfx = suffix || '';

  return new Promise(function (resolve) {
    if (!element || typeof targetValue !== 'number') {
      resolve();
      return;
    }

    var startTime = performance.now();

    function tick(now) {
      var elapsed = now - startTime;
      var currentValue = computeCountUpValue(elapsed, duration, targetValue);
      element.textContent = currentValue + sfx;

      if (elapsed < duration) {
        requestAnimationFrame(tick);
      } else {
        element.textContent = Math.round(targetValue) + sfx;
        resolve();
      }
    }

    element.textContent = '0' + sfx;
    requestAnimationFrame(tick);
  });
}

/**
 * Orchestrate the grade reveal animation sequence:
 * 1. Count up the score number (0 → score)
 * 2. Spring in the letter grade
 *
 * @param {HTMLElement} gradeElement — the letter grade display element
 * @param {HTMLElement} scoreElement — the score number display element (optional)
 * @param {number} score — numeric score (0-100)
 * @param {string} letterGrade — letter grade string (e.g. 'A+')
 * @param {string} colorClass — CSS class suffix for grade color (e.g. 'a')
 * @returns {Promise<void>} resolves when full reveal is complete
 */
function animateGradeReveal(gradeElement, scoreElement, score, letterGrade, colorClass) {
  return new Promise(function (resolve) {
    // Phase 1: Hide the grade initially, show score count-up
    if (gradeElement) {
      gradeElement.textContent = '';
      gradeElement.classList.remove('grade-reveal');
      gradeElement.classList.remove('grade-a', 'grade-b', 'grade-c', 'grade-d', 'grade-f');
      gradeElement.style.opacity = '0';
    }

    // Phase 1: Count up the score if scoreElement exists
    var countUpPromise;
    if (scoreElement && typeof score === 'number') {
      scoreElement.classList.add('count-up-active');
      countUpPromise = animateCountUp(scoreElement, score, ANIMATION_DEFAULTS.COUNT_UP_DURATION);
    } else {
      countUpPromise = Promise.resolve();
    }

    countUpPromise.then(function () {
      if (scoreElement) {
        scoreElement.classList.remove('count-up-active');
      }

      // Phase 2: Reveal the letter grade with spring animation after a short delay
      setTimeout(function () {
        if (gradeElement) {
          gradeElement.textContent = letterGrade;
          if (colorClass) {
            gradeElement.classList.add('grade-' + colorClass);
          }
          gradeElement.style.opacity = '1';
          // Force reflow before adding animation class
          void gradeElement.offsetWidth;
          gradeElement.classList.add('grade-reveal');
        }
        resolve();
      }, ANIMATION_DEFAULTS.GRADE_REVEAL_DELAY);
    });
  });
}

/**
 * Trigger a confetti/celebration particle burst.
 * Creates floating particle elements that animate upward and auto-remove.
 * Only triggers for A-range grades.
 *
 * @param {HTMLElement} container — parent element for the particles
 * @param {string} [letterGrade] — if provided, only triggers for A-range grades
 */
function triggerCelebration(container, letterGrade) {
  if (!container) return;
  if (letterGrade && !isAGrade(letterGrade)) return;

  var containerWidth = container.offsetWidth || 320;
  var containerHeight = container.offsetHeight || 120;
  var count = ANIMATION_DEFAULTS.CELEBRATION_PARTICLE_COUNT;

  // Ensure container has relative positioning for absolute children
  var currentPosition = window.getComputedStyle(container).position;
  if (currentPosition === 'static') {
    container.style.position = 'relative';
  }

  for (var i = 0; i < count; i++) {
    var props = generateParticleProps(i, count, containerWidth, containerHeight);
    var particle = document.createElement('div');
    particle.className = 'confetti-particle';
    particle.style.cssText = buildParticleStyle(props);
    container.appendChild(particle);
  }

  // Auto-remove particles after animation completes
  var maxDelay = count * 40;
  var totalDuration = ANIMATION_DEFAULTS.CELEBRATION_DURATION + maxDelay + 100;
  setTimeout(function () {
    var particles = container.querySelectorAll('.confetti-particle');
    for (var j = 0; j < particles.length; j++) {
      particles[j].remove();
    }
  }, totalDuration);
}

// Expose to renderer via window
window.SessionAnimations = {
  animateCountUp: animateCountUp,
  animateGradeReveal: animateGradeReveal,
  triggerCelebration: triggerCelebration,
  isAGrade: isAGrade,
};

} // end of else block (renderer-only code)
