"use strict";

const path = require("path");
const { execFile: _defaultExecFile } = require("child_process");

/**
 * A call is "detected" while any OTHER process is capturing audio input
 * (Zoom, Teams, Meet in a browser, FaceTime, ...). The native helper
 * mic-users (native/mic-users.swift) lists the processes whose CoreAudio
 * input is running, one "<pid>\t<bundle id>" line each (macOS 14+).
 * quietpls's own processes are excluded via getOwnPids so its own
 * monitoring never counts as a call.
 */
const DEV_HELPER_PATH = path.join(__dirname, "bin", "mic-users");

// macOS speech services ("Hey Siri", dictation) listen briefly; not a call.
const SYSTEM_LISTENERS =
  /^com\.apple\.(CoreSpeech|corespeechd|assistantd|Siri|SpeechRecognitionCore)/i;

/** Parse helper output into [{ pid, bundleId }]. */
function parseMicUsers(stdout) {
  const users = [];
  for (const line of String(stdout || "").split("\n")) {
    const [pidText, bundleId = ""] = line.split("\t");
    const pid = Number(pidText);
    if (pidText && Number.isInteger(pid) && pid > 0) {
      users.push({ pid, bundleId: bundleId.trim() });
    }
  }
  return users;
}

function pollMicUsers(helperPath, timeoutMs, execFileFn) {
  return new Promise((resolve, reject) => {
    execFileFn(helperPath, [], { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(parseMicUsers(stdout));
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
 * @param {number} [options.pollIntervalMs=3000] - Milliseconds between polls
 * @param {number} [options.graceMs=30000] - Grace period after the mic is released
 * @param {number} [options.timeoutMs=3000] - Timeout for the helper
 * @param {Function} [options.getOwnPids] - Returns quietpls's own pids to ignore
 * @param {string} [options.helperPath] - Path to the mic-users helper
 * @returns {Object} Meeting detector API
 */
function createMeetingDetector({
  pollIntervalMs = 3000,
  graceMs = 30000,
  timeoutMs = 3000,
  getOwnPids = () => [process.pid],
  helperPath = DEV_HELPER_PATH,
  _execFile = _defaultExecFile,
} = {}) {
  let pollTimer = null;
  let graceTimeout = null;
  let lastDetectedApps = [];
  let callbacks = [];
  let destroyed = false;
  let generation = 0; // bumped by stop(): results of older polls are dropped

  function fireCallback(data) {
    for (const cb of callbacks) {
      try {
        cb(data);
      } catch (_) {
        /* ignore listener errors */
      }
    }
  }

  async function poll() {
    if (destroyed) return;
    const gen = generation;
    try {
      const users = await pollMicUsers(helperPath, timeoutMs, _execFile);
      if (destroyed || gen !== generation) return;

      const own = new Set(getOwnPids());
      const apps = [
        ...new Set(
          users
            .filter(
              (u) => !own.has(u.pid) && !SYSTEM_LISTENERS.test(u.bundleId),
            )
            .map((u) => u.bundleId || "pid " + u.pid),
        ),
      ];

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
        // Mic released — start grace period
        graceTimeout = setTimeout(() => {
          if (destroyed) return;
          lastDetectedApps = [];
          graceTimeout = null;
          fireCallback({ detected: false, apps: [] });
        }, graceMs);
      }
    } catch (err) {
      if (gen !== generation) return;
      if (!err.killed) {
        // Helper missing, or it can't run (macOS < 14): detection is unavailable.
        console.warn(
          "[MeetingDetector] Mic-use helper unavailable:",
          err.message,
        );
        stop();
        return;
      }
      // Timed out — skip this cycle, retry on the next interval
      console.warn("[MeetingDetector] Poll timed out");
    }
  }

  function start() {
    if (destroyed || pollTimer !== null) return;
    // Fire first poll immediately
    poll();
    pollTimer = setInterval(poll, pollIntervalMs);
  }

  /** Stop polling and end any detection (listeners get detected:false). */
  function stop() {
    generation++;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (graceTimeout) {
      clearTimeout(graceTimeout);
      graceTimeout = null;
    }
    if (lastDetectedApps.length > 0) {
      lastDetectedApps = [];
      if (!destroyed) fireCallback({ detected: false, apps: [] });
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

module.exports = { createMeetingDetector, parseMicUsers };
