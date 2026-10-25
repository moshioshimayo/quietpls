// Main window renderer - just the floating pill

// ---- Pure helper functions (US-009) — no DOM/window dependencies ----

/**
 * Derive the volume zone and label from the normalized volume and current config.
 * Pure function — exported for testing.
 * @param {number} normalizedVolume — 0–100
 * @param {{ quietThreshold: number, normalThreshold: number, warningThreshold: number }} thresholds
 * @returns {{ zone: string, label: string }}
 */
function deriveVolumeZone(normalizedVolume, thresholds) {
  if (normalizedVolume < thresholds.quietThreshold) {
    return { zone: "quiet", label: "Speak up" };
  } else if (normalizedVolume < thresholds.normalThreshold) {
    return { zone: "normal", label: "Good" };
  } else if (normalizedVolume < thresholds.warningThreshold) {
    return { zone: "warning", label: "Loud" };
  }
  return { zone: "danger", label: "Too loud!" };
}

/**
 * Convert a normalized 0–100 volume into an approximate dB SPL string.
 * Pure function — exported for testing.
 * @param {number} normalizedVolume — 0–100
 * @returns {string} e.g. "-42 dB" or "-- dB" when silent
 */
function volumeToDbString(normalizedVolume) {
  if (normalizedVolume <= 0) return "-- dB";
  // Map 0–100 to a 30–100 dB SPL-like scale (louder = bigger number)
  const db = Math.round(30 + (normalizedVolume / 100) * 70);
  return db + " dB";
}

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
  LOUD_TRIGGER_MS: 3000, // 3 seconds of continuous loud/danger before alert triggers
  QUIET_DISMISS_MS: 5000, // 5 seconds below loud before auto-dismiss
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
   * @param {string} zone — 'quiet' | 'normal' | 'warning' | 'danger'
   * @param {number} now — current timestamp (ms), e.g. Date.now()
   * @returns {'trigger-alert' | 'dismiss-alert' | 'none'}
   */
  function update(zone, now) {
    const isLoud = zone === "warning" || zone === "danger";

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

// ---- Pure helper functions (US-023) — resource throttle utilities ----

/**
 * Detect whether audio input is idle.
 * Pure function — mirrors resource-throttle.js isIdleAudio.
 * @param {number} volume
 * @param {number} idleThreshold
 * @param {number} idleDurationMs
 * @param {number} elapsedSilenceMs
 * @returns {boolean}
 */
function isIdleAudio(volume, idleThreshold, idleDurationMs, elapsedSilenceMs) {
  if (volume >= idleThreshold) return false;
  return elapsedSilenceMs >= idleDurationMs;
}

// Export pure functions for testing (Node.js / vitest)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    deriveVolumeZone,
    volumeToDbString,
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

  let audioContext = null;
  let microphone = null;
  let mediaStream = null; // Store stream separately for reliable cleanup
  let workletNode = null;
  let analyserNode = null;
  let isMonitoring = false;
  let averageVolume = 0;
  let _autoCollapseTimer = null;

  // Meeting detection state (US-017)
  let meetingDetected = false;
  let manualStopDuringMeeting = false;

  // Calibration manager instance (US-010)
  let calibrationManager = null;

  // ---- Performance management state (US-023) ----
  let perfTargetFps = 30; // Current target FPS (adjusted dynamically)
  let perfLastFrameTime = 0; // Timestamp of last rendered frame
  let perfSilenceStart = null; // When silence began (for idle detection)
  let perfIsIdle = false; // Whether audio is currently idle
  const PERF_IDLE_THRESHOLD = 2; // Volume below this is "silent"
  const PERF_IDLE_DURATION = 30000; // 30 seconds of silence → idle

  // Configuration with defaults from shared config (via preload)
  const defaults = window.electronAPI.defaultThresholds;
  let config = {
    quietThreshold: defaults.quietThreshold,
    normalThreshold: defaults.normalThreshold,
    warningThreshold: defaults.warningThreshold,
    updateInterval: 50,
    minDecibels: -90,
    maxDecibels: -10,
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

    // Load saved settings
    loadSettings();

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
        startMonitoring();
      }
    });

    // Listen for settings updates
    window.electronAPI.onSettingsUpdated((settings) => {
      config = { ...config, ...settings };
      saveSettings();
    });

    // Listen for widget state changes from the state machine (US-006, US-024)
    window.electronAPI.onWidgetStateChanged((payload) => {
      applyWidgetState(payload.to, payload.from);
    });

    // Handle trigger-recalibration IPC from context menu (US-010)
    window.electronAPI.onTriggerRecalibration(function () {
      if (calibrationManager) {
        console.log("[calibration] Recalibration triggered from context menu");
        var calDeviceId = config.audioDeviceId || "default";
        calibrationManager.reset();
        registerCalibrationCallback(calDeviceId);
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

  function loadSettings() {
    const saved = localStorage.getItem("voiceMonitorSettings");
    if (saved) {
      try {
        const settings = JSON.parse(saved);
        config = { ...config, ...settings };
      } catch (e) {
        console.error("Failed to load settings:", e);
      }
    }
  }

  function saveSettings() {
    localStorage.setItem(
      "voiceMonitorSettings",
      JSON.stringify({
        quietThreshold: config.quietThreshold,
        normalThreshold: config.normalThreshold,
        warningThreshold: config.warningThreshold,
      }),
    );
  }

  async function toggleMonitoring() {
    if (isMonitoring) {
      // Re-expand so the user can see controls and click stop
      await window.electronAPI.widgetTransition("expanded");
      // Auto-collapse back to compact if they don't interact
      if (_autoCollapseTimer) clearTimeout(_autoCollapseTimer);
      _autoCollapseTimer = setTimeout(async () => {
        _autoCollapseTimer = null;
        if (isMonitoring) {
          await window.electronAPI.widgetTransition("compact");
        }
      }, 5000);
    } else {
      // Try to transition widget to expanded state
      await window.electronAPI.widgetTransition("expanded");
      // Start monitoring (notifies main process on success)
      await startMonitoring();
    }
  }

  async function startMonitoring() {
    console.log("Starting monitoring...");

    // Create session tracker for this monitoring session
    if (window.SessionTracker) {
      sessionTracker = window.SessionTracker.createSessionTracker({
        quietThreshold: config.quietThreshold,
        normalThreshold: config.normalThreshold,
        warningThreshold: config.warningThreshold,
      });
    }

    // Initialize calibration manager (US-010)
    if (window.CalibrationManager) {
      var calDeviceId = config.audioDeviceId || "default";
      var cachedCal = await window.electronAPI.getCalibration(calDeviceId);
      calibrationManager = window.CalibrationManager.createCalibrationManager({
        cachedCalibration: cachedCal || null,
      });

      // If cached thresholds exist, apply them to config immediately
      if (cachedCal && cachedCal.thresholds) {
        config.quietThreshold = cachedCal.thresholds.quiet;
        config.normalThreshold = cachedCal.thresholds.normal;
        config.warningThreshold = cachedCal.thresholds.warning;
      }

      // Register onComplete callback to swap thresholds and persist (US-011)
      registerCalibrationCallback(calDeviceId);
    }

    try {
      // Build audio constraints, including device selection if set
      const audioConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };

      if (config.audioDeviceId) {
        audioConstraints.deviceId = { exact: config.audioDeviceId };
      }

      // Get user permission for microphone
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
        });
      } catch (deviceError) {
        // If specific device failed, fall back to system default
        if (
          config.audioDeviceId &&
          (deviceError.name === "NotFoundError" ||
            deviceError.name === "OverconstrainedError")
        ) {
          console.warn(
            "Selected audio device unavailable, falling back to system default",
          );
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
        } else {
          throw deviceError;
        }
      }

      console.log("Microphone access granted");

      // Store the stream globally for reliable cleanup
      mediaStream = stream;

      // Create audio context and load AudioWorklet processor
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      // When running from ASAR, unpacked files are at app.asar.unpacked/
      // In dev or non-ASAR builds, the file is in the same directory as index.html
      const workletPath = window.location.href.includes("app.asar")
        ? "../app.asar.unpacked/volume-processor.js"
        : "volume-processor.js";
      await audioContext.audioWorklet.addModule(workletPath);
      microphone = audioContext.createMediaStreamSource(stream);

      // Create AudioWorklet node (replaces ScriptProcessorNode + AnalyserNode)
      workletNode = new AudioWorkletNode(audioContext, "volume-processor");

      // Receive volume data from the worklet and apply smoothing
      workletNode.port.onmessage = function (event) {
        const volume = event.data.volume;
        averageVolume = volume;

        // ---- Idle detection (US-023) ----
        const now = performance.now();
        if (averageVolume >= PERF_IDLE_THRESHOLD) {
          perfSilenceStart = null;
          if (perfIsIdle) {
            perfIsIdle = false;
            perfTargetFps = 30;
            console.log("[perf] Audio resumed — exiting idle mode");
            // Resume FFT visualization
            const fftCanvas = document.getElementById("fftCanvas");
            if (window.FFTVisualizer && fftCanvas && analyserNode) {
              window.FFTVisualizer.startVisualization(analyserNode, fftCanvas);
            }
          }
        } else {
          if (perfSilenceStart === null) perfSilenceStart = now;
          if (
            !perfIsIdle &&
            isIdleAudio(
              averageVolume,
              PERF_IDLE_THRESHOLD,
              PERF_IDLE_DURATION,
              now - perfSilenceStart,
            )
          ) {
            perfIsIdle = true;
            perfTargetFps = 5;
            console.log("[perf] Audio idle — reducing resource usage");
            // Pause FFT rendering to save CPU
            if (window.FFTVisualizer) {
              window.FFTVisualizer.stopVisualization();
            }
          }
        }

        // Feed volume to session tracker BEFORE frame throttling —
        // session detection needs every sample, not just rendered frames
        if (sessionTracker) {
          sessionTracker.recordVolume(averageVolume);
        }

        // Feed volume to calibration manager (US-010)
        if (calibrationManager && !calibrationManager.isCalibrated()) {
          calibrationManager.addSample(averageVolume);
        }

        // ---- Frame throttling (US-023) ----
        if (
          perfTargetFps > 0 &&
          perfLastFrameTime > 0 &&
          now - perfLastFrameTime < 1000 / perfTargetFps
        ) {
          return; // Skip this frame to hit target FPS
        }
        perfLastFrameTime = now;

        // Update display
        updateDisplay(averageVolume);

        // Send volume to settings window if open
        window.electronAPI.sendVolumeUpdate(averageVolume);
      };

      // Create AnalyserNode for FFT frequency analysis (used by visualizer in US-008)
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 512;
      analyserNode.smoothingTimeConstant = 0.8;

      // Connect: microphone -> workletNode (RMS), microphone -> analyserNode (FFT)
      // Neither is connected to destination (no playback/feedback)
      microphone.connect(workletNode);
      microphone.connect(analyserNode);

      // Update UI state
      isMonitoring = true;
      if (statusElement) statusElement.textContent = "Monitoring";

      // Start FFT visualization (US-008)
      const fftCanvas = document.getElementById("fftCanvas");
      if (window.FFTVisualizer && fftCanvas && analyserNode) {
        window.FFTVisualizer.startVisualization(analyserNode, fftCanvas);
      }

      // Mark compact pill as monitoring and start waveform
      if (compactPill) {
        compactPill.classList.add("monitoring");
        compactPill.classList.remove("animate-breathing");
        compactPill.classList.remove("meeting-detected"); // US-017: remove meeting indicator when monitoring starts
      }
      const pillCanvas = document.getElementById("pillWaveformCanvas");
      if (window.PillWaveform && pillCanvas) {
        window.PillWaveform.start(pillCanvas);
      }

      // Notify main process that monitoring is active
      window.electronAPI.setMonitoring(true);

      // Auto-collapse to compact pill with waveform after 3 seconds
      if (_autoCollapseTimer) clearTimeout(_autoCollapseTimer);
      _autoCollapseTimer = setTimeout(async () => {
        _autoCollapseTimer = null;
        if (isMonitoring) {
          await window.electronAPI.widgetTransition("compact");
        }
      }, 3000);

      console.log("Monitoring started successfully");
    } catch (error) {
      console.error("Failed to start monitoring:", error);

      if (
        error.name === "NotAllowedError" ||
        error.name === "PermissionDeniedError"
      ) {
        alert(
          "Microphone access denied. Please grant microphone permissions to use quietpls.",
        );
      } else {
        alert("Failed to access microphone: " + error.message);
      }

      isMonitoring = false;
    }
  }

  // ---- Calibration notification UI (US-011) ----

  let _calibrationNotificationTimer = null;

  /**
   * Show a brief non-blocking notification in the expanded panel.
   * Auto-dismisses after 3 seconds.
   * @param {string} text — message to display
   */
  function showCalibrationNotification(text) {
    // Clear any pending dismiss timer
    if (_calibrationNotificationTimer) {
      clearTimeout(_calibrationNotificationTimer);
      _calibrationNotificationTimer = null;
    }

    // Find or create the notification element inside the expanded panel
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

    // Auto-dismiss after 3 seconds
    _calibrationNotificationTimer = setTimeout(function () {
      el.style.opacity = "0";
      // Remove from layout after fade
      setTimeout(function () {
        el.style.display = "none";
      }, 300);
      _calibrationNotificationTimer = null;
    }, 3000);
  }

  /**
   * Register the onComplete callback for the calibration manager.
   * Handles edge-case statuses with user notifications (US-011).
   * @param {string} deviceId — the audio device ID for persistence
   */
  function registerCalibrationCallback(deviceId) {
    if (!calibrationManager) return;

    calibrationManager.onComplete(function (result) {
      if (result.status === "silent") {
        showCalibrationNotification("Calibration skipped — no voice detected");
        console.log("[calibration] Silent input — calibration skipped");
      } else if (result.status === "muted") {
        showCalibrationNotification("Mic appears muted. Unmute to calibrate.");
        console.log("[calibration] Muted mic — calibration skipped");
      } else if (result.status === "insufficient") {
        showCalibrationNotification("Not enough audio for calibration.");
        console.log("[calibration] Insufficient samples — calibration skipped");
      } else if (result.status === "high-noise") {
        showCalibrationNotification(
          "High background noise detected. Thresholds adjusted.",
        );
        console.log(
          "[calibration] High noise — thresholds capped:",
          result.thresholds,
        );
        // Still apply thresholds from capped baseline
        config.quietThreshold = result.thresholds.quiet;
        config.normalThreshold = result.thresholds.normal;
        config.warningThreshold = result.thresholds.warning;
        window.electronAPI.saveCalibration(
          deviceId,
          calibrationManager.getCalibrationData(),
        );
      } else if (result.thresholds) {
        config.quietThreshold = result.thresholds.quiet;
        config.normalThreshold = result.thresholds.normal;
        config.warningThreshold = result.thresholds.warning;
        console.log("[calibration] Thresholds updated:", result.thresholds);
        window.electronAPI.saveCalibration(
          deviceId,
          calibrationManager.getCalibrationData(),
        );
      }
    });
  }

  // ---- Device switch handling (US-011) ----
  navigator.mediaDevices.addEventListener("devicechange", async function () {
    if (!isMonitoring || !calibrationManager) return;

    var newDeviceId = config.audioDeviceId || "default";
    console.log(
      "[calibration] Device change detected, checking calibration for:",
      newDeviceId,
    );

    try {
      var cached = await window.electronAPI.getCalibration(newDeviceId);
      if (cached && cached.thresholds) {
        config.quietThreshold = cached.thresholds.quiet;
        config.normalThreshold = cached.thresholds.normal;
        config.warningThreshold = cached.thresholds.warning;
        console.log(
          "[calibration] Loaded cached thresholds for new device:",
          cached.thresholds,
        );
      }
    } catch (err) {
      console.warn(
        "[calibration] Failed to load cached calibration for new device:",
        err,
      );
    }

    // Reset calibration manager to recalibrate for the new device
    calibrationManager.reset();
    registerCalibrationCallback(newDeviceId);
  });

  function stopMonitoring() {
    console.log("Stopping monitoring...");

    // Cancel auto-collapse timer if pending
    if (_autoCollapseTimer) {
      clearTimeout(_autoCollapseTimer);
      _autoCollapseTimer = null;
    }

    // First, stop all media stream tracks - this releases the microphone
    if (mediaStream) {
      console.log("Stopping media stream tracks...");
      mediaStream.getTracks().forEach((track) => {
        console.log(`Stopping track: ${track.kind} - ${track.label}`);
        track.stop();
      });
      mediaStream = null;
    }

    // Then clean up audio nodes
    if (audioContext) {
      if (microphone) {
        microphone.disconnect();
      }
      if (workletNode) {
        workletNode.disconnect();
        workletNode.port.onmessage = null;
      }
      if (analyserNode) {
        analyserNode.disconnect();
      }

      // Close audio context to release all resources
      audioContext.close().then(() => {
        console.log("Audio context closed");
      });

      audioContext = null;
      microphone = null;
      workletNode = null;
      analyserNode = null;
    }

    isMonitoring = false;
    averageVolume = 0;

    // Reset calibration manager (US-010)
    calibrationManager = null;

    // Reset performance state (US-023)
    perfLastFrameTime = 0;
    perfSilenceStart = null;
    perfIsIdle = false;
    perfTargetFps = 30;

    // Stop FFT visualization with fade-out (US-008)
    if (window.FFTVisualizer) {
      window.FFTVisualizer.stopVisualization();
    }

    // Reset UI
    if (statusElement) statusElement.textContent = "Click to start";

    // Reset expanded panel (US-009)
    if (dbReadout) dbReadout.textContent = "-- dB";
    if (zoneLabel) zoneLabel.textContent = "Quiet";
    if (expandedPanel) {
      expandedPanel.classList.remove(
        "zone-quiet",
        "zone-normal",
        "zone-loud",
        "zone-danger",
      );
      expandedPanel.classList.add("zone-quiet");
    }

    // Reset alert state (US-010)
    alertTracker.reset();
    if (alertPanel) {
      alertPanel.classList.remove(
        "animate-danger-shake",
        "zone-loud",
        "zone-danger",
      );
    }

    // Reset compact pill to idle state
    if (compactPill) {
      compactPill.classList.remove(
        "monitoring",
        "zone-quiet",
        "zone-normal",
        "zone-loud",
        "zone-danger",
      );
      compactPill.classList.add("animate-breathing");
    }

    // Stop pill waveform
    if (window.PillWaveform) {
      window.PillWaveform.stop();
    }

    console.log("Monitoring stopped");
  }

  function updateDisplay(volume) {
    // Normalize volume to 0-100 scale
    const normalizedVolume = Math.min(100, Math.max(0, volume));

    // Determine the zone and label
    const { zone, label } = deriveVolumeZone(normalizedVolume, config);

    // ---- Pill waveform + zone glow ----
    if (window.PillWaveform) {
      window.PillWaveform.updateVolume(normalizedVolume);
      const vizZone = zone === "warning" ? "loud" : zone;
      window.PillWaveform.setZone(vizZone);
    }
    if (compactPill) {
      compactPill.classList.remove(
        "zone-quiet",
        "zone-normal",
        "zone-loud",
        "zone-danger",
      );
      const pillZoneClass = zone === "warning" ? "zone-loud" : "zone-" + zone;
      compactPill.classList.add(pillZoneClass);
    }

    // ---- Expanded panel updates (US-009) ----
    if (expandedPanel) {
      // Update zone class on expanded panel for reactive glow/colors
      expandedPanel.classList.remove(
        "zone-quiet",
        "zone-normal",
        "zone-loud",
        "zone-danger",
      );
      // Map 'warning' zone to 'loud' design-system class
      const zoneClass = zone === "warning" ? "zone-loud" : "zone-" + zone;
      expandedPanel.classList.add(zoneClass);
    }

    if (dbReadout) {
      dbReadout.textContent = volumeToDbString(normalizedVolume);
    }

    // Update alert panel dB readout (US-010)
    const alertDbReadout = document.getElementById("alertDbReadout");
    if (alertDbReadout) {
      alertDbReadout.textContent = volumeToDbString(normalizedVolume);
    }

    if (zoneLabel) {
      if (calibrationManager && calibrationManager.isCalibrating()) {
        zoneLabel.textContent = "Calibrating...";
      } else {
        zoneLabel.textContent = label;
      }
    }

    // Update FFT visualizer zone color (US-008)
    if (window.FFTVisualizer) {
      // Map 'warning' state to 'loud' zone for the visualizer
      const vizZone = zone === "warning" ? "loud" : zone;
      window.FFTVisualizer.setVolumeZone(vizZone);
    }

    // ---- Volume-reactive micro-animations (US-024) ----
    if (window.MicroAnimations) {
      const vizZone = zone === "warning" ? "loud" : zone;
      // Dynamic glow intensity on whichever panel is visible
      const activePanel =
        expandedPanel && expandedPanel.style.display !== "none"
          ? expandedPanel
          : alertPanel && alertPanel.style.display !== "none"
            ? alertPanel
            : null;
      if (activePanel) {
        window.MicroAnimations.createGlowEffect(
          activePanel,
          vizZone,
          normalizedVolume,
        );
        // Micro-pulse on volume spikes above warning threshold
        window.MicroAnimations.pulseOnVolumeSpike(
          activePanel,
          normalizedVolume,
          config.warningThreshold,
        );
      }
    }

    // ---- Alert state auto-trigger / auto-dismiss (US-010) ----
    const alertAction = alertTracker.update(zone, Date.now());
    if (alertAction === "trigger-alert") {
      window.electronAPI.widgetTransition("alert");
    } else if (alertAction === "dismiss-alert") {
      window.electronAPI.widgetTransition("expanded");
    }

    // Update alert panel zone class when in alert state
    if (alertPanel && alertPanel.style.display !== "none") {
      alertPanel.classList.remove(
        "zone-quiet",
        "zone-normal",
        "zone-loud",
        "zone-danger",
      );
      const alertZoneClass = zone === "warning" ? "zone-loud" : "zone-" + zone;
      alertPanel.classList.add(alertZoneClass);
    }

    // Update displays
    if (isMonitoring) {
      if (statusElement) {
        statusElement.textContent = label;
      }
    }
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
