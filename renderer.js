// Main window renderer: the floating pill, its details panel and the guided
// "set your normal voice" flow.

// Zone decisions live in level-logic.js (window.LevelLogic). The renderer
// never classifies a level itself: pill, details bar, tray and Settings all
// render the same decision object.

/**
 * Format a duration in seconds to a human-readable string.
 * Pure function — exported for testing.
 * @param {number} durationSec — duration in seconds
 * @returns {string} e.g. "5m", "1h 23m", "< 1m"
 */
function formatDuration(durationSec) {
  if (durationSec == null || durationSec < 60) return "< 1m";
  // Whole minutes first, so 59:59 reads "1h 0m", never "60m" (History uses the same rule).
  const total = Math.round(durationSec / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours > 0 ? hours + "h " + minutes + "m" : minutes + "m";
}

function decisionExplanation(decision, sensitivity = 0) {
  if (!decision || !["normal", "warning", "danger"].includes(decision.zone) ||
      typeof decision.relDb !== "number") return "";
  const LL = typeof window !== "undefined" ? window.LevelLogic : require("./level-logic");
  const m = LL.marginsFor(sensitivity);
  const simple = n => n >= m.dangerDb ? "danger" : n >= m.warningDb ? "warning" : "normal";
  return simple(decision.relDb) !== decision.zone || simple(Math.round(decision.relDb)) !== decision.zone
    ? "Feedback waits for a sustained change" : "";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { formatDuration, decisionExplanation };
}

if (typeof window !== "undefined") {
  const LL = window.LevelLogic;

  // Calibration needs this many seconds of talking (calibration-manager.js).
  const CALIBRATION_SECONDS = 10;
  // Rehearsal timeouts and the success panel use wall time (spec AC-17).
  const REHEARSAL_STEP_MS = 8000;
  const REHEARSAL_NORMAL_MS = 1000;
  const SUCCESS_COLLAPSE_MS = 3000;
  const RENDER_INTERVAL_MS = 100;

  // Pill mark and colour family per zone (spec "State table"). Marks are
  // glyphs so the state never depends on colour alone.
  const PILL = {
    idle: { mark: "g-off", cls: "off" },
    starting: { mark: "g-listen", cls: "off" },
    uncalibrated: { mark: "g-off", cls: "off" },
    calibrating: { mark: "g-learning", cls: "off" },
    reconnecting: { mark: "g-unsure", cls: "unsure", uncertain: true },
    unavailable: { mark: "g-unsure", cls: "unsure", uncertain: true },
    silent: { mark: "g-listen", cls: "off" },
    normal: { mark: "g-ok", cls: "normal" },
    warning: { mark: "g-rise", cls: "rising" },
    danger: { mark: "g-loud", cls: "loud" },
  };
  const IDLE = { zone: "idle", label: "Start monitoring", relDb: null, level: 0 };
  const NEEDS_SETUP = { zone: "uncalibrated", label: "Set normal voice", relDb: null, level: 0 };
  let idleDecision = IDLE;

  // Capture (mic, nodes, health) is owned by one controller per monitoring run.
  let capture = null;
  let captureStatus = null;
  let isMonitoring = false;
  let lastDecision = null;
  let lastRenderAt = 0;
  let _autoCollapseTimer = null;

  // Meeting detection state (US-017)
  let meetingDetected = false;
  let manualStopDuringMeeting = false;
  let autoStartedForMeeting = false; // this run was started by a call

  // Calibration: the live attempt and the saved record for the captured mic.
  let calibrationManager = null;
  let calibration = null; // { baselineDb, calibratedAt, ... } or null
  let calibrationDeviceId = null; // real device id the record belongs to
  let forceCalibration = false; // next device lookup recalibrates

  // One decision tracker at a time: null-baseline before a calibration is
  // known, a rehearsal tracker after a new baseline, then a monitoring one.
  let tracker = null;
  let sessionTracker = null; // only alongside a monitoring tracker
  // Guided calibration: null | talk | failed | louder | back | done
  let calib = null;

  let permissionStatus = "granted";
  let resumeAfterPermission = false;
  let pendingMic = null;
  let resetOnly = false;
  let rehearsalTimer = null;
  let savedTimer = null;
  let doneAt = 0;
  let checkSkipped = false;
  let summaryTimer = null;
  let summaryRemaining = 20000;
  let summaryStarted = 0;
  let summaryHovered = false;
  let summaryFocused = false;
  let setupTipPending = false;

  let config = { sensitivity: 0, audioDeviceId: "" };

  const $ = (id) => document.getElementById(id);
  let compactPill = null;
  let expandedPanel = null;
  let sessionCompletePanel = null;
  let lastAnnounced = "";
  let suppressNextClick = false;
  let userOpened = false; // details opened by the user stay until Hide/Stop

  document.addEventListener("DOMContentLoaded", () => {
    compactPill = $("compactPill");
    expandedPanel = $("expandedPanel");
    sessionCompletePanel = $("sessionCompletePanel");

    // Pre-2.1 renderer copy of score thresholds; no longer meaningful.
    localStorage.removeItem("voiceMonitorSettings");

    setupEventListeners();
    renderTicks();
    render(IDLE);
    window.electronAPI.requestMonitoringStatus();
    syncWidgetState();
    window.electronAPI.getMicrophoneStatus().then(onPermissionStatus).catch(() => {});
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => window.electronAPI.setReducedMotion(reduceMotion.matches);
    syncMotion();
    reduceMotion.addEventListener("change", syncMotion);
    new ResizeObserver(() => {
      const box = document.querySelector(".container");
      window.electronAPI.resizeWidget(box.offsetHeight + 64);
    }).observe(document.querySelector(".container"));
  });

  function setupEventListeners() {
    compactPill.addEventListener("click", (e) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (e.metaKey || e.ctrlKey) window.electronAPI.openSettings();
      else openOrStart();
    });
    $("hideBtn").addEventListener("click", hideDetails);
    $("stopBtn").addEventListener("click", () =>
      finalizeAndShowSessionComplete(),
    );
    $("recalibrateBtn").addEventListener("click", recalibrate);
    $("retryBtn").addEventListener("click", () => {
      if (capture) capture.retry().catch(() => {});
      else startMonitoring().catch(() => {});
    });
    $("calPrimaryBtn").addEventListener("click", () => beginCalibration());
    $("settingsBtn").addEventListener("click", () => window.electronAPI.openSettings());
    $("historyBtn").addEventListener("click", () => window.electronAPI.openSettings("history"));
    $("accessBtn").addEventListener("click", () => window.electronAPI.openSystemSettings());
    $("checkAccessBtn").addEventListener("click", async () => onPermissionStatus(await window.electronAPI.getMicrophoneStatus()));
    $("changeMicBtn").addEventListener("click", () => window.electronAPI.showInputMenu());
    $("newMicSetup").addEventListener("click", async () => {
      pendingMic = null;
      setCalib(null);
      await capture?.acceptDeviceSwitch().catch(() => {});
    });
    $("newMicLater").addEventListener("click", async () => {
      const kept = await capture?.deferDeviceSwitch();
      pendingMic = null;
      setCalib(null);
      if (!kept) await finalizeAndShowSessionComplete();
      else if (lastDecision) render(lastDecision);
    });
    window.electronAPI.onMicrophoneStatusChanged(onPermissionStatus);
    navigator.mediaDevices.addEventListener("devicechange", () => {
      if (!isMonitoring) refreshIdleVoiceState();
    });
    $("calSecondaryBtn").addEventListener("click", () => {
      if (calib === "louder") finishRehearsal(true); // Skip
      else if (calib === "back") { finishRehearsal(false); collapseAfterCalibration(); } // Done: the cue was seen
      else if (calib === "done" || calib === "skipped" || calib === "saved") collapseAfterCalibration(); // Done
      else finalizeAndShowSessionComplete(); // Stop
    });
    $("sessionCloseBtn").addEventListener("click", closeSummary);
    $("summaryDoneBtn").addEventListener("click", closeSummary);
    sessionCompletePanel.addEventListener("mouseenter", () => { summaryHovered = true; pauseSummary(); });
    sessionCompletePanel.addEventListener("mouseleave", () => { summaryHovered = false; resumeSummary(); });
    sessionCompletePanel.addEventListener("focusin", () => { summaryFocused = true; pauseSummary(); });
    sessionCompletePanel.addEventListener("focusout", () => { summaryFocused = false; resumeSummary(); });
    window.addEventListener("blur", () => { summaryFocused = false; resumeSummary(); });
    window.addEventListener("focus", () => {
      summaryFocused = sessionCompletePanel.contains(document.activeElement);
      if (summaryFocused) pauseSummary();
    });
    $("firstRunTip").addEventListener("click", () => { $("firstRunTip").hidden = true; });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sessionCompletePanel.style.display !== "none") closeSummary();
      if (e.key === "Escape" && expandedPanel.style.display !== "none") {
        hideDetails();
      }
    });

    document.querySelector(".container").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      window.electronAPI.showContextMenu({ isMonitoring, x: e.x, y: e.y });
    });

    // Tray menu, keyboard shortcut, context menu.
    window.electronAPI.onToggleMonitoring(async (status) => {
      if (status && !isMonitoring) {
        try {
          await showDetails();
          await startMonitoring();
        } catch (err) {
          console.error("Failed to start monitoring from main toggle:", err);
          window.electronAPI.setMonitoring(false);
          await window.electronAPI.widgetTransition("compact");
        }
      } else if (!status && isMonitoring) {
        await finalizeAndShowSessionComplete();
      }
    });

    window.electronAPI.onMonitoringStatus((status) => {
      if (status) startMonitoring().catch(() => {});
    });

    // Settings from main: sensitivity applies immediately; a new mic is
    // reacquired right away (with its own calibration).
    window.electronAPI.onSettingsUpdated((settings) => {
      const previousDevice = config.audioDeviceId || "";
      config = {
        sensitivity: LL.clampSensitivity(settings && settings.sensitivity),
        audioDeviceId: (settings && settings.audioDeviceId) || "",
      };
      if (tracker) tracker.setSensitivity(config.sensitivity);
      if (sessionTracker) sessionTracker.setThresholds(sessionThresholds());
      renderTicks();
      if (capture && config.audioDeviceId !== previousDevice) {
        console.log("[capture] mic selection changed — reacquiring");
        capture.setDevice(config.audioDeviceId).catch(() => {});
      } else if (!isMonitoring) {
        refreshIdleVoiceState();
      }
    });

    window.electronAPI.onWidgetStateChanged((payload) => {
      applyWidgetState(payload.to);
    });

    // Recalibrate (context menu or Settings): run the guided calibration live.
    window.electronAPI.onTriggerRecalibration(recalibrate);

    // A call started (another app took the mic): start monitoring, unless
    // the user stopped it during this call. When the call ends, stop again
    // only if the call is what started it.
    async function onMeetingDetection(data) {
      meetingDetected = data.detected;
      if (data.detected) {
        if (isMonitoring || manualStopDuringMeeting) return;
        autoStartedForMeeting = true;
        try {
          await window.electronAPI.widgetTransition("compact");
          await startMonitoring({ automatic: true });
        } catch (err) {
          autoStartedForMeeting = false;
          await window.electronAPI.widgetTransition("compact");
        }
      } else {
        // Take ownership before awaiting, so a call that starts meanwhile
        // owns its own run.
        const owned = autoStartedForMeeting;
        autoStartedForMeeting = false;
        manualStopDuringMeeting = false;
        if (isMonitoring && owned) await finalizeAndShowSessionComplete();
      }
    }
    if (
      window.electronAPI.onMeetingDetectionChanged &&
      window.electronAPI.getMeetingDetection
    ) {
      window.electronAPI.onMeetingDetectionChanged(onMeetingDetection);
      window.electronAPI
        .getMeetingDetection()
        .then((data) => data && data.detected && onMeetingDetection(data))
        .catch(() => {});
    }
  }

  async function syncWidgetState() {
    try {
      applyWidgetState(await window.electronAPI.widgetGetState());
    } catch (err) {
      console.error("Failed to sync widget state:", err);
      applyWidgetState("compact");
    }
  }

  function applyWidgetState(state) {
    const expanded = state === "expanded";
    const complete = state === "sessionComplete";
    // Return focus to the pill only from a closing panel (keyboard users);
    // never focus it at rest, where :focus-visible would ring a status pill.
    const panelHadFocus = [expandedPanel, sessionCompletePanel].some((p) => p.contains(document.activeElement));
    compactPill.style.display = "";
    expandedPanel.style.display = expanded ? "" : "none";
    sessionCompletePanel.style.display = complete ? "" : "none";
    if (!expanded) userOpened = false;
    if (!complete) { clearTimeout(summaryTimer); summaryTimer = null; }
    // The success panel is shown once; the next open shows details.
    if (!expanded && (calib === "done" || calib === "skipped" || (calib === "saved" && resetOnly))) setCalib(null);
    if (expanded) {
      $("firstRunTip").hidden = true;
      const focus = calib === "ready" || calib === "failed" ? $("calPrimaryBtn") : calib ? $("calSecondaryBtn") : $("hideBtn");
      focus.focus({ preventScroll: true });
    } else if (!complete) {
      if (panelHadFocus) compactPill.focus({ preventScroll: true });
      if (setupTipPending) {
        setupTipPending = false;
        localStorage.setItem("voiceSetupTipShown", "1");
        $("firstRunTip").hidden = false;
        setTimeout(() => { $("firstRunTip").hidden = true; }, 8000);
      }
    }
  }

  // Click/Enter/Space on the pill: idle starts; otherwise show details.
  async function openOrStart() {
    if (!isMonitoring) {
      try {
        await showDetails();
        await startMonitoring();
      } catch (err) {
        await window.electronAPI.widgetTransition("compact");
      }
      return;
    }
    if (_autoCollapseTimer) clearTimeout(_autoCollapseTimer);
    await showDetails().catch(() => {});
    userOpened = true;
    // A click while the mic is unavailable also retries it now.
    if (capture && captureStatus && captureStatus.state === "unavailable") {
      capture.retry().catch(() => {});
    }
  }

  // Details or calibration, from any widget state. An open summary only
  // closes to the pill, so it goes through the pill first. Throws when the
  // panel cannot be shown: nothing may start where the user can't see it.
  async function showDetails() {
    const api = window.electronAPI;
    const state = await api.widgetGetState();
    if (state === "expanded") return;
    if (state === "sessionComplete") await api.widgetTransition("compact");
    const result = await api.widgetTransition("expanded");
    if (!result || !result.success) {
      console.error("[widget] Could not open details:", result && result.error);
      throw new Error("details not shown");
    }
  }

  // Hide/Escape: back to the compact pill. Changes no tracker, capture
  // stream, rehearsal phase or meeting ownership.
  function hideDetails() {
    if (_autoCollapseTimer) clearTimeout(_autoCollapseTimer);
    window.electronAPI.widgetTransition("compact");
  }

  // ---- Monitoring: capture → one decision → pill, details, tray, session ----

  function workletUrl() {
    // When running from ASAR, unpacked files are at app.asar.unpacked/
    return window.location.href.includes("app.asar")
      ? "../app.asar.unpacked/volume-processor.js"
      : "volume-processor.js";
  }

  function currentContext() {
    return {
      captureState: captureStatus ? captureStatus.state : "starting",
      calibrating: !!(calibrationManager && calibrationManager.isCalibrating()),
    };
  }

  function sessionThresholds() {
    return {
      baselineDb: calibration ? calibration.baselineDb : undefined,
      sensitivity: config.sensitivity,
      margins: LL.marginsFor(config.sensitivity),
    };
  }

  function newTracker(baselineDb, reanchorEnabled) {
    return LL.createDecisionTracker({
      baselineDb,
      sensitivity: config.sensitivity,
      reanchorEnabled,
    });
  }

  // Fresh monitoring decision + session trackers for the current mic and
  // baseline. Never reuses a previous run's re-anchor.
  function startMonitoringSegment() {
    tracker = newTracker(calibration.baselineDb, true);
    const device = captureStatus && captureStatus.device;
    sessionTracker = window.SessionTracker.createSessionTracker({
      algorithmVersion: LL.ALGORITHM_VERSION,
      ...sessionThresholds(),
      meta: {
        mic: {
          label: device ? device.label : "",
          policy: (captureStatus && captureStatus.policy) || null,
        },
        storedBaselineDb: calibration.baselineDb,
      },
    });
  }

  // Save the current segment without the session summary (recalibration or
  // a mic change). Empty segments are not saved.
  function saveSegment() {
    const s = sessionTracker;
    sessionTracker = null;
    if (!s) return null;
    const snap = tracker ? tracker.snapshot() : {};
    const data = s.finalize({
      sessionBaselineDb: snap.sessionBaselineDb,
      reanchorDb: snap.reanchorDb,
    });
    if (data) {
      window.electronAPI
        .saveSession(data)
        .then((r) => {
          if (r && r.success) console.log("[session] Session saved:", r.data.id);
          else console.warn("[session] Failed to save session:", r && r.error);
        })
        .catch((err) => console.error("[session] Error saving session:", err));
    }
    return data;
  }

  async function startMonitoring(options) {
    if (isMonitoring) return;
    console.log("Starting monitoring...");
    const automatic = !!(options && options.automatic);
    permissionStatus = await window.electronAPI.getMicrophoneStatus();
    if (permissionStatus !== "granted") {
      if (permissionStatus === "not-determined" && !automatic) {
        permissionStatus = await window.electronAPI.requestMicrophoneAccess();
      }
      if (permissionStatus !== "granted") {
        resumeAfterPermission = permissionStatus !== "not-determined";
        if (resumeAfterPermission) showPermissionOff();
        else showDecision({ zone: "uncalibrated", label: "Set normal voice", level: 0, relDb: null });
        window.electronAPI.setMonitoring(false);
        return;
      }
    }
    forceCalibration = !!(options && options.recalibrate);
    if (!forceCalibration) resetOnly = false;
    calibrationManager = null;
    calibration = null;
    calibrationDeviceId = null;
    captureStatus = null;
    calib = null;
    sessionTracker = null;
    tracker = newTracker(null, false);

    capture = window.CaptureController.createCaptureController({
      mediaDevices: navigator.mediaDevices,
      createAudioContext: () =>
        new (window.AudioContext || window.webkitAudioContext)(),
      createWorkletNode: (ctx) => new AudioWorkletNode(ctx, "volume-processor"),
      workletUrl: workletUrl(),
      onFrame: handleFrame,
      onStatus: handleCaptureStatus,
      onDeviceSwitch: async (next) => {
        if (["ready", "talk", "failed"].includes(calib)) return true;
        const record = await window.electronAPI.getCalibration(next.device.deviceId);
        if (window.CalibrationManager.isValidCalibrationRecord(record)) return true;
        pendingMic = next;
        $("newMicTitle").textContent = "New mic: " + (next.device.label || "Unnamed mic");
        $("previousMic").textContent = next.previous.label || "—";
        setCalib(null);
        $("detailsView").hidden = true;
        $("newMicView").hidden = false;
        await showDetails();
        $("newMicSetup").focus({ preventScroll: true });
        return false;
      },
      getTransports: () =>
        window.electronAPI.getInputTransports
          ? window.electronAPI.getInputTransports()
          : null,
      log: (m) => console.log(m),
    });

    // Monitoring is on from here: a missing mic shows as unavailable/retrying.
    isMonitoring = true;
    showDecision(tracker.update(null, currentContext()));
    window.electronAPI.setMonitoring(true);

    try {
      await capture.start(config.audioDeviceId || "");
    } catch (error) {
      console.error("[capture] Couldn’t start the mic:", error);
      resumeAfterPermission = true;
      stopMonitoring();
      window.electronAPI.setMonitoring(false);
      permissionStatus = await window.electronAPI.getMicrophoneStatus();
      if (permissionStatus === "granted") {
        resumeAfterPermission = false;
        captureStatus = { state: "unavailable", reason: "start" };
        showDecision({ zone: "unavailable", label: "Mic unavailable", level: 0, relDb: null });
        reportCaptureStatus();
      } else {
        showPermissionOff();
      }
    }
    console.log("Monitoring started");
  }

  function scheduleAutoCollapse(ms) {
    if (_autoCollapseTimer) clearTimeout(_autoCollapseTimer);
    _autoCollapseTimer = setTimeout(async () => {
      _autoCollapseTimer = null;
      // Stay open while calibrating, while the mic is not working, or when
      // the user opened the details (the success panel always closes).
      if (!isMonitoring || needsAttention()) return;
      if (userOpened && calib !== "done") return;
      await window.electronAPI.widgetTransition("compact");
    }, ms);
  }

  function needsAttention() {
    // The success panel always closes; the pill shows any mic problem.
    if (calib === "done") return false;
    const z = lastDecision && lastDecision.zone;
    return (
      calib !== null ||
      z === "calibrating" ||
      z === "uncalibrated" ||
      z === "reconnecting" ||
      z === "unavailable"
    );
  }

  function reportCaptureStatus() {
    if (!window.electronAPI.reportCaptureStatus) return;
    const s = captureStatus || { state: "idle" };
    window.electronAPI.reportCaptureStatus({
      state: s.state,
      reason: s.reason || null,
      fallback: !!s.fallback,
      policy: s.policy || null,
      device: s.device
        ? {
            deviceId: s.device.deviceId,
            label: s.device.label,
            bluetooth: !!s.device.bluetooth,
          }
        : null,
      calibrating: !!(calibrationManager && calibrationManager.isCalibrating()),
      calibration: calibration
        ? {
            baselineDb: calibration.baselineDb,
            calibratedAt: calibration.calibratedAt,
          }
        : null,
    });
  }

  async function handleCaptureStatus(status) {
    const previous = captureStatus;
    captureStatus = status;
    if (status.reason === "pinned-device-gone" && isMonitoring) {
      await finalizeAndShowSessionComplete();
      return;
    }
    console.log(
      "[capture] " +
        status.state +
        (status.reason ? " (" + status.reason + ")" : ""),
    );

    if (status.state === "running") {
      if (status.device && status.device.deviceId !== calibrationDeviceId) {
        // Every stored segment has exactly one mic and baseline.
        saveSegment();
        await useCalibrationFor(status.device);
      }
      if (!previous || previous.state !== "running") scheduleAutoCollapse(3000);
    }
    // Health changes clear transient signal state without waiting for a frame.
    if (tracker) showDecision(tracker.update(null, currentContext()));
    reportCaptureStatus();
  }

  async function useCalibrationFor(device) {
    calibrationDeviceId = device.deviceId;
    calibration = null;
    calibrationManager = null;
    calib = null;
    tracker = newTracker(null, false);
    let record = null;
    if (!forceCalibration) {
      try {
        record = await window.electronAPI.getCalibration(device.deviceId);
      } catch (err) {
        console.warn("[calibration] lookup failed:", err);
      }
    }
    // The device may have changed again while we waited.
    if (!capture || calibrationDeviceId !== device.deviceId) return;
    if (window.CalibrationManager.isValidCalibrationRecord(record)) {
      calibration = record;
      startMonitoringSegment();
      console.log("[calibration] using saved normal for", device.label);
    } else {
      setCalib("ready");
      await showDetails();
    }
  }

  // Explicit "Set normal voice again" (details, context menu or Settings).
  async function recalibrate(options) {
    console.log("[calibration] Recalibration requested");
    resetOnly = !options?.setup;
    if (!isMonitoring) {
      try {
        await showDetails();
        await startMonitoring({ recalibrate: true });
      } catch (err) {
        await window.electronAPI.widgetTransition("compact");
      }
      return;
    }
    saveSegment();
    tracker = newTracker(null, false);
    if (captureStatus && captureStatus.state === "running" && captureStatus.device) {
      calibrationDeviceId = captureStatus.device.deviceId;
      calibration = null;
      setCalib("ready");
      await showDetails().catch(() => { stopMonitoring(); window.electronAPI.setMonitoring(false); });
    } else {
      // Not capturing right now; calibrate as soon as the mic is back.
      forceCalibration = true;
      calibrationDeviceId = null;
    }
  }

  function beginCalibration() {
    forceCalibration = false;
    calibration = null;
    sessionTracker = null;
    tracker = newTracker(null, false);
    const manager = window.CalibrationManager.createCalibrationManager();
    calibrationManager = manager;
    manager.start();
    setCalib("talk");
    if (_autoCollapseTimer) clearTimeout(_autoCollapseTimer);
    reportCaptureStatus();
    // Never calibrate unseen: a hidden prompt would save call audio as normal.
    showDetails().catch(() => {
      if (calibrationManager !== manager) return;
      stopMonitoring();
      window.electronAPI.setMonitoring(false);
    });
  }

  // Rehearsal: louder sentence, then back to normal. Never changes the
  // baseline, never feeds session statistics or the re-anchor.
  let rehearsal = null; // { since, normalMs, timedOut }
  let calibFail = null; // last failed calibration result

  function handleCalibrationResult(result, device) {
    if (result.status !== "ok") {
      calibrationManager = null;
      calibFail = result;
      setCalib("failed");
      return;
    }
    calibration = window.CalibrationManager.makeCalibrationRecord(result, device);
    window.electronAPI.saveCalibration(device.deviceId, calibration);
    console.log("[calibration] normal =", result.baselineDb, "dBFS for", device.label);
    calibrationManager = null;
    reportCaptureStatus();
    tracker = newTracker(calibration.baselineDb, false);
    setCalib("saved");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      if (!isMonitoring || !calibration) return;
      if (resetOnly) { startMonitoringSegment(); return; }
      rehearsal = { since: Date.now(), normalMs: 0, timedOut: false };
      setCalib("louder");
      clearInterval(rehearsalTimer);
      rehearsalTimer = setInterval(() => {
        if (rehearsal && Date.now() - rehearsal.since >= REHEARSAL_STEP_MS) {
          if (calib === "louder") finishRehearsal(true);
          else finishRehearsal(false);
        }
        if (lastDecision && calib) render(lastDecision);
      }, 100);
    }, resetOnly ? 0 : 700);
  }

  function advanceRehearsal(decision, msg) {
    const elapsed = Date.now() - rehearsal.since;
    if (calib === "louder") {
      const louder =
        decision.heldZone === "warning" || decision.heldZone === "danger";
      if (elapsed >= REHEARSAL_STEP_MS && !louder) { finishRehearsal(true); return; }
      if (louder) {
        rehearsal = { since: Date.now(), normalMs: 0, timedOut: !louder };
        setCalib("back");
      }
    } else if (calib === "back") {
      if (decision.speaking && decision.zone === "normal") {
        rehearsal.normalMs += msg.frameMs;
      }
      if (rehearsal.normalMs >= REHEARSAL_NORMAL_MS || elapsed >= REHEARSAL_STEP_MS) {
        finishRehearsal();
      }
    }
  }

  // Done, Skip or timeout: discard the rehearsal tracker and start a fresh
  // monitoring segment, then show success and collapse.
  function finishRehearsal(skipped = false) {
    clearInterval(rehearsalTimer);
    rehearsalTimer = null;
    rehearsal = null;
    checkSkipped = skipped;
    doneAt = Date.now();
    startMonitoringSegment();
    setCalib(skipped ? "skipped" : "done");
    if (!skipped) scheduleAutoCollapse(SUCCESS_COLLAPSE_MS);
    if (!localStorage.getItem("voiceSetupTipShown")) {
      setupTipPending = true;
    }
  }

  async function collapseAfterCalibration() {
    if (_autoCollapseTimer) clearTimeout(_autoCollapseTimer);
    if (calib === "saved") setCalib(null);
    await window.electronAPI.widgetTransition("compact");
  }

  function handleFrame(msg, device) {
    // Context before the frame: the frame that completes calibration is
    // still a calibration frame and is never fed to monitoring.
    const ctx = currentContext();
    let decision;
    if (ctx.calibrating) {
      const result = calibrationManager.addFrame(msg);
      decision = tracker.update(msg, ctx);
      if (result) handleCalibrationResult(result, device);
    } else {
      decision = tracker.update(msg, ctx);
      if (rehearsal) advanceRehearsal(decision, msg);
      else if (sessionTracker) sessionTracker.recordFrame(decision, msg.frameMs);
    }

    // Display: on any zone change, otherwise at a steady rate.
    const now = performance.now();
    if (
      lastDecision &&
      lastDecision.zone === decision.zone &&
      now - lastRenderAt < RENDER_INTERVAL_MS
    ) {
      return;
    }
    lastRenderAt = now;
    showDecision(decision);
  }

  /** Render one decision everywhere: pill, details, tray and Settings. */
  function showDecision(decision) {
    lastDecision = decision;
    render(decision);
    window.electronAPI.sendLevelUpdate({
      zone: decision.zone,
      visual: decision.visual || LL.zoneToVisual(decision.zone),
      level: decision.level || 0,
      relDb: decision.relDb,
      label: pillWord(decision),
    });
  }

  // Calibration progress as shown everywhere (pill %, bar, "n of 10 seconds"):
  // whole seconds of accepted talking, so all three always agree.
  function shownProgress() {
    const p = calibrationManager ? calibrationManager.getProgress() : 0;
    return Math.floor(p * CALIBRATION_SECONDS) / CALIBRATION_SECONDS;
  }

  function pillWord(decision) {
    if (calib === "saved" && (!resetOnly || !sessionTracker)) return "Learning voice 100%";
    if (decision.zone === "calibrating" && calibrationManager) {
      return (
        "Learning voice " +
        Math.round(shownProgress() * 100) +
        "%"
      );
    }
    if (
      decision.zone === "unavailable" &&
      captureStatus &&
      captureStatus.reason === "permission"
    ) {
      return "Mic access off";
    }
    return decision.label;
  }

  function amountText(decision) {
    switch (decision.zone) {
      case "unavailable":
        return "Mic unavailable. Try again.";
      case "reconnecting":
        return "Reconnecting to the mic…";
      case "silent":
        return "Feedback appears when you talk";
      case "uncalibrated":
        return "Set your normal voice first";
    }
    if (typeof decision.relDb !== "number") return "";
    return Math.round(decision.relDb) < 1
      ? "Near or below normal"
      : LL.formatRelativeShort(decision.relDb);
  }

  function micText() {
    const s = captureStatus;
    if (!s || !s.device) return { label: "—", note: "" };
    const notes = {
      "avoid-bluetooth": "Using a mic that keeps headset audio clear",
      explicit: "Selected in Settings",
    };
    return {
      label: s.device.label || "Unnamed mic",
      note:
        s.reason === "fallback"
          ? "Selected mic unavailable. Using this mic."
          : notes[s.policy] || "",
    };
  }

  function reanchorText() {
    const snap = tracker && sessionTracker ? tracker.snapshot() : null;
    if (!snap || !snap.reanchored || !snap.reanchorDb) return "";
    const r = Math.round(snap.reanchorDb);
    if (!r) return "";
    return (
      "Normal adjusted " +
      (r < 0 ? "−" + -r : "+" + r) +
      " dB for this session"
    );
  }

  function render(decision) {
    const word = pillWord(decision);
    const p = calib === "saved" && (!resetOnly || !sessionTracker) ? PILL.calibrating : PILL[decision.zone] || PILL.idle;
    compactPill.className = ["pill", p.cls, isMonitoring ? "monitoring" : ""].join(" ");
    compactPill.setAttribute("aria-label", "quietpls: " + word + ". Show details");
    setGlyph("pillMark", permissionStatus === "denied" || permissionStatus === "restricted" ? "g-micoff" : p.mark);
    $("pillMark").style.setProperty("--progress", calib === "saved" ? 100 : shownProgress() * 100);
    $("pillWord").textContent = word;
    const metered = isMonitoring && ["silent", "normal", "warning", "danger"].includes(decision.zone);
    $("miniMeter").hidden = !metered;
    $("miniFill").style.width = Math.round((decision.level || 0) / 10) * 10 + "%";
    const coarseWord = /%$/.test(word) ? "Learning voice" : word;
    if (coarseWord !== lastAnnounced) {
      lastAnnounced = coarseWord;
      $("liveRegion").textContent = coarseWord;
    }
    expandedPanel.className = ["panel", p.cls].join(" ");
    setGlyph("detailsMark", permissionStatus === "denied" || permissionStatus === "restricted" ? "g-micoff" : p.mark);
    $("zoneLabel").textContent = word;
    const numeric = typeof decision.relDb === "number" && Number.isFinite(decision.relDb);
    $("dbReadout").textContent = numeric ? amountText(decision) : "";
    $("dbCaption").hidden = !numeric || Math.round(decision.relDb) < 1;
    $("decisionNote").textContent = decisionExplanation(decision, config.sensitivity);
    $("decisionNote").hidden = !$("decisionNote").textContent;
    const accessOff = captureStatus?.reason === "permission";
    $("stateNote").textContent = accessOff
      ? permissionStatus === "granted" ? "Couldn’t start the mic. Check microphone access in System Settings, then try again."
        : "Turn on quietpls in System Settings → Privacy & Security → Microphone. Monitoring starts again when you come back."
      : captureStatus?.reason === "start"
        ? "Couldn’t start the mic. Check microphone access in System Settings, then try again. Restart quietpls if the mic still won’t start."
        : decision.zone === "unavailable" ? "Check the mic connection, then try again."
          : !numeric ? amountText(decision) : "";
    $("stateNote").hidden = !$("stateNote").textContent;
    $("relBar").hidden = p.uncertain || decision.zone === "uncalibrated";
    $("relFill").style.left = (decision.level || 0) + "%";
    $("relBarTrack").setAttribute("aria-label", numeric ? LL.formatRelative(decision.relDb) || "Near or below normal" : "No voice reading");
    const mic = micText();
    $("micLabel").textContent = mic.label;
    $("micLabel").title = mic.label;
    $("micNote").textContent = mic.note;
    $("micNote").hidden = !mic.note;
    $("normalSaved").textContent = calibration?.calibratedAt
      ? "Saved " + new Date(calibration.calibratedAt).toLocaleDateString(undefined, {month:"short", day:"numeric"}) : "Not set";
    $("normalRow").hidden = !!p.uncertain;
    $("deviceGroup").hidden = accessOff;
    const re = reanchorText();
    $("reanchorLine").textContent = re;
    $("reanchorLine").hidden = !re;
    $("recoveryActions").hidden = decision.zone !== "unavailable";
    $("accessBtn").hidden = !accessOff;
    $("checkAccessBtn").hidden = !accessOff;
    $("retryBtn").hidden = accessOff || decision.zone !== "unavailable";
    $("retryBtn").title = decision.zone === "unavailable" ? amountText(decision) : "";
    $("recalibrateBtn").hidden = decision.zone === "unavailable" || !isMonitoring;
    $("stopBtn").hidden = !isMonitoring;
    if (calib) renderCalibration(decision, word, p);
  }

  function setGlyph(id, mark) {
    const svg = $(id), use = svg.querySelector("use");
    if (use.getAttribute("href") === "#" + mark) return;
    use.setAttribute("href", "#" + mark);
    svg.classList.remove("glyph-enter");
    void svg.clientWidth;
    svg.classList.add("glyph-enter");
  }

  function renderTicks() {
    const m = LL.marginsFor(config.sensitivity);
    const at = (db) => LL.relativeLevel(db) + "%";
    $("miniMeter").style.setProperty("--normal-notch", at(0));
    const warn = LL.relativeLevel(m.warningDb), loud = LL.relativeLevel(m.dangerDb);
    $("normalZone").style.flex = warn;
    $("risingZone").style.flex = loud - warn;
    $("loudZone").style.flex = 100 - loud;
    $("normalNotch").style.left = at(0);
    $("tickWarn").style.left = at(m.warningDb);
    $("tickDanger").style.left = at(m.dangerDb);
    $("scaleNormal").style.left = at(0);
    $("scaleWarn").style.left = at(m.warningDb);
    $("scaleWarn").textContent = "+" + m.warningDb;
    $("scaleDanger").style.left = at(m.dangerDb);
    $("scaleDanger").textContent = "+" + m.dangerDb;
  }

  function setCalib(phase) {
    calib = phase;
    $("detailsView").hidden = !!phase;
    $("calibrationView").hidden = !phase;
    $("newMicView").hidden = !pendingMic;
    if (pendingMic) $("detailsView").hidden = true;
    if (lastDecision) render(lastDecision);
    else if (phase) renderCalibration(IDLE, "", PILL.idle);
    if (phase && expandedPanel.style.display !== "none") {
      const focus = phase === "ready" || phase === "failed" ? $("calPrimaryBtn") : $("calSecondaryBtn");
      if (!focus.hidden) focus.focus({ preventScroll: true });
    }
  }

  function renderCalibration(decision, word, p) {
    const micLabel = micText().label;
    const t = {
      step: "",
      title: "",
      text: "",
      note: "",
      primary: "",
      secondary: "",
      progress: false,
      live: false,
      mark: false,
    };
    let hint = "";
    if (calib === "ready" || calib === "talk") {
      t.step = "Normal voice";
      t.title = "Use your normal call voice";
      t.secondary = calib === "ready" ? "Cancel" : "Stop";
      if (calib === "ready") {
        t.text = "Talk the way you would on a call for about 10 seconds. Pauses are fine.";
        t.primary = "Start";
      } else {
        const progress = shownProgress();
        const details = calibrationManager?.getProgressDetails?.() || {};
        t.progress = progress;
        t.text = Math.round(progress * CALIBRATION_SECONDS) + " of 10 seconds heard · " + micLabel;
        hint = details.hint === "too-strong" ? "Mic input is too strong. Move a little farther from the mic."
          : details.hint === "noise" ? "Hearing steady noise, not talking. Move away from fans or music, or talk a little closer."
          : "";
        if (details.extended) hint = "Almost there. Keep talking." + (hint ? " " + hint : "");
      }
    } else if (calib === "failed") {
      const r = calibFail || {};
      t.step = "Normal voice";
      t.title = "Try voice setup again";
      t.text = r.reason === "clipping" || r.status === "clipping"
        ? "Mic input is too strong. Move a little farther from the mic."
        : r.reason === "stationary"
          ? "quietpls heard steady noise but no talking. Move away from fans or music, then try again."
          : "Talk near the mic in your normal call voice, then try again.";
      t.primary = "Try again";
      t.secondary = "Cancel";
    } else if (calib === "saved") {
      t.step = "Normal voice";
      t.title = "Normal voice saved";
      t.text = "Saved for " + micLabel + ". Feedback compares your voice with this level.";
      t.mark = true;
      t.progress = 1;
      if (resetOnly) t.secondary = "Done";
      else t.note = "Next: try the feedback";
    } else if (calib === "louder" || calib === "back") {
      t.step = "Try the feedback";
      t.title = calib === "louder" ? "Normal voice saved" : "That's the cue you'll see on calls";
      t.text = calib === "louder" ? "Try a slightly louder voice." : "Return to your normal voice";
      t.mark = true;
      t.live = true;
      // Once the cue showed, the check succeeded: finishing is Done, never "skipped".
      t.secondary = calib === "back" ? "Done" : "Skip check";
    } else if (calib === "done" || calib === "skipped") {
      t.mark = true;
      t.step = "Try the feedback";
      t.title = checkSkipped ? "Normal voice saved" : "All set";
      t.text = checkSkipped ? "Louder check skipped. Your normal voice is saved."
        : "That's the cue you'll see on calls. Return to your normal voice.";
      const seconds = Math.max(1, Math.ceil((SUCCESS_COLLAPSE_MS - (Date.now() - doneAt)) / 1000));
      t.note = checkSkipped ? "" : seconds === 3 ? "Closes in 3 seconds" : "Closes in " + seconds + (seconds === 1 ? " second" : " seconds");
      t.secondary = "Done";
    }
    $("calHint").textContent = hint;
    $("calHint").hidden = !hint;
    $("calMicName").textContent = micLabel;
    $("calMicName").title = micLabel;
    $("calMicGroup").hidden = calib !== "ready";
    $("changeMicBtn").hidden = !["ready", "talk", "failed"].includes(calib);
    $("rehearsalCountdown").hidden = calib !== "louder";
    if (calib === "louder" && rehearsal) {
      const remaining = Math.max(0, REHEARSAL_STEP_MS - (Date.now() - rehearsal.since));
      $("countdownFill").style.width = remaining / REHEARSAL_STEP_MS * 100 + "%";
      $("countdownText").textContent = Math.ceil(remaining / 1000) + " seconds left";
    }
    $("calStep").textContent = t.step;
    $("calStep").hidden = !t.step;
    $("calMark").toggleAttribute("hidden", !t.mark);
    $("calTitle").textContent = t.title;
    $("calProgress").hidden = t.progress === false;
    $("calProgressFill").style.width = (t.progress || 0) * 100 + "%";
    $("calProgress").setAttribute(
      "aria-valuenow",
      String(Math.round((t.progress || 0) * CALIBRATION_SECONDS)),
    );
    $("calText").textContent = t.text;
    $("calText").hidden = !t.text;
    $("calLive").hidden = !t.live;
    if (t.live) {
      const live = $("calLivePill");
      live.className = ["pill", p.cls]
        .join(" ")
        .trim();
      setGlyph("calLiveMark", p.mark);
      $("calLiveWord").textContent = word;
    }
    $("calNote").textContent = t.note;
    $("calPrimaryBtn").textContent = t.primary;
    $("calPrimaryBtn").hidden = !t.primary;
    $("calSecondaryBtn").textContent = t.secondary;
    $("calSecondaryBtn").hidden = !t.secondary;
    $("calSecondaryBtn").classList.toggle("primary", ["done", "skipped"].includes(calib) || (resetOnly && calib === "saved"));
  }

  function stopMonitoring() {
    console.log("Stopping monitoring...");
    clearInterval(rehearsalTimer);
    clearTimeout(savedTimer);
    rehearsalTimer = savedTimer = null;
    pendingMic = null;
    if (_autoCollapseTimer) {
      clearTimeout(_autoCollapseTimer);
      _autoCollapseTimer = null;
    }
    // Releases the mic, nodes and AudioContext, and cancels any retry.
    if (capture) {
      capture.stop();
      capture = null;
    }
    captureStatus = null;
    isMonitoring = false;
    calibrationManager = null;
    calibration = null;
    calibrationDeviceId = null;
    forceCalibration = false;
    tracker = null;
    rehearsal = null;
    lastDecision = null;
    setCalib(null);
    reportCaptureStatus();
    render(idleDecision);
    refreshIdleVoiceState();
    console.log("Monitoring stopped");
  }

  // ---- Session Complete Flow (US-014) ----

  function populateSessionInsights(insights, durationSec, noTalking) {
    $("sessionDuration").textContent = formatDuration(durationSec);
    const listEl = $("insightList");
    listEl.innerHTML = "";
    for (const text of insights) {
      if (/^Peak /.test(text)) continue;
      const li = document.createElement("li");
      li.className = noTalking ? "summary-empty status" : "row";
      if (!noTalking) {
        const red = /Ease your voice/.test(text);
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.classList.add("g");
        svg.setAttribute("aria-hidden", "true");
        svg.style.color = red ? "var(--loud-fill)" : "var(--rising-fill)";
        svg.style.setProperty("--loud-mark", "var(--white)");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", red ? "#g-loud" : "#g-rise");
        svg.appendChild(use);
        li.appendChild(svg);
      }
      const label = document.createElement("span");
      label.textContent = text;
      li.appendChild(label);
      listEl.appendChild(li);
    }
    const peak = insights.find(text => /^Peak /.test(text));
    $("summaryPeak").textContent = peak || "";
    $("summaryPeak").hidden = !peak;
    const minutes = Math.max(1, Math.round(durationSec / 60));
    $("summaryEmptyDetail").textContent = "quietpls was listening for " + minutes +
      (minutes === 1 ? " minute" : " minutes") + " but didn't hear you talk.";
    $("summaryEmptyDetail").hidden = !noTalking;
    $("historyBtn").hidden = noTalking;
  }

  /**
   * Stop: finalize the current session, save it and show the summary.
   * The only path that ends monitoring from the widget.
   */
  async function finalizeAndShowSessionComplete() {
    // A stop during a call holds until that call ends (no auto-restart).
    if (meetingDetected) manualStopDuringMeeting = true;
    autoStartedForMeeting = false;

    const sessionData = saveSegment();
    stopMonitoring();
    window.electronAPI.setMonitoring(false);

    if (!(sessionData && sessionData.duration >= 60 && window.SessionInsights)) {
      // Short session (< 60s) or nothing recorded: straight back to compact.
      await window.electronAPI.widgetTransition("compact");
      return;
    }
    // The summary shows the cue shares and peak; History retains the trend samples.
    populateSessionInsights(window.SessionInsights.generateInsights({ ...sessionData, volumeSamples: [] }),
      sessionData.duration, !sessionData.speakingTime);
    const zones = sessionData.zoneTime || {};
    const warning = zones.warning || 0, danger = zones.danger || 0;
    const total = Math.max(sessionData.speakingTime || 0, (zones.normal || 0) + warning + danger);
    // Match History: accepted talking before a cue counts in the normal share.
    const shares = [total - warning - danger, warning, danger].map(n => n / (total || 1) * 100);
    [...$("sessionSplit").children].forEach((el, i) => { el.style.flex = shares[i]; el.hidden = shares[i] === 0; });
    $("sessionSplit").hidden = !sessionData.speakingTime;
    $("sessionSplit").setAttribute("aria-label", "Normal " + Math.round(shares[0]) + "%, Getting loud " + Math.round(shares[1]) + "%, Ease your voice " + Math.round(shares[2]) + "%");
    const result = await window.electronAPI.widgetTransition("sessionComplete");
    summaryRemaining = 20000;
    summaryHovered = summaryFocused = false;
    resumeSummary();
    if (result && !result.success) {
      console.error("[session] Widget transition to sessionComplete failed:", result.error);
      sessionCompletePanel.style.display = "";
    }
  }

  function closeSummary() {
    clearTimeout(summaryTimer);
    summaryTimer = null;
    window.electronAPI.widgetTransition("compact");
    compactPill.focus({ preventScroll: true });
  }
  function pauseSummary() {
    if (!summaryTimer) return;
    clearTimeout(summaryTimer);
    summaryTimer = null;
    summaryRemaining = Math.max(0, summaryRemaining - (Date.now() - summaryStarted));
  }
  function resumeSummary() {
    if (summaryTimer || summaryHovered || summaryFocused || sessionCompletePanel.style.display === "none") return;
    summaryStarted = Date.now();
    summaryTimer = setTimeout(closeSummary, summaryRemaining);
  }
  function showPermissionOff() {
    captureStatus = { state: "unavailable", reason: "permission" };
    setCalib(null);
    showDecision({ zone: "unavailable", label: "Mic access off", level: 0, relDb: null });
    reportCaptureStatus();
  }
  async function refreshIdleVoiceState() {
    if (isMonitoring || captureStatus?.reason === "start" || permissionStatus === "denied" || permissionStatus === "restricted") return;
    if (permissionStatus === "not-determined") {
      idleDecision = NEEDS_SETUP;
      render(idleDecision);
      return;
    }
    const preferredId = config.audioDeviceId;
    try {
      const selected = await window.MicPolicy.resolveChoice(
        navigator.mediaDevices, window.electronAPI.getInputTransports, preferredId,
      );
      if (!selected.deviceId) return;
      const record = await window.electronAPI.getCalibration(selected.deviceId);
      if (isMonitoring || captureStatus?.reason === "start" || preferredId !== config.audioDeviceId || permissionStatus !== "granted") return;
      idleDecision = window.CalibrationManager.isValidCalibrationRecord(record) ? IDLE : NEEDS_SETUP;
      render(idleDecision);
    } catch (_) { /* Actual input health is checked when monitoring starts. */ }
  }
  async function onPermissionStatus(status) {
    permissionStatus = status;
    if (status === "denied" || status === "restricted") {
      if (isMonitoring) {
        resumeAfterPermission = true;
        saveSegment();
        stopMonitoring();
        window.electronAPI.setMonitoring(false);
      }
      showPermissionOff();
    } else if (status === "granted" && resumeAfterPermission) {
      resumeAfterPermission = false;
      await startMonitoring();
    } else if (status === "granted" && captureStatus?.reason === "permission") {
      captureStatus = null;
      refreshIdleVoiceState();
    } else if (!isMonitoring) {
      refreshIdleVoiceState();
    }
  }

  // ---- Manual Drag-and-Snap (US-006) ----
  // Drag from the pill or panel background; a drag never counts as a click.

  let _dragState = null; // { startScreenX, startScreenY, winStartX, winStartY, didDrag }
  const DRAG_THRESHOLD_PX = 4; // minimum mouse movement to count as a drag

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const control = e.target.closest("button, input, select, canvas");
    if (control && control !== compactPill) return;
    // Set synchronously: a quick click's mouseup must always end it.
    const drag = {
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      winStartX: null,
      winStartY: null,
      didDrag: false,
    };
    _dragState = drag;
    window.electronAPI
      .getWindowPosition()
      .then((pos) => {
        drag.winStartX = pos.x;
        drag.winStartY = pos.y;
      })
      .catch(() => {
        if (_dragState === drag) _dragState = null;
      });
  });

  document.addEventListener("mousemove", (e) => {
    if (!_dragState) return;
    // Only while the primary button is held.
    if (!(e.buttons & 1)) {
      _dragState = null;
      return;
    }
    const dx = e.screenX - _dragState.startScreenX;
    const dy = e.screenY - _dragState.startScreenY;
    if (
      !_dragState.didDrag &&
      (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)
    ) {
      _dragState.didDrag = true;
    }
    if (_dragState.didDrag && _dragState.winStartX !== null) {
      window.electronAPI.setWindowPosition(
        _dragState.winStartX + dx,
        _dragState.winStartY + dy,
      );
    }
  });

  document.addEventListener("mouseup", () => {
    if (_dragState && _dragState.didDrag) {
      suppressNextClick = true;
      setTimeout(() => (suppressNextClick = false), 0);
      snapToNearestAnchor();
    }
    _dragState = null;
  });

  /**
   * After drag ends, snap the window to the nearest horizontal anchor.
   * Uses actual window bounds (not hardcoded width) for correct calculation.
   */
  async function snapToNearestAnchor() {
    try {
      const [screenDims, winBounds] = await Promise.all([
        window.electronAPI.getScreenDimensions(),
        window.electronAPI.getWindowBounds(),
      ]);
      const snapX = calculateSnapXRenderer(
        winBounds.x,
        screenDims.width,
        winBounds.width,
      );
      if (snapX !== winBounds.x) {
        await window.electronAPI.setWindowPosition(snapX, winBounds.y);
      }
    } catch (err) {
      console.error("Snap-to-anchor failed:", err);
    }
  }

  /**
   * Pure snap calculation (mirrors snap-position.js for renderer use).
   * Returns the X coordinate the window should snap to.
   */
  function calculateSnapXRenderer(currentX, screenWidth, windowWidth) {
    const anchors = [
      Math.round(screenWidth * 0.25 - windowWidth / 2),
      Math.round(screenWidth * 0.5 - windowWidth / 2),
      Math.round(screenWidth * 0.75 - windowWidth / 2),
    ];
    const windowCenterX = currentX + windowWidth / 2;
    let nearest = anchors[0];
    let nearestDist = Infinity;
    for (let i = 0; i < anchors.length; i++) {
      const dist = Math.abs(windowCenterX - (anchors[i] + windowWidth / 2));
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = anchors[i];
      }
    }
    return nearest;
  }
}
