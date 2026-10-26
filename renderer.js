// Main window renderer - just the floating pill

// Zone decisions and units live in level-logic.js (window.LevelLogic): levels
// are shown relative to the user's calibrated normal, never as acoustic dB.

// ---- Pure helper functions — no DOM/window dependencies ----

/**
 * Format a duration in seconds to a human-readable string.
 * Pure function — exported for testing.
 * @param {number} durationSec — duration in seconds
 * @returns {string} e.g. "5m", "1h 23m", "< 1m"
 */
function formatDuration(durationSec) {
  if (durationSec == null || durationSec < 60) return "< 1m";
  const hours = Math.floor(durationSec / 3600);
  const minutes = Math.round((durationSec % 3600) / 60);
  if (hours > 0) {
    return hours + "h " + minutes + "m";
  }
  return minutes + "m";
}

// ---- Pure helper functions (US-010) — alert state timing logic ----

/**
 * Default alert timing constants (in milliseconds).
 * Exported for testing.
 */
const ALERT_THRESHOLDS = Object.freeze({
  LOUD_TRIGGER_MS: 3000, // 3 seconds of continuous "too loud" (red) before alert triggers
  QUIET_DISMISS_MS: 5000, // 5 seconds below red before auto-dismiss
  UPDATE_INTERVAL_MS: 50, // expected interval between updateDisplay calls
});

/**
 * Create an alert tracker that manages alert trigger/dismiss state.
 * Pure factory — no DOM or window dependencies.
 *
 * @param {{ loudTriggerMs?: number, quietDismissMs?: number }} [opts]
 * @returns {object} tracker API
 */
function createAlertTracker(opts) {
  const loudTriggerMs =
    (opts && opts.loudTriggerMs) || ALERT_THRESHOLDS.LOUD_TRIGGER_MS;
  const quietDismissMs =
    (opts && opts.quietDismissMs) || ALERT_THRESHOLDS.QUIET_DISMISS_MS;

  let loudStartTime = null; // timestamp when loud streak started
  let quietStartTime = null; // timestamp when quiet streak started (during alert)
  let isInAlert = false;

  /**
   * Update the tracker with the current volume zone and timestamp.
   * Returns an action string: 'trigger-alert', 'dismiss-alert', or 'none'.
   *
   * @param {string} zone — a level-logic zone ('silent' | 'normal' | 'warning' | 'danger' | ...)
   * @param {number} now — current timestamp (ms), e.g. Date.now()
   * @returns {'trigger-alert' | 'dismiss-alert' | 'none'}
   */
  function update(zone, now) {
    // The "TOO LOUD" alert is red only; yellow is shown as "getting loud".
    const isLoud = zone === "danger";

    if (!isInAlert) {
      // Track consecutive loud time
      if (isLoud) {
        if (loudStartTime === null) {
          loudStartTime = now;
        }
        if (now - loudStartTime >= loudTriggerMs) {
          isInAlert = true;
          loudStartTime = null;
          quietStartTime = null;
          return "trigger-alert";
        }
      } else {
        // Reset loud streak
        loudStartTime = null;
      }
    } else {
      // In alert state: track consecutive quiet time for auto-dismiss
      if (!isLoud) {
        if (quietStartTime === null) {
          quietStartTime = now;
        }
        if (now - quietStartTime >= quietDismissMs) {
          isInAlert = false;
          quietStartTime = null;
          loudStartTime = null;
          return "dismiss-alert";
        }
      } else {
        // Reset quiet streak
        quietStartTime = null;
      }
    }

    return "none";
  }

  /**
   * Manually dismiss the alert (e.g. dismiss button).
   */
  function dismiss() {
    isInAlert = false;
    loudStartTime = null;
    quietStartTime = null;
  }

  /**
   * Reset all tracking state.
   */
  function reset() {
    isInAlert = false;
    loudStartTime = null;
    quietStartTime = null;
  }

  /**
   * @returns {boolean}
   */
  function getIsInAlert() {
    return isInAlert;
  }

  return {
    update: update,
    dismiss: dismiss,
    reset: reset,
    getIsInAlert: getIsInAlert,
  };
}

// Export pure functions for testing (Node.js / vitest)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    createAlertTracker,
    ALERT_THRESHOLDS,
    formatDuration,
  };
}

// ---- Guard: stop here when loaded in Node.js (tests) ----
if (typeof window === "undefined") {
  /* no-op: module.exports already set */
} else {
  // Begin renderer-only code (wrapped in else block for clarity; no actual nesting needed
  // since the Node.js branch would have already exported and won't execute DOM code)

  const LL = window.LevelLogic;

  // Capture (mic, nodes, health) is owned by one controller per monitoring run.
  let capture = null;
  let captureStatus = null;
  let isMonitoring = false;
  let lastDecision = null;
  let _autoCollapseTimer = null;

  // Meeting detection state (US-017)
  let meetingDetected = false;
  let manualStopDuringMeeting = false;

  // Calibration: the live attempt and the saved record for the captured mic.
  let calibrationManager = null;
  let calibration = null; // { baselineDb, calibratedAt, ... } or null
  let calibrationDeviceId = null; // real device id the record belongs to
  let forceCalibration = false; // next device lookup recalibrates

  // ---- Performance management state (US-023) ----
  let perfTargetFps = 30; // Current target FPS (adjusted dynamically)
  let perfLastFrameTime = 0; // Timestamp of last rendered frame
  let perfSilenceStart = null; // When speech stopped (for idle detection)
  let perfIsIdle = false; // Whether audio is currently idle
  const PERF_IDLE_DURATION = 30000; // 30 seconds without speech → idle

  // Settings pushed by the main process (single source of truth).
  let config = {
    sensitivity: 0,
    audioDeviceId: "",
  };

  // DOM elements
  let statusElement = null;
  let compactPill = null;
  let expandedPanel = null;
  let dbReadout = null;
  let zoneLabel = null;
  let stopBtn = null;
  // Alert state DOM elements (US-010)
  let alertPanel = null;
  let alertDismissBtn = null;
  // Session complete DOM elements (US-014)
  let sessionCompletePanel = null;
  let sessionCloseBtn = null;

  // Alert tracker instance (US-010)
  const alertTracker = createAlertTracker();

  // Initialize when DOM is ready
  document.addEventListener("DOMContentLoaded", () => {
    // Get DOM elements
    statusElement = document.getElementById("status");
    compactPill = document.getElementById("compactPill");

    // Cache pill canvas reference (waveform starts when monitoring begins)
    expandedPanel = document.getElementById("expandedPanel");
    dbReadout = document.getElementById("dbReadout");
    zoneLabel = document.getElementById("zoneLabel");
    stopBtn = document.getElementById("stopBtn");
    alertPanel = document.getElementById("alertPanel");
    alertDismissBtn = document.getElementById("alertDismissBtn");
    sessionCompletePanel = document.getElementById("sessionCompletePanel");
    sessionCloseBtn = document.getElementById("sessionCloseBtn");

    // Pre-2.1 renderer copy of score thresholds; no longer meaningful.
    localStorage.removeItem("voiceMonitorSettings");

    // Setup event listeners
    setupEventListeners();

    // Request initial monitoring status
    window.electronAPI.requestMonitoringStatus();

    // Sync initial widget state from main process
    syncWidgetState();
  });

  function setupEventListeners() {
    // ---- Compact pill click (US-006) ----
    if (compactPill) {
      compactPill.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e);
      });
    }

    // ---- Stop button in expanded panel (US-009, updated US-014) ----
    if (stopBtn) {
      stopBtn.addEventListener("click", async () => {
        await finalizeAndShowSessionComplete();
      });
    }

    // ---- Dismiss button in alert panel (US-010, updated US-014) ----
    if (alertDismissBtn) {
      alertDismissBtn.addEventListener("click", async () => {
        alertTracker.dismiss();
        await finalizeAndShowSessionComplete();
      });
    }

    // ---- Close button in session complete panel (US-014) ----
    if (sessionCloseBtn) {
      sessionCloseBtn.addEventListener("click", async () => {
        await window.electronAPI.widgetTransition("compact");
      });
    }

    // Click handler for compact pill — toggle monitoring
    if (compactPill) {
      compactPill.addEventListener("click", (e) => {
        if (_dragState && _dragState.didDrag) return; // ignore drag-end clicks
        if (e.metaKey || e.ctrlKey) {
          window.electronAPI.openSettings();
        } else {
          toggleMonitoring();
        }
      });
    }

    // Right-click for context menu on container
    document
      .querySelector(".container")
      .addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e);
      });

    // Listen for monitoring toggle from main process (tray menu, keyboard shortcut, context menu)
    window.electronAPI.onToggleMonitoring(async (status) => {
      if (status) {
        if (!isMonitoring) {
          try {
            await window.electronAPI.widgetTransition("expanded");
            await startMonitoring();
          } catch (err) {
            // If startMonitoring fails, revert main process state
            console.error("Failed to start monitoring from main toggle:", err);
            window.electronAPI.setMonitoring(false);
            await window.electronAPI.widgetTransition("compact");
          }
        }
      } else {
        if (isMonitoring) {
          await finalizeAndShowSessionComplete();
        }
      }
    });

    // Listen for initial monitoring status
    window.electronAPI.onMonitoringStatus((status) => {
      if (status) {
        startMonitoring().catch(() => {});
      }
    });

    // Settings from main: sensitivity applies immediately; a new mic is
    // reacquired right away (with its own calibration).
    window.electronAPI.onSettingsUpdated((settings) => {
      const previousDevice = config.audioDeviceId || "";
      config = {
        sensitivity: LL.clampSensitivity(settings && settings.sensitivity),
        audioDeviceId: (settings && settings.audioDeviceId) || "",
      };
      if (sessionTracker) sessionTracker.setThresholds(sessionThresholds());
      if (capture && config.audioDeviceId !== previousDevice) {
        console.log("[capture] mic selection changed — reacquiring");
        capture.setDevice(config.audioDeviceId).catch(() => {});
      }
    });

    // Listen for widget state changes from the state machine (US-006, US-024)
    window.electronAPI.onWidgetStateChanged((payload) => {
      applyWidgetState(payload.to, payload.from);
    });

    // Handle trigger-recalibration IPC from context menu (US-010)
    // Recalibrate (context menu or Settings): run the guided calibration live.
    window.electronAPI.onTriggerRecalibration(async function () {
      console.log("[calibration] Recalibration requested");
      if (!isMonitoring) {
        await window.electronAPI.widgetTransition("expanded");
        await startMonitoring({ recalibrate: true }).catch(() => {});
        return;
      }
      if (
        captureStatus &&
        captureStatus.state === "running" &&
        captureStatus.device
      ) {
        calibrationDeviceId = captureStatus.device.deviceId;
        beginCalibration();
      } else {
        // Not capturing right now; calibrate as soon as the mic is back.
        forceCalibration = true;
        calibrationDeviceId = null;
      }
    });

    // Meeting detection indicator on compact pill (US-017)
    if (window.electronAPI.onMeetingDetectionChanged) {
      window.electronAPI.onMeetingDetectionChanged(function (data) {
        meetingDetected = data.detected;
        if (data.detected && !isMonitoring && !manualStopDuringMeeting) {
          if (compactPill) compactPill.classList.add("meeting-detected");
        } else {
          if (compactPill) compactPill.classList.remove("meeting-detected");
          if (!data.detected) manualStopDuringMeeting = false;
        }
      });
    }
  }

  /**
   * Sync initial widget state from the main-process state machine.
   */
  async function syncWidgetState() {
    try {
      const state = await window.electronAPI.widgetGetState();
      applyWidgetState(state);
    } catch (err) {
      console.error("Failed to sync widget state:", err);
      applyWidgetState("compact");
    }
  }

  /**
   * Map state name to its panel element.
   * @param {string} state
   * @returns {HTMLElement|null}
   */
  function getPanelForState(state) {
    if (state === "compact") return compactPill;
    if (state === "expanded") return expandedPanel;
    if (state === "alert") return alertPanel;
    if (state === "sessionComplete") return sessionCompletePanel;
    return null;
  }

  /**
   * Apply the visual layout for a given widget state.
   * Compact shows the glassmorphic pill; expanded shows the monitoring panel (US-009).
   * Now also orchestrates micro-animations (US-024).
   *
   * @param {string} state — target state
   * @param {string} [fromState] — previous state (for transition animations)
   */
  function applyWidgetState(state, fromState) {
    // Determine exit and enter panels for micro-animation
    var exitPanel = fromState ? getPanelForState(fromState) : null;
    var enterPanel = getPanelForState(state);

    if (state === "compact") {
      if (compactPill) compactPill.style.display = "";
      if (expandedPanel) expandedPanel.style.display = "none";
      if (alertPanel) alertPanel.style.display = "none";
      if (sessionCompletePanel) sessionCompletePanel.style.display = "none";
    } else if (state === "expanded") {
      if (compactPill) compactPill.style.display = "none";
      if (expandedPanel) expandedPanel.style.display = "";
      if (alertPanel) alertPanel.style.display = "none";
      if (sessionCompletePanel) sessionCompletePanel.style.display = "none";
    } else if (state === "alert") {
      // US-010: Alert state — show danger panel with shake animation
      if (compactPill) compactPill.style.display = "none";
      if (expandedPanel) expandedPanel.style.display = "none";
      if (sessionCompletePanel) sessionCompletePanel.style.display = "none";
      if (alertPanel) {
        alertPanel.style.display = "";
      }
    } else if (state === "sessionComplete") {
      // US-014: Session complete — show grade summary panel
      if (compactPill) compactPill.style.display = "none";
      if (expandedPanel) expandedPanel.style.display = "none";
      if (alertPanel) alertPanel.style.display = "none";
      if (sessionCompletePanel) {
        sessionCompletePanel.style.display = "";
      }
    } else {
      // Unknown state — fall back to compact
      if (compactPill) compactPill.style.display = "";
      if (expandedPanel) expandedPanel.style.display = "none";
      if (alertPanel) alertPanel.style.display = "none";
      if (sessionCompletePanel) sessionCompletePanel.style.display = "none";
    }

    // Apply micro-animations (US-024)
    if (window.MicroAnimations && fromState) {
      window.MicroAnimations.applyStateTransitionAnimation(
        exitPanel,
        enterPanel,
        fromState,
        state,
      );
    }
  }

  function showContextMenu(event) {
    // Use native context menu - much more elegant!
    // Pass the monitoring state and cursor position to main process
    window.electronAPI.showContextMenu({
      isMonitoring: isMonitoring,
      x: event.x,
      y: event.y,
    });
  }

  async function toggleMonitoring() {
    if (isMonitoring) {
      // Re-expand so the user can see controls and click stop
      await window.electronAPI.widgetTransition("expanded");
      // A click while the mic is unavailable also retries it now.
      if (capture && captureStatus && captureStatus.state === "unavailable") {
        capture.retry().catch(() => {});
      }
      scheduleAutoCollapse(5000);
    } else {
      // Try to transition widget to expanded state
      await window.electronAPI.widgetTransition("expanded");
      try {
        await startMonitoring();
      } catch (err) {
        await window.electronAPI.widgetTransition("compact");
      }
    }
  }

  // ---- Monitoring: capture → one zone decision → pill, tray, session ----

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
      baselineDb: calibration ? calibration.baselineDb : null,
      sensitivity: config.sensitivity,
    };
  }

  function sessionThresholds() {
    return {
      baselineDb: calibration ? calibration.baselineDb : undefined,
      sensitivity: config.sensitivity,
      margins: LL.marginsFor(config.sensitivity),
    };
  }

  async function startMonitoring(options) {
    if (isMonitoring) return;
    console.log("Starting monitoring...");
    forceCalibration = !!(options && options.recalibrate);

    if (window.SessionTracker) {
      sessionTracker = window.SessionTracker.createSessionTracker({
        algorithmVersion: LL.ALGORITHM_VERSION,
        ...sessionThresholds(),
      });
    }
    calibrationManager = window.CalibrationManager.createCalibrationManager();
    calibration = null;
    calibrationDeviceId = null;
    captureStatus = null;

    capture = window.CaptureController.createCaptureController({
      mediaDevices: navigator.mediaDevices,
      createAudioContext: () =>
        new (window.AudioContext || window.webkitAudioContext)(),
      createWorkletNode: (ctx) => new AudioWorkletNode(ctx, "volume-processor"),
      workletUrl: workletUrl(),
      withAnalyser: true,
      onFrame: handleFrame,
      onStatus: handleCaptureStatus,
      getTransports: () =>
        window.electronAPI.getInputTransports
          ? window.electronAPI.getInputTransports()
          : null,
      log: (m) => console.log(m),
    });

    // Monitoring is on from here: a missing mic shows as unavailable/retrying.
    isMonitoring = true;
    if (statusElement) statusElement.textContent = "Starting…";
    if (compactPill) {
      compactPill.classList.add("monitoring");
      compactPill.classList.remove("animate-breathing");
      compactPill.classList.remove("meeting-detected"); // US-017
    }
    const pillCanvas = document.getElementById("pillWaveformCanvas");
    if (window.PillWaveform && pillCanvas) {
      window.PillWaveform.start(pillCanvas);
    }
    window.electronAPI.setMonitoring(true);

    try {
      await capture.start(config.audioDeviceId || "");
    } catch (error) {
      // Only permission errors reach here; everything else retries.
      console.error("Failed to start monitoring:", error);
      stopMonitoring();
      window.electronAPI.setMonitoring(false);
      alert(
        "Microphone access denied. Please grant microphone permissions to use quietpls.",
      );
      throw error;
    }
    console.log("Monitoring started");
  }

  function scheduleAutoCollapse(ms) {
    if (_autoCollapseTimer) clearTimeout(_autoCollapseTimer);
    _autoCollapseTimer = setTimeout(async () => {
      _autoCollapseTimer = null;
      // Stay open while calibrating or while the mic is not working.
      if (!isMonitoring || needsAttention()) return;
      await window.electronAPI.widgetTransition("compact");
    }, ms);
  }

  function needsAttention() {
    const z = lastDecision && lastDecision.zone;
    return (
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
    console.log(
      "[capture] " +
        status.state +
        (status.reason ? " (" + status.reason + ")" : ""),
    );

    if (status.state === "running") {
      const fftCanvas = document.getElementById("fftCanvas");
      const analyser = capture && capture.getAnalyser();
      if (window.FFTVisualizer && fftCanvas && analyser) {
        window.FFTVisualizer.startVisualization(analyser, fftCanvas);
      }
      if (status.reason === "fallback") {
        showCalibrationNotification(
          "Selected mic unavailable — using " +
            (status.device.label || "the default mic"),
        );
      }
      if (status.device && status.device.deviceId !== calibrationDeviceId) {
        await useCalibrationFor(status.device);
      }
      if (!previous || previous.state !== "running") scheduleAutoCollapse(3000);
    } else if (
      status.state === "reconnecting" ||
      status.state === "unavailable"
    ) {
      // Make the problem visible: open the panel and drop stale levels.
      await window.electronAPI.widgetTransition("expanded");
    }
    if (status.state !== "running" && status.state !== "idle") {
      showDecision(LL.decideZone(null, currentContext()), null);
    }
    reportCaptureStatus();
  }

  async function useCalibrationFor(device) {
    calibrationDeviceId = device.deviceId;
    calibration = null;
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
      calibrationManager = window.CalibrationManager.createCalibrationManager();
      if (sessionTracker) sessionTracker.setThresholds(sessionThresholds());
      console.log(
        "[calibration] using saved normal for",
        device.label,
        record.baselineDb,
        "dBFS",
      );
    } else {
      beginCalibration();
    }
  }

  function beginCalibration() {
    forceCalibration = false;
    calibration = null;
    calibrationManager = window.CalibrationManager.createCalibrationManager();
    calibrationManager.start();
    if (_autoCollapseTimer) clearTimeout(_autoCollapseTimer);
    window.electronAPI.widgetTransition("expanded");
    showCalibrationNotification("Talk normally for about 5 seconds");
    reportCaptureStatus();
  }

  function handleCalibrationResult(result, device) {
    if (result.status === "ok") {
      calibration = window.CalibrationManager.makeCalibrationRecord(
        result,
        device,
      );
      window.electronAPI.saveCalibration(device.deviceId, calibration);
      if (sessionTracker) sessionTracker.setThresholds(sessionThresholds());
      showCalibrationNotification("Calibrated — that's your normal");
      console.log(
        "[calibration] normal =",
        result.baselineDb,
        "dBFS for",
        device.label,
      );
      reportCaptureStatus();
      scheduleAutoCollapse(3000);
      return;
    }
    // Retry with a fresh attempt; nothing from the failed one carries over.
    showCalibrationNotification(
      result.status === "clipping"
        ? "Mic is overloading — move back or lower input gain, then talk normally"
        : "Didn't hear you — talk normally for about 5 seconds",
    );
    calibrationManager.start();
  }

  function handleFrame(msg, device) {
    if (calibrationManager && calibrationManager.isCalibrating()) {
      const result = calibrationManager.addFrame(msg);
      if (result) handleCalibrationResult(result, device);
    }

    const decision = LL.decideZone(msg, currentContext());

    // Session and alert see every frame; display is throttled below.
    if (sessionTracker) sessionTracker.recordFrame(decision, msg.frameMs);
    const alertAction = alertTracker.update(decision.zone, Date.now());
    if (alertAction === "trigger-alert") {
      window.electronAPI.widgetTransition("alert");
    } else if (alertAction === "dismiss-alert") {
      window.electronAPI.widgetTransition("expanded");
    }

    // ---- Idle detection (US-023): 30 s without speech pauses the FFT ----
    const now = performance.now();
    if (decision.speaking) {
      perfSilenceStart = null;
      if (perfIsIdle) {
        perfIsIdle = false;
        perfTargetFps = 30;
        const fftCanvas = document.getElementById("fftCanvas");
        const analyser = capture && capture.getAnalyser();
        if (window.FFTVisualizer && fftCanvas && analyser) {
          window.FFTVisualizer.startVisualization(analyser, fftCanvas);
        }
      }
    } else {
      if (perfSilenceStart === null) perfSilenceStart = now;
      if (!perfIsIdle && now - perfSilenceStart >= PERF_IDLE_DURATION) {
        perfIsIdle = true;
        perfTargetFps = 5;
        if (window.FFTVisualizer) window.FFTVisualizer.stopVisualization();
      }
    }

    // ---- Frame throttling (US-023) ----
    if (
      perfLastFrameTime > 0 &&
      now - perfLastFrameTime < 1000 / perfTargetFps &&
      (!lastDecision || lastDecision.zone === decision.zone)
    ) {
      return;
    }
    perfLastFrameTime = now;
    showDecision(decision, msg);
  }

  /**
   * Render one zone decision everywhere: pill, panel, alert panel, tray and
   * the Settings meter all receive the same object.
   */
  function showDecision(decision, msg) {
    lastDecision = decision;
    const visual = LL.zoneToVisual(decision.zone);
    const lost =
      decision.zone === "reconnecting" || decision.zone === "unavailable";
    const level = msg && !lost ? LL.displayLevel(msg.dbfs) : 0;
    const zoneClasses = [
      "zone-quiet",
      "zone-normal",
      "zone-loud",
      "zone-danger",
    ];

    if (window.PillWaveform) {
      window.PillWaveform.updateVolume(level);
      window.PillWaveform.setZone(visual);
    }
    [compactPill, expandedPanel].forEach((el) => {
      if (!el) return;
      el.classList.remove(...zoneClasses);
      el.classList.add("zone-" + visual);
      el.classList.toggle("capture-lost", lost);
    });

    let readout;
    let label = decision.label;
    if (decision.speaking) {
      readout = LL.formatRelativeShort(decision.relDb);
    } else if (decision.zone === "calibrating") {
      readout = "Talk normally";
      label =
        "Calibrating… " +
        Math.round(calibrationManager.getProgress() * 100) +
        "%";
    } else if (lost) {
      readout = "Mic";
      if (
        decision.zone === "unavailable" &&
        captureStatus &&
        captureStatus.reason === "permission"
      ) {
        label = "Mic access denied";
      }
    } else {
      readout = "—";
    }
    if (dbReadout) {
      dbReadout.textContent = readout;
      dbReadout.title = "Level relative to your calibrated normal voice";
    }
    if (zoneLabel) zoneLabel.textContent = label;

    const alertDbReadout = document.getElementById("alertDbReadout");
    if (alertDbReadout) {
      alertDbReadout.textContent = decision.speaking
        ? LL.formatRelative(decision.relDb)
        : "";
    }
    if (alertPanel && alertPanel.style.display !== "none") {
      alertPanel.classList.remove(...zoneClasses);
      alertPanel.classList.add("zone-" + visual);
    }

    if (window.FFTVisualizer) window.FFTVisualizer.setVolumeZone(visual);

    // ---- Volume-reactive micro-animations (US-024) ----
    if (window.MicroAnimations) {
      const activePanel =
        expandedPanel && expandedPanel.style.display !== "none"
          ? expandedPanel
          : alertPanel && alertPanel.style.display !== "none"
            ? alertPanel
            : null;
      if (activePanel) {
        window.MicroAnimations.createGlowEffect(activePanel, visual, level);
        if (decision.zone === "danger") {
          window.MicroAnimations.pulseOnVolumeSpike(activePanel, 100, 50);
        }
      }
    }

    if (isMonitoring && statusElement) statusElement.textContent = label;

    // One decision for tray and Settings, too.
    window.electronAPI.sendLevelUpdate({
      zone: decision.zone,
      visual,
      level,
      relDb: decision.relDb,
      label,
    });
  }

  // ---- Calibration notification UI (US-011) ----

  let _calibrationNotificationTimer = null;

  /**
   * Show a brief non-blocking notification in the expanded panel.
   * Auto-dismisses after 4 seconds.
   * @param {string} text — message to display
   */
  function showCalibrationNotification(text) {
    if (_calibrationNotificationTimer) {
      clearTimeout(_calibrationNotificationTimer);
      _calibrationNotificationTimer = null;
    }
    var el = document.getElementById("calibrationNotification");
    if (!el && expandedPanel) {
      el = document.createElement("span");
      el.id = "calibrationNotification";
      el.className = "calibration-notification";
      expandedPanel.appendChild(el);
    }
    if (!el) return;

    el.textContent = text;
    el.style.display = "";
    el.style.opacity = "1";
    _calibrationNotificationTimer = setTimeout(function () {
      el.style.opacity = "0";
      setTimeout(function () {
        el.style.display = "none";
      }, 300);
      _calibrationNotificationTimer = null;
    }, 4000);
  }

  function stopMonitoring() {
    console.log("Stopping monitoring...");

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
    lastDecision = null;
    reportCaptureStatus();

    // Reset performance state (US-023)
    perfLastFrameTime = 0;
    perfSilenceStart = null;
    perfIsIdle = false;
    perfTargetFps = 30;

    if (window.FFTVisualizer) {
      window.FFTVisualizer.stopVisualization();
    }

    if (statusElement) statusElement.textContent = "Click to start";
    if (dbReadout) dbReadout.textContent = "—";
    if (zoneLabel) zoneLabel.textContent = "Ready";
    if (expandedPanel) {
      expandedPanel.classList.remove(
        "zone-quiet",
        "zone-normal",
        "zone-loud",
        "zone-danger",
        "capture-lost",
      );
      expandedPanel.classList.add("zone-quiet");
    }

    alertTracker.reset();
    if (alertPanel) {
      alertPanel.classList.remove(
        "animate-danger-shake",
        "zone-loud",
        "zone-danger",
      );
    }

    if (compactPill) {
      compactPill.classList.remove(
        "monitoring",
        "zone-quiet",
        "zone-normal",
        "zone-loud",
        "zone-danger",
        "capture-lost",
      );
      compactPill.classList.add("animate-breathing");
    }

    if (window.PillWaveform) {
      window.PillWaveform.stop();
    }

    console.log("Monitoring stopped");
  }

  // ---- Session Complete Flow (US-014) ----

  /**
   * Populate the session insights panel with duration and insight text items.
   * @param {string[]} insights — array of plain-language insight strings (max 3)
   * @param {number} durationSec — session duration in seconds
   */
  function populateSessionInsights(insights, durationSec) {
    var durationEl = document.getElementById("sessionDuration");
    if (durationEl) {
      durationEl.textContent = formatDuration(durationSec);
    }
    var listEl = document.getElementById("insightList");
    if (listEl) {
      listEl.innerHTML = "";
      for (var i = 0; i < insights.length; i++) {
        var li = document.createElement("li");
        li.className = "session-complete__insight-item";
        li.textContent = insights[i];
        listEl.appendChild(li);
      }
    }
  }

  // Session tracker instance — created when monitoring starts, finalized when it stops
  let sessionTracker = null;

  /**
   * Finalize the current monitoring session, save it via IPC, and transition
   * to the sessionComplete widget state.
   */
  async function finalizeAndShowSessionComplete() {
    // US-017: Track manual stop during meeting to suppress re-prompting
    if (meetingDetected) manualStopDuringMeeting = true;

    // Stop audio monitoring first
    stopMonitoring();
    window.electronAPI.setMonitoring(false);

    // If we have a session tracker with an active session, finalize and save it
    let sessionDuration = 0;
    let sessionData = null;
    if (sessionTracker) {
      sessionData = sessionTracker.finalize();
      if (sessionData) {
        sessionDuration = sessionData.duration || 0;
        try {
          const saveResult = await window.electronAPI.saveSession(sessionData);
          if (saveResult && saveResult.success) {
            console.log("[session] Session saved:", saveResult.data.id);
          } else {
            console.warn(
              "[session] Failed to save session:",
              saveResult && saveResult.error,
            );
          }
        } catch (err) {
          console.error("[session] Error saving session:", err);
        }
      }
      sessionTracker = null;
    }

    // For sessions >= 60s with insights available, populate the insights panel
    if (sessionData && sessionData.duration >= 60 && window.SessionInsights) {
      var insights = window.SessionInsights.generateInsights(sessionData);
      populateSessionInsights(insights, sessionData.duration);
    } else {
      // Short session (< 60s) or no insights: skip insights, go straight to compact
      await window.electronAPI.widgetTransition("compact");
      return;
    }

    // Transition to sessionComplete state
    const result = await window.electronAPI.widgetTransition("sessionComplete");
    if (result && !result.success) {
      console.error(
        "[session] Widget transition to sessionComplete failed:",
        result.error,
      );
      if (sessionCompletePanel) {
        sessionCompletePanel.style.display = "";
      }
    }
  }

  // ---- Manual Drag-and-Snap (US-006) ----
  // Implements drag via mousedown/mousemove/mouseup with click-vs-drag discrimination.
  // Snaps to nearest anchor only on actual drag-end, not on button clicks.

  let _dragState = null; // { startScreenX, startScreenY, winStartX, winStartY, didDrag }
  const DRAG_THRESHOLD_PX = 4; // minimum mouse movement to count as a drag

  document.addEventListener("mousedown", async (e) => {
    // Only drag on left-click, and not on interactive elements
    if (e.button !== 0) return;
    const tag = e.target.tagName.toLowerCase();
    if (
      tag === "button" ||
      tag === "input" ||
      tag === "select" ||
      tag === "canvas"
    )
      return;
    if (e.target.closest("button") || e.target.closest("canvas")) return;

    try {
      const pos = await window.electronAPI.getWindowPosition();
      _dragState = {
        startScreenX: e.screenX,
        startScreenY: e.screenY,
        winStartX: pos.x,
        winStartY: pos.y,
        didDrag: false,
      };
    } catch (err) {
      _dragState = null;
    }
  });

  document.addEventListener("mousemove", (e) => {
    if (!_dragState) return;
    const dx = e.screenX - _dragState.startScreenX;
    const dy = e.screenY - _dragState.startScreenY;

    if (
      !_dragState.didDrag &&
      (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)
    ) {
      _dragState.didDrag = true;
    }

    if (_dragState.didDrag) {
      window.electronAPI.setWindowPosition(
        _dragState.winStartX + dx,
        _dragState.winStartY + dy,
      );
    }
  });

  document.addEventListener("mouseup", () => {
    if (_dragState && _dragState.didDrag) {
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
      const anchorCenter = anchors[i] + windowWidth / 2;
      const dist = Math.abs(windowCenterX - anchorCenter);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = anchors[i];
      }
    }

    return nearest;
  }
} // end of else block (renderer-only code)
