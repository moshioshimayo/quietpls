"use strict";

// Generate UUID in both Node.js and browser environments
function _generateUUID() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Session tracking (quietpls 2.1).
 *
 * Fed the same zone decision the pill and tray show, one call per analysis
 * frame. Time is counted from each frame's audio duration, so capture gaps
 * (mic lost, reconnecting, calibrating) are never charged to any zone.
 *
 *   const tracker = createSessionTracker({ algorithmVersion: 2, sensitivity: 0, margins });
 *   tracker.recordFrame({ zone, relDb }, frameMs);   // zone: silent|normal|warning|danger
 *   const session = tracker.finalize();
 *
 * "Too loud" = red (danger) time over speaking time; yellow (warning) is
 * reported separately as "getting loud".
 */

const SAMPLE_INTERVAL_MS = 100; // relDb sample every 100 ms of speech
const MAX_PEAKS = 5;
const MAX_VOLUME_SAMPLES = 36000; // 1 hour of speech at 10 Hz
const TRACKED_ZONES = ["silent", "normal", "warning", "danger"];

function createSessionTracker(options) {
  const opts = options || {};
  const algorithmVersion = opts.algorithmVersion || 2;

  let sessionStartTime = null; // Date
  let zoneMs = { silent: 0, normal: 0, warning: 0, danger: 0 };
  let volumeSamples = []; // relDb while speaking
  let peakMoments = []; // { timestamp, value: relDb }, descending
  let sinceSampleMs = SAMPLE_INTERVAL_MS;
  let wasSpeaking = false;
  let transitionCount = 0;
  let margins = opts.margins || null;
  let sensitivity = typeof opts.sensitivity === "number" ? opts.sensitivity : 0;
  let baselineDb = typeof opts.baselineDb === "number" ? opts.baselineDb : null;

  const now = opts.now || (() => Date.now());

  function insertPeak(timestamp, value) {
    const entry = { timestamp, value };
    let i = 0;
    while (i < peakMoments.length && peakMoments[i].value >= value) i++;
    if (i >= MAX_PEAKS) return;
    peakMoments.splice(i, 0, entry);
    if (peakMoments.length > MAX_PEAKS) peakMoments.length = MAX_PEAKS;
  }

  function computeVariance(samples) {
    if (samples.length === 0) return 0;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const sumSqDiff = samples.reduce((acc, v) => acc + (v - mean) ** 2, 0);
    return Math.sqrt(sumSqDiff / samples.length);
  }

  /**
   * @param {{ zone: string, relDb?: number|null }} decision
   * @param {number} frameMs — audio duration this decision covers
   */
  function recordFrame(decision, frameMs) {
    if (!decision || TRACKED_ZONES.indexOf(decision.zone) === -1) return;
    const ms = typeof frameMs === "number" && frameMs > 0 ? frameMs : 0;
    if (sessionStartTime === null) sessionStartTime = new Date(now());
    zoneMs[decision.zone] += ms;

    const speaking = decision.zone !== "silent";
    if (speaking && !wasSpeaking) transitionCount++;
    wasSpeaking = speaking;

    if (speaking && typeof decision.relDb === "number") {
      sinceSampleMs += ms;
      if (sinceSampleMs >= SAMPLE_INTERVAL_MS) {
        sinceSampleMs = 0;
        const v = Math.round(decision.relDb * 10) / 10;
        volumeSamples.push(v);
        if (volumeSamples.length > MAX_VOLUME_SAMPLES) volumeSamples.shift();
        insertPeak(new Date(now()).toISOString(), v);
      }
    }
  }

  /** Keep the thresholds stored with the session in step with the live ones. */
  function setThresholds(next) {
    if (!next) return;
    if (next.margins) margins = next.margins;
    if (typeof next.sensitivity === "number") sensitivity = next.sensitivity;
    if (typeof next.baselineDb === "number") baselineDb = next.baselineDb;
  }

  function isSessionActive() {
    return sessionStartTime !== null;
  }

  function getSessionDuration() {
    if (!sessionStartTime) return 0;
    return (now() - sessionStartTime.getTime()) / 1000;
  }

  const round2 = (x) => Math.round(x * 100) / 100;

  function finalize() {
    if (!sessionStartTime) return null;

    const endTime = new Date(now());
    const duration = (endTime.getTime() - sessionStartTime.getTime()) / 1000;
    const zoneTime = {
      silent: round2(zoneMs.silent / 1000),
      normal: round2(zoneMs.normal / 1000),
      warning: round2(zoneMs.warning / 1000),
      danger: round2(zoneMs.danger / 1000),
    };
    const speakingMs = zoneMs.normal + zoneMs.warning + zoneMs.danger;
    const coveredMs = speakingMs + zoneMs.silent;
    const minutes = coveredMs / 60000;

    return {
      id: _generateUUID(),
      algorithmVersion,
      startTime: sessionStartTime.toISOString(),
      endTime: endTime.toISOString(),
      duration: round2(duration),
      coveredTime: round2(coveredMs / 1000),
      gapTime: round2(Math.max(0, duration - coveredMs / 1000)),
      speakingTime: round2(speakingMs / 1000),
      zoneTime,
      tooLoudRatio:
        speakingMs > 0
          ? Math.round((zoneMs.danger / speakingMs) * 10000) / 10000
          : 0,
      gettingLoudRatio:
        speakingMs > 0
          ? Math.round((zoneMs.warning / speakingMs) * 10000) / 10000
          : 0,
      thresholds: {
        baselineDb,
        sensitivity,
        warningDb: margins ? margins.warningDb : null,
        dangerDb: margins ? margins.dangerDb : null,
      },
      volumeSamples: volumeSamples.slice(),
      peakMoments: peakMoments.slice(0, MAX_PEAKS),
      silenceRatio:
        coveredMs > 0
          ? Math.round((zoneMs.silent / coveredMs) * 10000) / 10000
          : 0,
      speakingPace:
        minutes > 0 ? Math.round((transitionCount / minutes) * 100) / 100 : 0,
      volumeVariance: round2(computeVariance(volumeSamples)),
    };
  }

  function reset() {
    sessionStartTime = null;
    zoneMs = { silent: 0, normal: 0, warning: 0, danger: 0 };
    volumeSamples = [];
    peakMoments = [];
    sinceSampleMs = SAMPLE_INTERVAL_MS;
    wasSpeaking = false;
    transitionCount = 0;
  }

  return {
    recordFrame,
    setThresholds,
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createSessionTracker, pruneSessions };
} else if (typeof window !== "undefined") {
  window.SessionTracker = { createSessionTracker, pruneSessions };
}
