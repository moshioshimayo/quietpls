"use strict";

/**
 * level-logic.js — speech-time decisions shared by every quietpls surface.
 *
 * Levels are digital (dBFS) from one microphone. They are compared with the
 * user's own calibrated "normal" level for that mic, so every number shown is
 * "dB above your normal", never an acoustic (SPL) loudness.
 *
 * Pure logic. Dual export: CommonJS + window.LevelLogic.
 */

// Bump when the measurement or zone rules change; stored with every session.
const ALGORITHM_VERSION = 3;

const ACTIVE_WINDOW_MS = 2000;
const MIN_ACTIVE_MS = 1000;
const ALERT_SPEECH_MS = 2000;
const RECOVER_SPEECH_MS = 1000;
const LISTENING_AFTER_MS = 2000;
const SILENCE_RESET_MS = 5000;
const FLOOR_DB = 15;
const REANCHOR_SPEECH_MS = 30000;
const REANCHOR_MIN_DB = 3;

// Yellow ("getting loud") and red ("ease your voice") margins above the baseline.
const WARNING_MARGIN_DB = 6;
const DANGER_MARGIN_DB = 10;
// Sensitivity shifts both margins: +4 = warn 4 dB earlier, -4 = 4 dB later.
const SENSITIVITY_MIN = -4;
const SENSITIVITY_MAX = 4;

// "silent" = Listening, including warm-up (neutral, no loudness verdict).
const ZONE_LABELS = Object.freeze({
  silent: "Listening",
  normal: "Normal",
  warning: "Getting loud",
  danger: "Ease your voice",
  calibrating: "Calibrating",
  uncalibrated: "Set your normal voice",
  starting: "Starting…",
  reconnecting: "Reconnecting mic…",
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

/** Audio time only. Pauses hold the accepted-speech power window and cue. */
function createDecisionTracker({ baselineDb, sensitivity = 0, reanchorEnabled = true } = {}) {
  const storedBaselineDb = Number.isFinite(baselineDb) ? baselineDb : null;
  let sessionBaselineDb;
  let reanchorDb;
  let reanchored;
  let startMs;
  let startEnergy;
  let window;
  let windowMs;
  let windowEnergy;
  let heldZone;
  let latched;
  let loudMs;
  let recoveryMs;
  let noSpeechMs;
  let last;
  sensitivity = clampSensitivity(sensitivity);

  function decision(zone, relDb = null, speaking = false) {
    return {
      zone, label: ZONE_LABELS[zone], relDb,
      level: relDb === null ? 0 : relativeLevel(relDb),
      heldZone: relDb === null ? null : heldZone,
      speaking, visual: zoneToVisual(zone),
    };
  }

  function clearTransient() {
    window = [];
    windowMs = windowEnergy = 0;
    heldZone = null;
    latched = false;
    loudMs = recoveryMs = noSpeechMs = 0;
    last = decision("silent");
  }

  function reset() {
    sessionBaselineDb = storedBaselineDb;
    reanchorDb = 0;
    reanchored = false;
    startMs = startEnergy = 0;
    clearTransient();
  }
  reset();

  function classify(rel) {
    const m = marginsFor(sensitivity);
    if (rel >= m.dangerDb || (heldZone === "danger" && rel >= m.dangerDb - 2))
      return "danger";
    if (rel >= m.warningDb ||
        ((heldZone === "warning" || heldZone === "danger") && rel >= m.warningDb - 2))
      return "warning";
    return "normal";
  }

  function update(frame, ctx = {}) {
    const state = ctx.captureState || "running";
    let override;
    if (state === "unavailable") override = "unavailable";
    else if (state === "starting") override = "starting";
    else if (state !== "running") override = "reconnecting";
    else if (ctx.calibrating) override = "calibrating";
    else if (sessionBaselineDb === null) override = "uncalibrated";
    else if (frame && (frame.noInput || !Number.isFinite(frame.dbfs) ||
        !Number.isFinite(frame.frameMs) || frame.frameMs <= 0)) override = "reconnecting";
    if (override) {
      clearTransient();
      return (last = decision(override));
    }
    if (!frame) return { ...last, speaking: false };

    const ms = frame.frameMs;
    const accepted = frame.voiced === true && frame.dbfs >= sessionBaselineDb - FLOOR_DB;
    if (!accepted) {
      noSpeechMs += ms;
      if (noSpeechMs >= SILENCE_RESET_MS) {
        clearTransient();
        // Keep the silence clock expired until accepted speech arrives.
        noSpeechMs = SILENCE_RESET_MS;
      }
      if (noSpeechMs >= LISTENING_AFTER_MS) last = decision("silent");
      return { ...last, speaking: false };
    }
    noSpeechMs = 0;
    const power = Math.pow(10, frame.dbfs / 10);
    window.push({ power, ms });
    windowMs += ms;
    windowEnergy += power * ms;
    while (windowMs > ACTIVE_WINDOW_MS) {
      const head = window[0];
      const trim = Math.min(head.ms, windowMs - ACTIVE_WINDOW_MS);
      windowEnergy -= head.power * trim;
      windowMs -= trim;
      head.ms -= trim;
      if (head.ms <= 0) window.shift();
    }

    // Boundary-frame acceptance uses the old baseline; only the first 30 s
    // contribute, including a partial last frame for variable frame durations.
    if (reanchorEnabled && !reanchored) {
      const take = Math.min(ms, REANCHOR_SPEECH_MS - startMs);
      startEnergy += power * take;
      startMs += take;
      if (startMs >= REANCHOR_SPEECH_MS) {
        const delta = 10 * Math.log10(startEnergy / startMs) - storedBaselineDb;
        reanchorDb = Math.abs(delta) < REANCHOR_MIN_DB ? 0 : Math.max(-8, Math.min(3, delta));
        sessionBaselineDb = storedBaselineDb + reanchorDb;
        reanchored = true;
      }
    }
    if (windowMs < MIN_ACTIVE_MS) return (last = decision("silent", null, true));

    const rel = 10 * Math.log10(windowEnergy / windowMs) - sessionBaselineDb;
    heldZone = classify(rel);
    if (heldZone === "danger") {
      loudMs += ms;
      recoveryMs = 0;
      if (loudMs >= ALERT_SPEECH_MS) latched = true;
    } else {
      loudMs = 0;
      if (latched) {
        recoveryMs += ms;
        if (recoveryMs >= RECOVER_SPEECH_MS) {
          latched = false;
          recoveryMs = 0;
        }
      }
    }
    const zone = latched ? "danger" : heldZone === "danger" ? "warning" : heldZone;
    return (last = decision(zone, Math.round(rel * 10) / 10, true));
  }

  return {
    update, reset,
    snapshot: () => ({ storedBaselineDb, sessionBaselineDb, reanchorDb, reanchored }),
    setSensitivity(n) {
      sensitivity = clampSensitivity(n);
      heldZone = null;
      latched = false;
      loudMs = recoveryMs = 0;
    },
  };
}

function relativeLevel(relDb) {
  if (!Number.isFinite(relDb)) return 0;
  return Math.max(0, Math.min(100, ((relDb + 10) / 25) * 100));
}

/**
 * Legacy single-frame helper, retained for the renderer until S2 integration.
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
  ACTIVE_WINDOW_MS,
  MIN_ACTIVE_MS,
  ALERT_SPEECH_MS,
  RECOVER_SPEECH_MS,
  LISTENING_AFTER_MS,
  SILENCE_RESET_MS,
  FLOOR_DB,
  REANCHOR_SPEECH_MS,
  REANCHOR_MIN_DB,
  createDecisionTracker,
  relativeLevel,
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
