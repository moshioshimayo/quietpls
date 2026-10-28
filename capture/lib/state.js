"use strict";

// The app is always in exactly one phase, shown in the menubar, the indicator
// and the transcript window:
//   off          capture is switched off: we don't even ask
//   idle         listening for calls
//   detected     a call is on, and we are not recording it (skipped / never for this app)
//   asking       a call is on and the consent banner is up
//   recording    recording both sides
//   transcribing turning the audio into text
//   saved        transcript committed (shown for a moment)
//   error        something stopped a recording or a save
const PHASES = [
  "off",
  "idle",
  "detected",
  "asking",
  "recording",
  "transcribing",
  "saved",
  "error",
  "ambient",
];

function initialState(settings) {
  return {
    phase: settings.enabled ? "idle" : "off",
    apps: [],
    skipped: false,
    startedAt: null,
    file: null,
    error: null,
  };
}

/** Apps in this call that the user hasn't said "never" to. */
function askableApps(apps, settings) {
  const never = new Set(settings.neverApps || []);
  return apps.filter((a) => !never.has(a));
}

/** Should a fresh call raise the consent banner? Never records without a yes. */
function shouldAsk(state, settings) {
  return Boolean(
    settings.enabled &&
    state.apps.length &&
    !state.skipped &&
    (state.phase === "idle" ||
      state.phase === "detected" ||
      state.phase === "saved" ||
      state.phase === "error") &&
    askableApps(state.apps, settings).length,
  );
}

function settle(state, settings) {
  if (!settings.enabled) return { ...state, phase: "off" };
  if (shouldAsk(state, settings)) return { ...state, phase: "asking" };
  if (state.phase === "asking" && !askableApps(state.apps, settings).length)
    return { ...state, phase: "detected" };
  return state;
}

function next(state, event, settings) {
  const busy = state.phase === "recording" || state.phase === "transcribing";
  // Always-on is entered only through its separate consent dialog, never by a call.
  if (event.type === "ambient-on")
    return { ...state, phase: "ambient", startedAt: event.at, error: null };
  if (event.type === "ambient-off")
    return {
      ...state,
      phase: settings.enabled ? "idle" : "off",
      apps: [],
      error: null,
    };
  if (state.phase === "ambient") {
    if (event.type === "saved") return { ...state, file: event.file };
    if (event.type === "failed") return { ...state, error: event.error };
    return state; // ignores detection and per-call settings while always-on
  }
  switch (event.type) {
    case "settings":
      if (busy) return state;
      if (!settings.enabled) return { ...state, phase: "off" };
      return settle(
        state.phase === "off"
          ? { ...state, phase: state.apps.length ? "detected" : "idle" }
          : state,
        settings,
      );

    case "call": {
      const apps = event.apps;
      if (!apps.length) {
        // Call ended: forget the skip; the recording itself is stopped by the caller.
        const phase =
          busy || state.phase === "saved" || state.phase === "error"
            ? state.phase
            : settings.enabled
              ? "idle"
              : "off";
        return { ...state, apps, skipped: false, phase };
      }
      if (!settings.enabled) return { ...state, apps, phase: "off" };
      if (busy) return { ...state, apps };
      return settle(
        {
          ...state,
          apps,
          phase: state.phase === "asking" ? "asking" : "detected",
        },
        settings,
      );
    }

    case "accept":
      if (state.phase !== "asking") return state;
      return {
        ...state,
        phase: "recording",
        startedAt: event.at,
        error: null,
        file: null,
      };

    case "skip":
    case "never":
      if (state.phase !== "asking") return state;
      return { ...state, phase: "detected", skipped: true };

    case "stopped":
      // skipped: don't ask again about the call we just recorded.
      return state.phase === "recording"
        ? { ...state, phase: "transcribing", skipped: true }
        : state;

    case "saved":
      return { ...state, phase: "saved", file: event.file, error: null };

    case "failed":
      return { ...state, phase: "error", error: event.error };

    case "dismiss":
      if (state.phase !== "saved" && state.phase !== "error") return state;
      return settle(
        {
          ...state,
          phase: state.apps.length
            ? "detected"
            : settings.enabled
              ? "idle"
              : "off",
        },
        settings,
      );

    default:
      return state;
  }
}

module.exports = { PHASES, initialState, next, shouldAsk, askableApps };
