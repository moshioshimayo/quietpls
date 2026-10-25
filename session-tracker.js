'use strict';

// Generate UUID in both Node.js and browser environments
function _generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Session detection and tracking module (US-011).
 *
 * Pure logic — no Electron or storage imports.  The caller is responsible for
 * persisting the finalised session object via IPC.
 *
 * Usage:
 *   const tracker = createSessionTracker({ quietThreshold: 30, normalThreshold: 50, warningThreshold: 78 });
 *   // on every volume update from the AudioWorklet:
 *   tracker.recordVolume(averageVolume);
 *   // when monitoring stops:
 *   const session = tracker.finalize();
 */

const SESSION_DETECTION_SECONDS = 60;
const SAMPLE_INTERVAL_MS = 100; // 10 Hz
const MAX_PEAKS = 5;
const MAX_VOLUME_SAMPLES = 36000; // Cap at 1 hour of 10 Hz data to prevent memory leak

function createSessionTracker(thresholds) {
  const { quietThreshold, normalThreshold, warningThreshold } = thresholds;

  // ---- internal state ----
  let sessionActive = false;
  let sessionStartTime = null;       // Date
  let lastSampleTime = null;         // timestamp (ms) of last 10 Hz sample
  let lastZoneTime = null;           // timestamp (ms) used for zone accumulation
  let volumeSamples = [];
  let peakMoments = [];              // sorted descending by value, max 5
  let zoneTime = { silent: 0, quiet: 0, normal: 0, loud: 0 };
  let consecutiveActiveMs = 0;       // ms of continuous above-quiet activity
  let consecutiveSilenceMs = 0;      // ms of silence during detection (grace period)
  const DETECTION_GRACE_MS = 5000;   // allow up to 5s silence without resetting
  let lastVolume = null;             // previous volume for transition detection
  let wasAboveQuiet = false;         // for speaking pace transitions
  let transitionCount = 0;           // silence → speech transitions
  let totalElapsedMs = 0;            // total tracked time for pace calculation
  let lastRecordTime = null;         // timestamp of last recordVolume call

  // ---- helpers ----

  function classifyZone(volume) {
    if (volume < quietThreshold) return 'silent';
    if (volume < normalThreshold) return 'quiet';
    if (volume < warningThreshold) return 'normal';
    return 'loud';
  }

  function insertPeak(timestamp, value) {
    const entry = { timestamp, value };
    // Insert in sorted position (descending by value)
    let inserted = false;
    for (let i = 0; i < peakMoments.length; i++) {
      if (value > peakMoments[i].value) {
        peakMoments.splice(i, 0, entry);
        inserted = true;
        break;
      }
    }
    if (!inserted && peakMoments.length < MAX_PEAKS) {
      peakMoments.push(entry);
    }
    if (peakMoments.length > MAX_PEAKS) {
      peakMoments.length = MAX_PEAKS;
    }
  }

  function computeVariance(samples) {
    if (samples.length === 0) return 0;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const sumSqDiff = samples.reduce((acc, v) => acc + (v - mean) ** 2, 0);
    return Math.sqrt(sumSqDiff / samples.length);
  }

  // ---- public API ----

  function recordVolume(volume) {
    const now = Date.now();

    // First call — activate session immediately
    if (lastRecordTime === null) {
      lastRecordTime = now;
      lastSampleTime = now;
      lastZoneTime = now;
      lastVolume = volume;
      wasAboveQuiet = volume >= quietThreshold;
      sessionActive = true;
      sessionStartTime = new Date(now);
      return;
    }

    const deltaMs = now - lastRecordTime;
    lastRecordTime = now;

    // ---- Zone accumulation ----
    const zoneDelta = (now - lastZoneTime) / 1000; // seconds
    const zone = classifyZone(volume);
    zoneTime[zone] += zoneDelta;
    lastZoneTime = now;
    totalElapsedMs += deltaMs;

    // ---- Speaking pace (silence → speech transitions) ----
    const isAboveQuiet = volume >= quietThreshold;
    if (isAboveQuiet && !wasAboveQuiet) {
      transitionCount++;
    }
    wasAboveQuiet = isAboveQuiet;

    // ---- 10 Hz sampling ----
    if (now - lastSampleTime >= SAMPLE_INTERVAL_MS) {
      volumeSamples.push(volume);
      // Prevent unbounded growth on very long sessions
      if (volumeSamples.length > MAX_VOLUME_SAMPLES) {
        volumeSamples.shift();
      }
      lastSampleTime = now;

      // Peak tracking
      insertPeak(new Date(now).toISOString(), volume);
    }

    lastVolume = volume;
  }

  function isSessionActive() {
    return sessionActive;
  }

  function getSessionDuration() {
    if (!sessionActive || !sessionStartTime) return 0;
    return (Date.now() - sessionStartTime.getTime()) / 1000;
  }

  function finalize() {
    if (!sessionActive) return null;

    const endTime = new Date(Date.now());
    const duration = (endTime.getTime() - sessionStartTime.getTime()) / 1000;

    const totalZoneSec = zoneTime.silent + zoneTime.quiet + zoneTime.normal + zoneTime.loud;
    const silenceRatio = totalZoneSec > 0
      ? zoneTime.silent / totalZoneSec
      : 0;

    const totalMinutes = totalElapsedMs / 60000;
    const speakingPace = totalMinutes > 0
      ? Math.round((transitionCount / totalMinutes) * 100) / 100
      : 0;

    const volumeVariance = computeVariance(volumeSamples);

    return {
      id: _generateUUID(),
      startTime: sessionStartTime.toISOString(),
      endTime: endTime.toISOString(),
      duration: Math.round(duration * 100) / 100,
      volumeSamples: volumeSamples.slice(),
      peakMoments: peakMoments.slice(0, MAX_PEAKS),
      zoneTime: {
        silent: Math.round(zoneTime.silent * 100) / 100,
        quiet: Math.round(zoneTime.quiet * 100) / 100,
        normal: Math.round(zoneTime.normal * 100) / 100,
        loud: Math.round(zoneTime.loud * 100) / 100,
      },
      silenceRatio: Math.round(silenceRatio * 10000) / 10000,
      speakingPace,
      volumeVariance: Math.round(volumeVariance * 100) / 100,
    };
  }

  function reset() {
    sessionActive = false;
    sessionStartTime = null;
    lastSampleTime = null;
    lastZoneTime = null;
    volumeSamples = [];
    peakMoments = [];
    zoneTime = { silent: 0, quiet: 0, normal: 0, loud: 0 };
    consecutiveActiveMs = 0;
    consecutiveSilenceMs = 0;
    lastVolume = null;
    wasAboveQuiet = false;
    transitionCount = 0;
    totalElapsedMs = 0;
    lastRecordTime = null;
  }

  return {
    recordVolume,
    isSessionActive,
    getSessionDuration,
    finalize,
    reset,
  };
}

/**
 * Prune sessions list to keep at most `maxSessions` entries (oldest first).
 * Returns a new array — does not mutate the input.
 */
function pruneSessions(sessions, maxSessions = 50) {
  if (sessions.length <= maxSessions) return sessions.slice();
  // Sessions are assumed ordered oldest-first. Keep the last `maxSessions`.
  return sessions.slice(sessions.length - maxSessions);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createSessionTracker, pruneSessions };
} else if (typeof window !== 'undefined') {
  window.SessionTracker = { createSessionTracker, pruneSessions };
}
