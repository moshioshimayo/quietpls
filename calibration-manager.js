"use strict";

/**
 * calibration-manager.js — guided "talk normally" calibration (quietpls 2.1).
 *
 * Fed the same worklet frames used for monitoring. Only voiced frames (frames
 * that passed the speech gate themselves, not hangover padding) count toward
 * the required speech time and the baseline. Time is measured in audio frames
 * (frameMs), so gaps in capture never count as listening time.
 *
 * Speech rises and falls syllable by syllable; a fan or tone does not. An
 * attempt whose speech-band frame levels barely vary (std-dev below
 * minModulationDb) is rejected as "no-speech", even if the gate let it through
 * (e.g. a stationary noise that just got louder, before the floor adapts).
 *
 *   start()          fresh attempt (clears every sample and status)
 *   addFrame(frame)  → null while listening, or the finished result:
 *     { status: "ok", baselineDb, speechMs, frames }
 *     { status: "no-speech", speechMs }   (not enough speech before timeout)
 *     { status: "clipping", speechMs }    (input distorts; move back / lower gain)
 *
 * The baseline is the median dBFS of the accepted speech frames.
 *
 * Dual export: CommonJS + window.CalibrationManager.
 */

const CALIBRATION_VERSION = 2;
const DEFAULTS = Object.freeze({
  minSpeechMs: 2000, // of voiced speech (~5 s of normal talking, per the prompt)
  timeoutMs: 10000, // audio time to wait for that much speech
  maxClipRatio: 0.1,
  minModulationDb: 3, // speech: 5-18 dB measured; stationary tone: ~0.5 dB
});

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stdDev(values) {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length,
  );
}

function createCalibrationManager(options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  let status = "idle"; // idle | calibrating | ok | no-speech | clipping
  let levels = [];
  let bandLevels = []; // speech-band level of every gated frame, for modulation
  let speechMs = 0;
  let listenedMs = 0;
  let clipFrames = 0;
  let result = null;

  function start() {
    status = "calibrating";
    levels = [];
    bandLevels = [];
    speechMs = 0;
    listenedMs = 0;
    clipFrames = 0;
    result = null;
  }

  function finish(r) {
    status = r.status;
    result = r;
    return r;
  }

  function addFrame(frame) {
    if (status !== "calibrating" || !frame || frame.noInput) return null;
    const ms = typeof frame.frameMs === "number" ? frame.frameMs : 20;
    listenedMs += ms;
    const voiced = frame.voiced === undefined ? frame.speech : frame.voiced;
    if (frame.speech && typeof frame.bandDb === "number")
      bandLevels.push(frame.bandDb);
    if (
      voiced &&
      typeof frame.dbfs === "number" &&
      Number.isFinite(frame.dbfs)
    ) {
      levels.push(frame.dbfs);
      speechMs += ms;
      if (frame.clip) clipFrames++;
    }

    if (speechMs >= opts.minSpeechMs) {
      if (clipFrames / levels.length > opts.maxClipRatio) {
        return finish({ status: "clipping", speechMs });
      }
      if (bandLevels.length > 0 && stdDev(bandLevels) < opts.minModulationDb) {
        return finish({ status: "no-speech", speechMs, reason: "stationary" });
      }
      return finish({
        status: "ok",
        baselineDb: Math.round(median(levels) * 10) / 10,
        speechMs,
        frames: levels.length,
      });
    }
    if (listenedMs >= opts.timeoutMs) {
      return finish({ status: "no-speech", speechMs });
    }
    return null;
  }

  return {
    start,
    addFrame,
    isCalibrating: () => status === "calibrating",
    getStatus: () => status,
    getResult: () => result,
    /** 0–1 share of the required speech heard so far. */
    getProgress: () => Math.min(1, speechMs / opts.minSpeechMs),
  };
}

/**
 * Stored record for one real device. Older (score-based, version-less)
 * records are not valid and must be ignored.
 */
function makeCalibrationRecord(result, device, now) {
  return {
    version: CALIBRATION_VERSION,
    baselineDb: result.baselineDb,
    speechMs: result.speechMs,
    deviceId: device && device.deviceId,
    deviceLabel: (device && device.label) || "",
    calibratedAt: new Date(now || Date.now()).toISOString(),
  };
}

function isValidCalibrationRecord(record) {
  return (
    !!record &&
    record.version === CALIBRATION_VERSION &&
    typeof record.baselineDb === "number" &&
    Number.isFinite(record.baselineDb)
  );
}

const _calibrationExports = {
  CALIBRATION_VERSION,
  DEFAULTS,
  createCalibrationManager,
  makeCalibrationRecord,
  isValidCalibrationRecord,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = _calibrationExports;
} else if (typeof window !== "undefined") {
  window.CalibrationManager = _calibrationExports;
}
