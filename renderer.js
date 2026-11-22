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
  const hours = Math.floor(durationSec / 3600);
  const minutes = Math.round((durationSec % 3600) / 60);
  if (hours > 0) {
    return hours + "h " + minutes + "m";
  }
  return minutes + "m";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { formatDuration };
}

if (typeof window !== "undefined") {
  const LL = window.LevelLogic;

  // Calibration needs this many seconds of talking (calibration-manager.js).
  const CALIBRATION_SECONDS = 10;
  // Rehearsal timeouts and the success panel use wall time (spec AC-17).
  const REHEARSAL_STEP_MS = 15000;
  const REHEARSAL_NORMAL_MS = 1000;
  const SUCCESS_COLLAPSE_MS = 3000;
  const RENDER_INTERVAL_MS = 100;

  // Pill mark and colour family per zone (spec "State table"). Marks are
  // glyphs so the state never depends on colour alone.
  const PILL = {
    idle: { mark: "○", cls: "zone-off", off: true },
    starting: { mark: "…", cls: "zone-off", off: true },
    uncalibrated: { mark: "○", cls: "zone-off", off: true },
    calibrating: { mark: "●", cls: "zone-off", off: true },
    reconnecting: { mark: "?", cls: "zone-off", uncertain: true },
    unavailable: { mark: "?", cls: "zone-off", uncertain: true },
    silent: { mark: "·", cls: "zone-quiet" },
    normal: { mark: "✓", cls: "zone-normal" },
    warning: { mark: "~", cls: "zone-loud" },
    danger: { mark: "!", cls: "zone-danger" },
  };
  const IDLE = { zone: "idle", label: "Start monitoring", relDb: null, level: 0 };

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
    });
    $("calPrimaryBtn").addEventListener("click", () => beginCalibration()); // Try again
    $("calSecondaryBtn").addEventListener("click", () => {
      if (calib === "louder" || calib === "back") finishRehearsal(); // Skip
      else if (calib === "done") collapseAfterCalibration(); // Done
      else finalizeAndShowSessionComplete(); // Stop
    });
    $("sessionCloseBtn").addEventListener("click", () =>
      window.electronAPI.widgetTransition("compact"),
    );
    document.addEventListener("keydown", (e) => {
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
          await showDetails();
          await startMonitoring();
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
    compactPill.style.display = expanded || complete ? "none" : "";
    expandedPanel.style.display = expanded ? "" : "none";
    sessionCompletePanel.style.display = complete ? "" : "none";
    if (!expanded) userOpened = false;
    // The success panel is shown once; the next open shows details.
    if (!expanded && calib === "done") setCalib(null);
    if (expanded) {
      const focus = calib ? $("calSecondaryBtn") : $("hideBtn");
      focus.focus({ preventScroll: true });
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
    forceCalibration = !!(options && options.recalibrate);
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
      beginCalibration();
    }
  }

  // Explicit "Set normal voice again" (details, context menu or Settings).
  async function recalibrate() {
    console.log("[calibration] Recalibration requested");
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
      beginCalibration();
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
    reportCaptureStatus();
    tracker = newTracker(calibration.baselineDb, false);
    rehearsal = { since: Date.now(), normalMs: 0, timedOut: false };
    setCalib("louder");
  }

  function advanceRehearsal(decision, msg) {
    const elapsed = Date.now() - rehearsal.since;
    if (calib === "louder") {
      const louder =
        decision.heldZone === "warning" || decision.heldZone === "danger";
      if (louder || elapsed >= REHEARSAL_STEP_MS) {
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
  function finishRehearsal() {
    rehearsal = null;
    startMonitoringSegment();
    setCalib("done");
    scheduleAutoCollapse(SUCCESS_COLLAPSE_MS);
  }

  async function collapseAfterCalibration() {
    if (_autoCollapseTimer) clearTimeout(_autoCollapseTimer);
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

  function pillWord(decision) {
    if (decision.zone === "calibrating" && calibrationManager) {
      return (
        "Set normal voice " +
        Math.round(calibrationManager.getProgress() * 100) +
        "%"
      );
    }
    if (
      decision.zone === "unavailable" &&
      captureStatus &&
      captureStatus.reason === "permission"
    ) {
      return "Mic access denied";
    }
    return decision.label;
  }

  function amountText(decision) {
    switch (decision.zone) {
      case "unavailable":
        return "No reading while the mic is unavailable";
      case "reconnecting":
        return "No reading while the mic reconnects";
      case "silent":
        return "Listening — say something";
      case "uncalibrated":
        return "Set your normal voice to start";
    }
    if (typeof decision.relDb !== "number") return "";
    return Math.round(decision.relDb) < 1
      ? "At your normal"
      : LL.formatRelative(decision.relDb);
  }

  function micText() {
    const s = captureStatus;
    if (!s || !s.device) return { label: "—", note: "" };
    const notes = {
      "avoid-bluetooth": "Headset mic skipped — keeps call audio clear",
      explicit: "Chosen in Settings",
    };
    return {
      label: s.device.label || "Unnamed mic",
      note:
        s.reason === "fallback"
          ? "Chosen mic unavailable — using this one"
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
      " dB for this session — your setup looks different from when you set it"
    );
  }

  function render(decision) {
    const word = pillWord(decision);
    const p = PILL[decision.zone] || PILL.idle;
    const zoneCls = [p.cls, p.off ? "is-off" : "", p.uncertain ? "is-uncertain" : ""];

    compactPill.className = [
      "qp-pill",
      ...zoneCls,
      isMonitoring ? "monitoring" : "",
    ].join(" ").trim();
    compactPill.setAttribute("aria-label", "quietpls: " + word + ". Show details");
    $("pillMark").textContent = p.mark;
    $("pillWord").textContent = word;
    if (word !== lastAnnounced && !/%$/.test(word)) {
      lastAnnounced = word;
      $("liveRegion").textContent = word;
    }

    // Details
    expandedPanel.className = ["qp-panel", ...zoneCls].join(" ").trim();
    $("detailsMark").textContent = p.mark;
    $("zoneLabel").textContent = word;
    $("dbReadout").textContent = amountText(decision);
    const lost = !!p.uncertain;
    $("relBar").hidden = lost;
    $("relFill").style.width = (decision.level || 0) + "%";
    $("relBarTrack").setAttribute(
      "aria-label",
      typeof decision.relDb === "number"
        ? LL.formatRelative(decision.relDb) || "At your normal"
        : "No level",
    );
    const mic = micText();
    $("micLabel").textContent = mic.label;
    $("micNote").textContent = mic.note;
    $("micNote").hidden = !mic.note;
    const re = reanchorText();
    $("reanchorLine").textContent = re;
    $("reanchorLine").hidden = !re;
    $("retryBtn").hidden = decision.zone !== "unavailable";
    $("recalibrateBtn").hidden =
      decision.zone === "unavailable" || !isMonitoring;
    $("stopBtn").hidden = !isMonitoring;

    if (calib) renderCalibration(decision, word, p);
  }

  function renderTicks() {
    const m = LL.marginsFor(config.sensitivity);
    const at = (db) => LL.relativeLevel(db) + "%";
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
    if (lastDecision) render(lastDecision);
    else if (phase) renderCalibration(IDLE, "", PILL.idle);
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
    if (calib === "talk") {
      const progress = calibrationManager ? calibrationManager.getProgress() : 0;
      const heard = Math.floor(progress * CALIBRATION_SECONDS);
      t.step = "Step 1 of 2 · Set your normal voice";
      t.title = "Talk the way you usually do on a call";
      t.progress = progress;
      t.text =
        heard + " of " + CALIBRATION_SECONDS + " seconds of talking heard · Mic: " + micLabel;
      t.secondary = "Stop";
    } else if (calib === "failed") {
      const r = calibFail || {};
      const heard = Math.floor((r.speechMs || 0) / 1000);
      t.title =
        r.status === "clipping" ? "The mic is overloading" : "Didn't hear enough talking";
      t.text =
        r.status === "clipping"
          ? "Move back a little or lower the input gain, then try again. Nothing was saved."
          : "quietpls needs about " +
            CALIBRATION_SECONDS +
            " seconds of talking within 40 seconds; it heard " +
            heard +
            ". Nothing was saved.";
      t.primary = "Try again";
      t.secondary = "Stop";
    } else if (calib === "louder" || calib === "back") {
      t.step = "Step 2 of 2 · Quick check";
      t.title =
        calib === "louder"
          ? "Now say one sentence a bit louder"
          : rehearsal && rehearsal.timedOut
            ? "That's fine — you can try again later. Now your normal voice"
            : "Good — that read as Getting loud. Now back to your normal voice";
      t.live = true;
      t.note = "Your normal is already saved.";
      t.secondary = "Skip";
    } else if (calib === "done") {
      t.mark = true;
      t.title = "This is your normal";
      t.text =
        "Saved for " +
        micLabel +
        ". quietpls shows Getting loud and Ease your voice compared with this.";
      t.note = "Closes in 3 s";
      t.secondary = "Done";
    }
    $("calStep").textContent = t.step;
    $("calStep").hidden = !t.step;
    $("calMark").hidden = !t.mark;
    $("calTitle").textContent = t.title;
    $("calProgress").hidden = t.progress === false;
    $("calProgressFill").style.width = (t.progress || 0) * 100 + "%";
    $("calProgress").setAttribute(
      "aria-valuenow",
      String(Math.floor((t.progress || 0) * CALIBRATION_SECONDS)),
    );
    $("calText").textContent = t.text;
    $("calText").hidden = !t.text;
    $("calLive").hidden = !t.live;
    if (t.live) {
      const live = $("calLivePill");
      live.className = ["qp-pill", p.cls, p.off ? "is-off" : "", p.uncertain ? "is-uncertain" : ""]
        .join(" ")
        .trim();
      $("calLiveMark").textContent = p.mark;
      $("calLiveWord").textContent = word;
    }
    $("calNote").textContent = t.note;
    $("calPrimaryBtn").textContent = t.primary;
    $("calPrimaryBtn").hidden = !t.primary;
    $("calSecondaryBtn").textContent = t.secondary;
    $("calSecondaryBtn").hidden = !t.secondary;
    $("calSecondaryBtn").classList.toggle("primary", calib === "done");
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
    tracker = null;
    rehearsal = null;
    lastDecision = null;
    setCalib(null);
    reportCaptureStatus();
    render(IDLE);
    console.log("Monitoring stopped");
  }

  // ---- Session Complete Flow (US-014) ----

  function populateSessionInsights(insights, durationSec) {
    $("sessionDuration").textContent = formatDuration(durationSec);
    const listEl = $("insightList");
    listEl.innerHTML = "";
    for (const text of insights) {
      const li = document.createElement("li");
      li.className = "session-complete__insight-item";
      li.textContent = text;
      listEl.appendChild(li);
    }
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
    populateSessionInsights(
      window.SessionInsights.generateInsights(sessionData),
      sessionData.duration,
    );
    const result = await window.electronAPI.widgetTransition("sessionComplete");
    if (result && !result.success) {
      console.error("[session] Widget transition to sessionComplete failed:", result.error);
      sessionCompletePanel.style.display = "";
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
