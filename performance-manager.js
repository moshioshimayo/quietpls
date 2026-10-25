'use strict';

/**
 * performance-manager.js — Resource management module for quietpls (US-023).
 *
 * Provides frame-rate throttling, battery/power awareness, memory monitoring,
 * idle detection, and cleanup scheduling. Uses pure logic from resource-throttle.js
 * for all calculations.
 *
 * Usage (main process):
 *   const { createPerformanceManager } = require('./performance-manager');
 *   const pm = createPerformanceManager({ sessionStore });
 *   pm.start();
 *   // ... later
 *   pm.destroy();
 *
 * Usage (renderer — throttled animation loop):
 *   const { createPerformanceManager } = require('./performance-manager');
 *   const pm = createPerformanceManager();
 *   const wrappedTick = pm.throttleAnimationLoop(myRenderFn, 30);
 *   // Use wrappedTick as your rAF callback
 */

const {
  shouldSkipFrame,
  calculateTargetFps,
  isIdleAudio,
  shouldWarnMemory,
  calculateBarCount,
  FPS_DEFAULTS,
  MEMORY_WARNING_THRESHOLD_MB,
  IDLE_VOLUME_THRESHOLD,
  IDLE_DURATION_MS,
  SESSION_MAX_AGE_DAYS,
} = require('./resource-throttle');

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create a performance manager instance.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.sessionStore] — session store with pruneOldSessions()
 * @param {Function} [opts.log] — logging function (defaults to console.warn)
 * @returns {Object} performance manager API
 */
function createPerformanceManager(opts) {
  const options = opts || {};
  const log = options.log || console.warn;
  const sessionStore = options.sessionStore || null;

  // ── State ────────────────────────────────────────────────────────
  let isFocused = true;
  let isOnBattery = false;
  let isIdle = false;
  let silenceStartTime = null;
  let targetFps = FPS_DEFAULTS.FOREGROUND;
  let memoryCheckInterval = null;
  let cleanupSchedules = [];
  let destroyed = false;

  // ── Frame-rate throttling ────────────────────────────────────────

  /**
   * Wrap an animation callback with frame-rate throttling.
   * Returns a function suitable for use with requestAnimationFrame.
   *
   * @param {Function} callback — the render function to call
   * @param {number} [initialTargetFps] — initial target FPS (auto-adjusted)
   * @returns {Function} throttled tick function
   */
  function throttleAnimationLoop(callback, initialTargetFps) {
    let lastFrameTime = 0;
    let currentTarget = initialTargetFps || targetFps;
    let animFrameId = null;
    let running = true;

    function tick(timestamp) {
      if (!running) return;

      // Use dynamic target FPS from manager state
      currentTarget = targetFps;

      if (shouldSkipFrame(lastFrameTime, currentTarget, timestamp)) {
        animFrameId = requestAnimationFrame(tick);
        return;
      }

      lastFrameTime = timestamp;
      callback(timestamp);
      animFrameId = requestAnimationFrame(tick);
    }

    // Start the loop
    animFrameId = requestAnimationFrame(tick);

    return {
      /** Stop the throttled loop. */
      stop: function () {
        running = false;
        if (animFrameId != null && typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(animFrameId);
        }
      },
    };
  }

  /**
   * Set the target FPS manually.
   * @param {number} fps
   */
  function setTargetFps(fps) {
    if (typeof fps === 'number' && fps > 0) {
      targetFps = fps;
    }
  }

  /**
   * Get the current target FPS.
   * @returns {number}
   */
  function getTargetFps() {
    return targetFps;
  }

  // ── Focus / power state ──────────────────────────────────────────

  /**
   * Update the focused state and recalculate target FPS.
   * @param {boolean} focused
   */
  function setFocused(focused) {
    isFocused = !!focused;
    _recalculateFps();
  }

  /**
   * Update the battery/AC power state and recalculate target FPS.
   * @param {boolean} onBattery
   */
  function setBatteryState(onBattery) {
    isOnBattery = !!onBattery;
    _recalculateFps();
  }

  /**
   * Check if currently on battery power.
   * @returns {boolean}
   */
  function getIsOnBattery() {
    return isOnBattery;
  }

  // ── Idle detection ───────────────────────────────────────────────

  /**
   * Feed a volume sample for idle detection. Call this from the audio
   * processing callback at the normal sample rate.
   *
   * @param {number} volume — current volume 0-100
   * @param {number} [now] — current timestamp, defaults to Date.now()
   * @returns {boolean} true if audio is now idle
   */
  function updateIdleState(volume, now) {
    const currentTime = typeof now === 'number' ? now : Date.now();

    if (volume >= IDLE_VOLUME_THRESHOLD) {
      // Audio active — reset silence timer
      silenceStartTime = null;
      if (isIdle) {
        isIdle = false;
        _recalculateFps();
        log('[perf] Audio resumed — exiting idle mode');
      }
      return false;
    }

    // Audio is below threshold
    if (silenceStartTime === null) {
      silenceStartTime = currentTime;
    }

    const elapsedSilence = currentTime - silenceStartTime;
    const nowIdle = isIdleAudio(volume, IDLE_VOLUME_THRESHOLD, IDLE_DURATION_MS, elapsedSilence);

    if (nowIdle && !isIdle) {
      isIdle = true;
      _recalculateFps();
      log('[perf] Audio idle detected — reducing resource usage');
    }

    return isIdle;
  }

  /**
   * Get current idle state.
   * @returns {boolean}
   */
  function getIsIdle() {
    return isIdle;
  }

  /**
   * Get the recommended FFT bar count based on current state.
   * @param {number} defaultCount — normal bar count
   * @returns {number}
   */
  function getRecommendedBarCount(defaultCount) {
    return calculateBarCount(defaultCount, isOnBattery, isIdle);
  }

  // ── Memory monitoring ────────────────────────────────────────────

  /**
   * Get current process memory usage stats.
   * @returns {{ heapUsedMb: number, heapTotalMb: number, rssMb: number, externalMb: number }}
   */
  function getMemoryUsage() {
    const mem = process.memoryUsage();
    return {
      heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100,
      heapTotalMb: Math.round((mem.heapTotal / (1024 * 1024)) * 100) / 100,
      rssMb: Math.round((mem.rss / (1024 * 1024)) * 100) / 100,
      externalMb: Math.round((mem.external / (1024 * 1024)) * 100) / 100,
    };
  }

  /**
   * Check memory usage and log a warning if it exceeds the threshold.
   * @returns {boolean} true if memory is above threshold
   */
  function checkMemory() {
    const usage = getMemoryUsage();
    const exceeded = shouldWarnMemory(usage.rssMb, MEMORY_WARNING_THRESHOLD_MB);
    if (exceeded) {
      log(
        '[perf] Memory warning: RSS ' + usage.rssMb + 'MB exceeds ' +
        MEMORY_WARNING_THRESHOLD_MB + 'MB threshold (heap: ' +
        usage.heapUsedMb + '/' + usage.heapTotalMb + 'MB)'
      );
    }
    return exceeded;
  }

  /**
   * Start periodic memory monitoring (every 60s by default).
   * @param {number} [intervalMs=60000]
   */
  function startMemoryMonitoring(intervalMs) {
    const interval = intervalMs || 60000;
    if (memoryCheckInterval) {
      clearInterval(memoryCheckInterval);
    }
    memoryCheckInterval = setInterval(function () {
      checkMemory();
    }, interval);
  }

  /**
   * Stop periodic memory monitoring.
   */
  function stopMemoryMonitoring() {
    if (memoryCheckInterval) {
      clearInterval(memoryCheckInterval);
      memoryCheckInterval = null;
    }
  }

  // ── Cleanup helpers ──────────────────────────────────────────────

  /**
   * Schedule a periodic cleanup task.
   * @param {Function} callback — cleanup function to call
   * @param {number} intervalMs — interval between calls
   * @returns {Function} cancel function to stop the schedule
   */
  function scheduleCleanup(callback, intervalMs) {
    const id = setInterval(callback, intervalMs);
    const cancel = function () {
      clearInterval(id);
      const idx = cleanupSchedules.indexOf(cancel);
      if (idx !== -1) cleanupSchedules.splice(idx, 1);
    };
    cleanupSchedules.push(cancel);
    return cancel;
  }

  /**
   * Prune old sessions from the session store.
   * @param {number} [maxAgeDays=90]
   * @returns {number} number of sessions removed
   */
  function pruneOldSessions(maxAgeDays) {
    if (!sessionStore || typeof sessionStore.pruneOldSessions !== 'function') {
      return 0;
    }
    const days = typeof maxAgeDays === 'number' ? maxAgeDays : SESSION_MAX_AGE_DAYS;
    const removed = sessionStore.pruneOldSessions(days);
    if (removed > 0) {
      log('[perf] Pruned ' + removed + ' sessions older than ' + days + ' days');
    }
    return removed;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Start the performance manager (memory monitoring + session pruning).
   */
  function start() {
    startMemoryMonitoring();
    pruneOldSessions();

    // Try to detect battery state via Electron powerMonitor
    try {
      const { powerMonitor } = require('electron');
      if (powerMonitor) {
        // Check initial state
        if (typeof powerMonitor.isOnBatteryPower === 'function') {
          isOnBattery = powerMonitor.isOnBatteryPower();
        }
        // Listen for changes
        powerMonitor.on('on-ac', function () {
          setBatteryState(false);
        });
        powerMonitor.on('on-battery', function () {
          setBatteryState(true);
        });
      }
    } catch (_e) {
      // Not in Electron main process — skip power monitoring
    }

    _recalculateFps();
  }

  /**
   * Clean up all intervals and resources.
   */
  function destroy() {
    destroyed = true;
    stopMemoryMonitoring();
    // Cancel all scheduled cleanups
    for (var i = 0; i < cleanupSchedules.length; i++) {
      cleanupSchedules[i]();
    }
    cleanupSchedules = [];
  }

  // ── Internal ─────────────────────────────────────────────────────

  function _recalculateFps() {
    targetFps = calculateTargetFps({
      isFocused: isFocused,
      isOnBattery: isOnBattery,
      isIdle: isIdle,
    });
  }

  // ── Public API ───────────────────────────────────────────────────

  return {
    // Frame throttling
    throttleAnimationLoop: throttleAnimationLoop,
    setTargetFps: setTargetFps,
    getTargetFps: getTargetFps,

    // Focus / power
    setFocused: setFocused,
    setBatteryState: setBatteryState,
    getIsOnBattery: getIsOnBattery,

    // Idle detection
    updateIdleState: updateIdleState,
    getIsIdle: getIsIdle,
    getRecommendedBarCount: getRecommendedBarCount,

    // Memory
    getMemoryUsage: getMemoryUsage,
    checkMemory: checkMemory,
    startMemoryMonitoring: startMemoryMonitoring,
    stopMemoryMonitoring: stopMemoryMonitoring,

    // Cleanup
    scheduleCleanup: scheduleCleanup,
    pruneOldSessions: pruneOldSessions,

    // Lifecycle
    start: start,
    destroy: destroy,
  };
}

module.exports = { createPerformanceManager };
