"use strict";

/**
 * calibration-manager.js — guided "talk normally" calibration (quietpls 2.1).
 *
 * Fed the same worklet frames used for monitoring. Talking time is the speech
 * gate's own time (voiced frames plus its 300 ms hangover over syllable and
 * breath gaps), the way a person hears themself talking: natural speech has
 * only ~40-55% voiced frames, ~15% from a far mic (2.4.1 bug: nonstop talking
 * could fail). Hangover counts only after a voiced frame in this attempt. The
 * baseline uses voiced frames only. Time is measured in audio frames
 * (frameMs), so gaps in capture never count as listening time.
 *
 * Speech rises and falls syllable by syllable; a fan or tone does not. An
 * attempt whose speech-band frame levels barely vary (std-dev below
 * minModulationDb) is rejected as "no-speech", even if the gate let it through
 * (e.g. a stationary noise that just got louder, before the floor adapts).
 *
 * Near miss (2.5): if the input window ends with at least nearMissMs of
 * talking, it extends once by extendMs; talking heard so far is kept.
 *
 *   start()          fresh attempt (clears every sample and status)
 *   addFrame(frame)  → null while listening, or the finished result:
 *     { status: "ok", baselineDb, speechMs, frames }
 *     { status: "no-speech", speechMs, reason: "no-talking" | "stationary" }
 *     { status: "clipping", speechMs, reason: "clipping" }
 *   getProgress()        0–1 share of the required talking
 *   getProgressDetails() { speechMs, listenedMs, extended, hint } where hint is
 *     advisory while listening (never an acceptance rule):
 *     "too-strong"  > hintClipRatio of voiced frames clipped in the last hintClipMs
 *     "noise"       steady input (≥ noiseDb) and no talking for the last noiseMs
 *     null          otherwise
 *
 * The baseline is the duration-weighted mean power of voiced frames.
 *
 * Dual export: CommonJS + window.CalibrationManager.
 */

const CALIBRATION_VERSION = 3;
const DEFAULTS = Object.freeze({
  minSpeechMs: 10000, // talking time (speech gate, including hangover)
  timeoutMs: 40000, // valid input audio time
  maxClipRatio: 0.1,
  minModulationDb: 3, // speech: 5-18 dB measured; stationary tone: ~0.5 dB
  nearMissMs: 7000, // talking heard at timeoutMs that earns one extension
  extendMs: 20000,
  noiseMs: 5000,
  noiseDb: -50, // quiet speech over a -65 room still calibrates; rooms sit below this
  hintClipMs: 2000,
  hintClipRatio: 0.2,
});

function stdDev(values) {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length,
  );
}

function createCalibrationManager(options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  let status = "idle"; // idle | calibrating | ok | no-speech | clipping
  let voicedFrames = 0;
  let voicedEnergy = 0;
  let voicedMs = 0;
  let bandLevels = []; // speech-band level of every gated frame, for modulation
  let speechMs = 0;
  let listenedMs = 0;
  let clipFrames = 0;
  let limitMs = opts.timeoutMs;
  let recent = []; // last noiseMs of frames, for the live hints
  let recentMs = 0;
  let result = null;

  function start() {
    status = "calibrating";
    voicedFrames = 0;
    voicedEnergy = 0;
    voicedMs = 0;
    bandLevels = [];
    speechMs = 0;
    listenedMs = 0;
    clipFrames = 0;
    limitMs = opts.timeoutMs;
    recent = [];
    recentMs = 0;
    result = null;
  }

  function hint() {
    let ms = 0;
    let voiced = 0;
    let clipped = 0;
    let steadyMs = 0;
    let talked = false;
    for (let i = recent.length - 1; i >= 0; i--) {
      const f = recent[i];
      if (ms < opts.hintClipMs && f.voiced) {
        voiced++;
        if (f.clip) clipped++;
      }
      ms += f.ms;
      if (f.talked) talked = true;
      if (f.loud) steadyMs += f.ms;
    }
    if (voiced > 0 && clipped / voiced > opts.hintClipRatio) return "too-strong";
    if (!talked && ms >= opts.noiseMs && steadyMs >= ms * 0.8) return "noise";
    return null;
  }

  function finish(r) {
    status = r.status;
    result = r;
    return r;
  }

  function addFrame(frame) {
    if (status !== "calibrating" || !frame || frame.noInput) return null;
    const ms = frame.frameMs;
    if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(frame.dbfs)) return null;
    listenedMs += ms;
    const voiced = frame.voiced === true;
    if (frame.speech && Number.isFinite(frame.bandDb))
      bandLevels.push(frame.bandDb);
    if (voiced) {
      voicedFrames++;
      voicedEnergy += Math.pow(10, frame.dbfs / 10) * ms;
      voicedMs += ms;
      if (frame.clip) clipFrames++;
    }
    const talked = voiced || (frame.speech === true && voicedFrames > 0);
    if (talked) speechMs += ms;
    recent.push({ ms, talked, voiced, clip: voiced && !!frame.clip, loud: frame.dbfs >= opts.noiseDb });
    recentMs += ms;
    while (recentMs - recent[0].ms >= opts.noiseMs) recentMs -= recent.shift().ms;

    if (speechMs >= opts.minSpeechMs) {
      if (clipFrames / voicedFrames > opts.maxClipRatio) {
        return finish({ status: "clipping", speechMs, reason: "clipping" });
      }
      if (bandLevels.length > 0 && stdDev(bandLevels) < opts.minModulationDb) {
        return finish({ status: "no-speech", speechMs, reason: "stationary" });
      }
      return finish({
        status: "ok",
        baselineDb: Math.round(10 * Math.log10(voicedEnergy / voicedMs) * 10) / 10,
        speechMs,
        frames: voicedFrames,
      });
    }
    if (listenedMs >= limitMs) {
      if (limitMs === opts.timeoutMs && speechMs >= opts.nearMissMs) {
        limitMs += opts.extendMs;
        return null;
      }
      const reason = hint() === "noise" ? "stationary" : "no-talking";
      return finish({ status: "no-speech", speechMs, reason });
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
    getProgressDetails: () => ({
      speechMs,
      listenedMs,
      extended: limitMs > opts.timeoutMs,
      hint: status === "calibrating" ? hint() : null,
    }),
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
