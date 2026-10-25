'use strict';

/**
 * Auto-calibration manager for voice monitoring (US-007).
 *
 * Pure logic module — no Electron dependencies.  Collects volume samples
 * during a calibration window, then computes a median-based baseline and
 * derives dynamic thresholds relative to the user's normal speaking level.
 *
 * Dual export: CommonJS module.exports + window.CalibrationManager
 */

const DEFAULT_OPTIONS = {
  duration: 30000,         // 30-second calibration window (ms)
  minSamples: 50,          // minimum samples for valid calibration
  noiseFloor: 0.05,        // samples below this = silence (0-100 scale)
  mutedThreshold: 0.01,    // samples below this = muted mic
  baselineCeiling: 60,     // cap baseline for high-noise environments
  cachedCalibration: null,  // previously stored calibration or null
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computeCalibration(samples) {
  // 1. Sort ascending
  const sorted = [...samples].sort((a, b) => a - b);

  // 2. Take lower 75th percentile (discard top 25% as outlier spikes)
  const cutoff = Math.floor(sorted.length * 0.75);
  const trimmed = sorted.slice(0, cutoff);

  // 3. Compute median of trimmed samples -> baseline
  const mid = Math.floor(trimmed.length / 2);
  const baseline = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  // 4. Derive thresholds via multipliers with clamp ranges
  const quiet   = clamp(baseline * 0.6, 5, 40);
  const normal  = clamp(baseline * 1.5, 30, 80);
  const warning = clamp(baseline * 2.2, 55, 95);

  // 5. Enforce ordering invariant: quiet < normal < warning
  //    If clamp ranges produce a violation, push upward with 5-unit gap
  let q = quiet, n = normal, w = warning;
  if (n <= q + 5) n = q + 5;
  if (w <= n + 5) w = n + 5;
  // Final safety clamp
  w = Math.min(w, 95);
  n = Math.min(n, w - 5);
  q = Math.min(q, n - 5);

  return {
    baseline: Math.round(baseline * 100) / 100,
    thresholds: {
      quiet: Math.round(q),
      normal: Math.round(n),
      warning: Math.round(w),
    },
  };
}

function createCalibrationManager(options) {
  const opts = Object.assign({}, DEFAULT_OPTIONS, options);

  let samples = [];
  let calibrating = false;
  let calibrated = false;
  let startTime = null;
  let thresholds = null;
  let calibrationData = null;
  let completionStatus = null;
  let completeCallbacks = [];
  let callbackFired = false;

  // If cached calibration provided, use thresholds immediately but still
  // run calibration to update with fresh data (per PRD: always calibrate every session)
  if (opts.cachedCalibration && opts.cachedCalibration.thresholds) {
    thresholds = { ...opts.cachedCalibration.thresholds };
    calibrationData = { ...opts.cachedCalibration };
    // Note: calibrated stays false so isCalibrating() returns true during addSample phase
  }

  function fireCallbacks(result) {
    if (callbackFired) return;
    callbackFired = true;
    for (const cb of completeCallbacks) {
      cb(result);
    }
  }

  function finishCalibration() {
    calibrating = false;

    // Edge case: not enough samples
    if (samples.length < opts.minSamples) {
      completionStatus = {
        status: 'insufficient',
        message: 'Not enough samples for calibration.',
      };
      fireCallbacks({ status: 'insufficient', message: completionStatus.message });
      return;
    }

    // Edge case: muted mic (all samples < mutedThreshold)
    const allBelowMuted = samples.every(s => s < opts.mutedThreshold);
    if (allBelowMuted) {
      completionStatus = {
        status: 'muted',
        message: 'Mic appears muted. Unmute to calibrate.',
      };
      fireCallbacks({ status: 'muted', message: completionStatus.message });
      return;
    }

    // Edge case: silent input (all samples < noiseFloor)
    const allBelowNoise = samples.every(s => s < opts.noiseFloor);
    if (allBelowNoise) {
      completionStatus = {
        status: 'silent',
        message: 'Calibration skipped — no voice detected',
      };
      fireCallbacks({ status: 'silent', message: completionStatus.message });
      return;
    }

    // Normal computation
    let result = computeCalibration(samples);

    // Edge case: high noise — cap baseline and recompute
    if (result.baseline > opts.baselineCeiling) {
      // Recompute thresholds from capped baseline
      const cappedBaseline = opts.baselineCeiling;
      const quiet   = clamp(cappedBaseline * 0.6, 5, 40);
      const normal  = clamp(cappedBaseline * 1.5, 30, 80);
      const warning = clamp(cappedBaseline * 2.2, 55, 95);

      let q = quiet, n = normal, w = warning;
      if (n <= q + 5) n = q + 5;
      if (w <= n + 5) w = n + 5;
      w = Math.min(w, 95);
      n = Math.min(n, w - 5);
      q = Math.min(q, n - 5);

      result = {
        baseline: cappedBaseline,
        thresholds: {
          quiet: Math.round(q),
          normal: Math.round(n),
          warning: Math.round(w),
        },
      };

      completionStatus = {
        status: 'high-noise',
        message: 'High background noise detected. Thresholds adjusted.',
      };
    } else {
      completionStatus = { status: 'ok' };
    }

    calibrated = true;
    thresholds = { ...result.thresholds };
    calibrationData = {
      baseline: result.baseline,
      thresholds: { ...result.thresholds },
      calibratedAt: new Date().toISOString(),
      sampleCount: samples.length,
    };

    fireCallbacks({
      baseline: result.baseline,
      thresholds: { ...result.thresholds },
      sampleCount: samples.length,
      status: completionStatus.status,
      message: completionStatus.message,
    });
  }

  function addSample(volume) {
    // No-op after calibration is complete (unless reset was called)
    if (calibrated && !calibrating) return;

    // Start calibration timer on first sample
    if (!calibrating && !calibrated) {
      calibrating = true;
      startTime = Date.now();
    }

    samples.push(volume);

    // Check if calibration duration has elapsed
    if (calibrating && (Date.now() - startTime) >= opts.duration) {
      finishCalibration();
    }
  }

  function isCalibrating() {
    return calibrating;
  }

  function isCalibrated() {
    return calibrated;
  }

  function getThresholds() {
    if (thresholds) return { ...thresholds };
    // Default thresholds when nothing is calibrated or cached
    return { quiet: 30, normal: 50, warning: 78 };
  }

  function getCalibrationData() {
    if (calibrationData) return { ...calibrationData };
    return null;
  }

  function getStatus() {
    return completionStatus;
  }

  function onComplete(callback) {
    if (typeof callback !== 'function') return;

    // If already calibrated (e.g. from cache or completed), fire immediately
    if (calibrated && !calibrating) {
      // Fire asynchronously to be consistent
      const data = calibrationData
        ? { baseline: calibrationData.baseline, thresholds: { ...calibrationData.thresholds }, sampleCount: calibrationData.sampleCount }
        : null;
      if (data) {
        // For cached calibrations, only fire if callback hasn't been fired yet
        if (!callbackFired) {
          callbackFired = true;
          callback(data);
        }
      }
      return;
    }

    completeCallbacks.push(callback);
  }

  function reset() {
    samples = [];
    calibrating = false;
    calibrated = false;
    startTime = null;
    completionStatus = null;
    callbackFired = false;
    completeCallbacks = [];
    // Do NOT clear thresholds or calibrationData — keep current thresholds
    // active until new calibration completes
  }

  return {
    addSample,
    isCalibrating,
    isCalibrated,
    getThresholds,
    getCalibrationData,
    getStatus,
    onComplete,
    reset,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createCalibrationManager, computeCalibration };
} else if (typeof window !== 'undefined') {
  window.CalibrationManager = { createCalibrationManager, computeCalibration };
}
