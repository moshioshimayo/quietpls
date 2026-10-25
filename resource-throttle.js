'use strict';

/**
 * resource-throttle.js — Pure logic utilities for performance management (US-023).
 *
 * All functions are stateless and side-effect-free, making them easy to unit test.
 * Used by performance-manager.js for frame throttling, idle detection, memory
 * monitoring, and FPS calculation.
 */

// ── Constants ────────────────────────────────────────────────────────

/** Default FPS targets for different application states. */
const FPS_DEFAULTS = Object.freeze({
  FOREGROUND: 30,
  BACKGROUND: 10,
  BATTERY: 15,
  IDLE: 5,
});

/** Memory warning threshold in MB. */
const MEMORY_WARNING_THRESHOLD_MB = 150;

/** Audio idle threshold: volume below this is considered silence. */
const IDLE_VOLUME_THRESHOLD = 2;

/** Duration of silence (ms) before entering idle mode. */
const IDLE_DURATION_MS = 30000;

/** Session pruning: remove sessions older than this many days. */
const SESSION_MAX_AGE_DAYS = 90;

// ── Pure utility functions ───────────────────────────────────────────

/**
 * Determine whether the current animation frame should be skipped
 * to achieve a target FPS lower than the native refresh rate.
 *
 * @param {number} lastFrameTime — timestamp (ms) of the last rendered frame
 * @param {number} targetFps — desired frames per second (e.g. 30)
 * @param {number} now — current timestamp (ms), e.g. performance.now()
 * @returns {boolean} true if the frame should be skipped
 */
function shouldSkipFrame(lastFrameTime, targetFps, now) {
  if (targetFps <= 0) return true;
  if (lastFrameTime <= 0) return false; // First frame — always render
  const minInterval = 1000 / targetFps;
  return (now - lastFrameTime) < minInterval;
}

/**
 * Calculate the appropriate target FPS based on application state.
 *
 * Priority order:
 *   1. Idle audio → lowest FPS
 *   2. Background (unfocused) → reduced FPS
 *   3. Battery power → moderately reduced FPS
 *   4. Foreground on AC → full FPS
 *
 * @param {Object} state
 * @param {boolean} state.isFocused — whether the app window is focused
 * @param {boolean} state.isOnBattery — whether running on battery power
 * @param {boolean} [state.isIdle=false] — whether audio is idle
 * @returns {number} target FPS
 */
function calculateTargetFps(state) {
  const { isFocused, isOnBattery, isIdle } = state;

  if (isIdle) return FPS_DEFAULTS.IDLE;
  if (!isFocused) return FPS_DEFAULTS.BACKGROUND;
  if (isOnBattery) return FPS_DEFAULTS.BATTERY;
  return FPS_DEFAULTS.FOREGROUND;
}

/**
 * Detect whether the audio input is idle (silent for a sustained period).
 *
 * @param {number} volume — current volume level (0-100)
 * @param {number} idleThreshold — volume below which audio is considered silent
 * @param {number} idleDurationMs — how long silence must persist to be "idle"
 * @param {number} elapsedSilenceMs — how long the audio has been silent so far
 * @returns {boolean} true if audio should be considered idle
 */
function isIdleAudio(volume, idleThreshold, idleDurationMs, elapsedSilenceMs) {
  if (volume >= idleThreshold) return false;
  return elapsedSilenceMs >= idleDurationMs;
}

/**
 * Determine whether a memory usage warning should be emitted.
 *
 * @param {number} memoryMb — current memory usage in MB
 * @param {number} [threshold=150] — warning threshold in MB
 * @returns {boolean} true if memory exceeds the threshold
 */
function shouldWarnMemory(memoryMb, threshold) {
  const t = typeof threshold === 'number' ? threshold : MEMORY_WARNING_THRESHOLD_MB;
  return memoryMb > t;
}

/**
 * Calculate the reduced number of FFT bars for power-saving mode.
 *
 * @param {number} defaultBarCount — normal bar count (e.g. 40)
 * @param {boolean} isOnBattery — whether on battery power
 * @param {boolean} [isIdle=false] — whether audio is idle
 * @returns {number} adjusted bar count
 */
function calculateBarCount(defaultBarCount, isOnBattery, isIdle) {
  if (isIdle) return Math.max(4, Math.floor(defaultBarCount / 4));
  if (isOnBattery) return Math.max(8, Math.floor(defaultBarCount / 2));
  return defaultBarCount;
}

/**
 * Determine if a session is old enough to be pruned.
 *
 * @param {string} sessionStartTime — ISO 8601 date string
 * @param {number} maxAgeDays — maximum age in days
 * @param {number} [now] — current timestamp (ms), defaults to Date.now()
 * @returns {boolean} true if the session should be pruned
 */
function isSessionExpired(sessionStartTime, maxAgeDays, now) {
  const currentTime = typeof now === 'number' ? now : Date.now();
  const sessionTime = new Date(sessionStartTime).getTime();
  if (isNaN(sessionTime)) return true; // Invalid date — prune it
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  return (currentTime - sessionTime) > maxAgeMs;
}

/**
 * Calculate the frame interval in ms for a given FPS target.
 *
 * @param {number} fps — target frames per second
 * @returns {number} interval in ms between frames
 */
function fpsToInterval(fps) {
  if (fps <= 0) return Infinity;
  return 1000 / fps;
}

// ── Exports ──────────────────────────────────────────────────────────

module.exports = {
  // Functions
  shouldSkipFrame,
  calculateTargetFps,
  isIdleAudio,
  shouldWarnMemory,
  calculateBarCount,
  isSessionExpired,
  fpsToInterval,

  // Constants
  FPS_DEFAULTS,
  MEMORY_WARNING_THRESHOLD_MB,
  IDLE_VOLUME_THRESHOLD,
  IDLE_DURATION_MS,
  SESSION_MAX_AGE_DAYS,
};
