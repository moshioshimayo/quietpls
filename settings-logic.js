'use strict';

// Pure logic helpers for settings — no DOM or browser dependencies.
// Used by settings-renderer.js and tested directly by vitest.

/**
 * Validate a threshold value, clamping it to [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampThreshold(value, min, max) {
  if (typeof value !== 'number' || isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Validate and enforce ordering constraints on all three thresholds.
 * Returns a sanitised config object.
 * @param {{ quietThreshold: number, normalThreshold: number, warningThreshold: number }} thresholds
 * @returns {{ quietThreshold: number, normalThreshold: number, warningThreshold: number }}
 */
function validateThresholds(thresholds) {
  let q = clampThreshold(thresholds.quietThreshold, 1, 98);
  let n = clampThreshold(thresholds.normalThreshold, 2, 99);
  let w = clampThreshold(thresholds.warningThreshold, 3, 100);

  // Enforce strict ordering: quiet < normal < warning
  if (n <= q) n = q + 1;
  if (w <= n) w = n + 1;

  // Re-clamp after ordering adjustments
  n = Math.min(n, 99);
  w = Math.min(w, 100);
  if (n <= q) q = n - 1;

  return {
    quietThreshold: Math.max(1, q),
    normalThreshold: Math.max(2, n),
    warningThreshold: Math.max(3, w)
  };
}

/**
 * Filter audioinput devices from a MediaDeviceInfo list.
 * @param {MediaDeviceInfo[]} devices
 * @returns {{ deviceId: string, label: string }[]}
 */
function filterAudioInputDevices(devices) {
  if (!Array.isArray(devices)) return [];
  return devices
    .filter(d => d.kind === 'audioinput' && d.deviceId !== 'default')
    .map(d => ({
      deviceId: d.deviceId,
      label: d.label || 'Microphone (' + d.deviceId.substring(0, 8) + ')'
    }));
}

/**
 * Determine the zone name for a given volume level based on thresholds.
 * @param {number} volume  0-100
 * @param {{ quietThreshold: number, normalThreshold: number, warningThreshold: number }} thresholds
 * @returns {'quiet'|'normal'|'loud'|'danger'}
 */
function getZoneForVolume(volume, thresholds) {
  if (volume < thresholds.quietThreshold) return 'quiet';
  if (volume < thresholds.normalThreshold) return 'normal';
  if (volume < thresholds.warningThreshold) return 'loud';
  return 'danger';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { clampThreshold, validateThresholds, filterAudioInputDevices, getZoneForVolume };
} else if (typeof window !== 'undefined') {
  window.SettingsLogic = { clampThreshold, validateThresholds, filterAudioInputDevices, getZoneForVolume };
}
