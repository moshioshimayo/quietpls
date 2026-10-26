"use strict";

/**
 * level-logic.js — the single zone decision for quietpls 2.1.
 *
 * Levels are digital (dBFS) from one microphone. They are compared with the
 * user's own calibrated "normal" level for that mic, so every number shown is
 * "dB above your normal", never an acoustic (SPL) loudness.
 *
 * Pure logic. Dual export: CommonJS + window.LevelLogic.
 */

// Bump when the measurement or zone rules change; stored with every session.
const ALGORITHM_VERSION = 2;

// Yellow ("getting loud") and red ("too loud") margins above the baseline.
const WARNING_MARGIN_DB = 6;
const DANGER_MARGIN_DB = 10;
// Sensitivity shifts both margins: +4 = warn 4 dB earlier, -4 = 4 dB later.
const SENSITIVITY_MIN = -4;
const SENSITIVITY_MAX = 4;

// Live zones. "silent" = not speaking (neutral, never counted as quiet/loud).
const ZONE_LABELS = Object.freeze({
  silent: "Not speaking",
  normal: "Normal",
  warning: "Getting loud",
  danger: "Too loud",
  calibrating: "Calibrating",
  uncalibrated: "Not calibrated",
  starting: "Starting…",
  reconnecting: "Reconnecting…",
  unavailable: "Mic unavailable",
});

function clampSensitivity(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, n));
}

function marginsFor(sensitivity) {
  const s = clampSensitivity(sensitivity);
  return { warningDb: WARNING_MARGIN_DB - s, dangerDb: DANGER_MARGIN_DB - s };
}

/**
 * Decide the zone for one analysis frame.
 *
 * @param {{ dbfs?: number, speech?: boolean } | null} frame — worklet message
 * @param {{ captureState?: string, calibrating?: boolean, baselineDb?: number|null, sensitivity?: number }} ctx
 * @returns {{ zone: string, label: string, relDb: number|null, speaking: boolean }}
 */
function decideZone(frame, ctx) {
  const c = ctx || {};
  const state = c.captureState || "running";
  let zone;
  let relDb = null;

  if (state === "unavailable") zone = "unavailable";
  else if (state === "starting") zone = "starting";
  else if (state !== "running") zone = "reconnecting";
  else if (c.calibrating) zone = "calibrating";
  else if (typeof c.baselineDb !== "number") zone = "uncalibrated";
  else if (!frame || !frame.speech || typeof frame.dbfs !== "number")
    zone = "silent";
  else {
    relDb = frame.dbfs - c.baselineDb;
    const m = marginsFor(c.sensitivity);
    if (relDb >= m.dangerDb) zone = "danger";
    else if (relDb >= m.warningDb) zone = "warning";
    else zone = "normal";
  }

  return {
    zone,
    label: ZONE_LABELS[zone],
    relDb,
    speaking: zone === "normal" || zone === "warning" || zone === "danger",
  };
}

/** "+7 dB above your normal" / "Normal" — for speaking zones only. */
function formatRelative(relDb) {
  if (typeof relDb !== "number" || !Number.isFinite(relDb)) return "";
  const r = Math.round(relDb);
  if (r < 1) return "Normal";
  return "+" + r + " dB above your normal";
}

/** Short readout for the pill panel: "+7 dB" / "Normal" / "—". */
function formatRelativeShort(relDb) {
  if (typeof relDb !== "number" || !Number.isFinite(relDb)) return "—";
  const r = Math.round(relDb);
  return r < 1 ? "Normal" : "+" + r + " dB";
}

/**
 * 0–100 drawing level for waveforms/tray bars. Visual only: maps -70..-10 dBFS
 * linearly; never shown as a number.
 */
function displayLevel(dbfs) {
  if (typeof dbfs !== "number" || !Number.isFinite(dbfs)) return 0;
  return Math.min(100, Math.max(0, ((dbfs + 70) / 60) * 100));
}

/**
 * Map a zone to the existing colour/class family used by pill, panel, tray
 * and FFT: quiet = neutral grey, normal = cyan, loud = yellow, danger = red.
 */
function zoneToVisual(zone) {
  if (zone === "normal") return "normal";
  if (zone === "warning") return "loud";
  if (zone === "danger") return "danger";
  return "quiet";
}

const _levelLogicExports = {
  ALGORITHM_VERSION,
  WARNING_MARGIN_DB,
  DANGER_MARGIN_DB,
  SENSITIVITY_MIN,
  SENSITIVITY_MAX,
  ZONE_LABELS,
  clampSensitivity,
  marginsFor,
  decideZone,
  formatRelative,
  formatRelativeShort,
  displayLevel,
  zoneToVisual,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = _levelLogicExports;
} else if (typeof window !== "undefined") {
  window.LevelLogic = _levelLogicExports;
}
