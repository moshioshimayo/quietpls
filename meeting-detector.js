'use strict';

const { execFile: _defaultExecFile } = require('child_process');

/**
 * Map of process names (from `ps -eo comm=`) to canonical app names.
 * Multiple process names can map to the same app (deduplication via Set).
 */
const MEETING_PROCESSES = {
  'zoom.us':           'Zoom',
  'CptHost':           'Zoom',
  'Microsoft Teams':   'Microsoft Teams',
  'Teams':             'Microsoft Teams',
  'Slack':             'Slack',
  'Discord':           'Discord',
  'FaceTime':          'FaceTime',
  'Webex':             'Webex',
  'CiscoWebExStart':   'Webex',
};

/**
 * Poll running processes and return an array of detected meeting app names.
 * Uses a single `ps -eo comm=` call per poll.
 *
 * @param {number} timeoutMs - Maximum time to wait for ps command
 * @param {Function} execFileFn - The execFile function to use
 * @returns {Promise<string[]>} Deduplicated array of app names
 */
function pollProcesses(timeoutMs, execFileFn) {
  return new Promise((resolve, reject) => {
    execFileFn('ps', ['-eo', 'comm='], { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      const lines = stdout.split('\n');
      const detected = new Set();
      for (const line of lines) {
        const trimmed = line.trim();
        for (const [procName, appName] of Object.entries(MEETING_PROCESSES)) {
          if (trimmed === procName || trimmed.endsWith('/' + procName)) {
            detected.add(appName);
          }
        }
      }
      resolve([...detected]);
    });
  });
}

/**
 * Compare two sorted string arrays for equality.
 */
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Factory function to create a meeting detector instance.
 *
 * @param {Object} options
 * @param {number} [options.pollIntervalMs=10000] - Milliseconds between polls
 * @param {number} [options.graceMs=30000] - Grace period after all apps close
 * @param {number} [options.timeoutMs=3000] - Timeout for ps command
 * @returns {Object} Meeting detector API
 */
function createMeetingDetector({
  pollIntervalMs = 10000,
  graceMs = 30000,
  timeoutMs = 3000,
  _execFile = _defaultExecFile,
} = {}) {
  let pollTimer = null;
  let graceTimeout = null;
  let lastDetectedApps = [];
  let callbacks = [];
  let destroyed = false;

  function fireCallback(data) {
    for (const cb of callbacks) {
      try { cb(data); } catch (_) { /* ignore listener errors */ }
    }
  }

  async function poll() {
    if (destroyed) return;
    try {
      const apps = await pollProcesses(timeoutMs, _execFile);
      if (destroyed) return;

      const wasDetected = lastDetectedApps.length > 0;
      const isNowDetected = apps.length > 0;

      if (isNowDetected) {
        // Clear any pending grace timeout
        if (graceTimeout) {
          clearTimeout(graceTimeout);
          graceTimeout = null;
        }
        if (!arraysEqual(apps, lastDetectedApps)) {
          lastDetectedApps = apps;
          fireCallback({ detected: true, apps });
        }
      } else if (wasDetected && !graceTimeout) {
        // All apps closed — start grace period
        graceTimeout = setTimeout(() => {
          if (destroyed) return;
          lastDetectedApps = [];
          graceTimeout = null;
          fireCallback({ detected: false, apps: [] });
        }, graceMs);
      }
    } catch (err) {
      // Skip this cycle — will retry on next interval
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[MeetingDetector] Poll error:', err.message);
      }
    }
  }

  function start() {
    if (destroyed || pollTimer !== null) return;
    // Fire first poll immediately
    poll();
    pollTimer = setInterval(poll, pollIntervalMs);
  }

  function stop() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function isDetected() {
    return lastDetectedApps.length > 0;
  }

  function getDetectedApps() {
    return [...lastDetectedApps];
  }

  function onDetectionChange(callback) {
    callbacks.push(callback);
  }

  function destroy() {
    destroyed = true;
    stop();
    if (graceTimeout) {
      clearTimeout(graceTimeout);
      graceTimeout = null;
    }
    callbacks = [];
    lastDetectedApps = [];
  }

  return {
    start,
    stop,
    isDetected,
    getDetectedApps,
    onDetectionChange,
    destroy,
  };
}

module.exports = { createMeetingDetector };
