// Settings window renderer — quietpls 2.1
// Dependencies loaded via <script> tags: LevelLogic, SettingsLogic, SettingsHistoryLogic
// Access via LL / SL / SHL to avoid redeclaration with script-loaded globals
const LL = window.LevelLogic || {};
const SL = window.SettingsLogic || {};
const SHL = window.SettingsHistoryLogic || {};
const MP = window.MicPolicy || {};

// ============================================================
// State
// ============================================================

let config = {
  sensitivity: 0,
};

let selectedDeviceId = "";
let bluetoothDeviceIds = new Set(); // inputs CoreAudio reports as Bluetooth
let capturedBluetooth = false; // the widget is capturing from a Bluetooth mic
let generalSettings = {
  launchAtLogin: false,
  showInMenubar: true,
};

// Tab state
let activeTab = "thresholds";
let sessionsLoaded = false;
let pendingDeleteId = null;

// Mic test state
let micTestStream = null;
let micTestAudioCtx = null;
let micTestAnalyser = null;
let micTestAnimFrame = null;
let isMicTesting = false;

// ============================================================
// Initialisation
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  setupTabNavigation();
  loadSettings();
  setupSensitivityHandlers();
  setupDeviceHandlers();
  setupGeneralHandlers();
  setupFooterHandlers();
  setupSessionHandlers();
  setupCalibrationHandlers();
  enumerateAudioDevices();

  // Device change listener
  if (
    navigator.mediaDevices &&
    navigator.mediaDevices.ondevicechange !== undefined
  ) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      enumerateAudioDevices();
    });
  }

  // Live zone decisions from the widget (the same ones the pill shows)
  window.electronAPI.onLevelUpdate((update) => {
    updateCurrentLevel(update);
    updateLevelIndicator(update);
    updateMicTestFromMainLevel(update);
  });

  // Actual captured mic + its calibration
  window.electronAPI.getCaptureStatus().then(renderCaptureStatus);
  window.electronAPI.onCaptureStatus(renderCaptureStatus);

  // Monitoring status
  window.electronAPI.onMonitoringStatus((isMonitoring) => {
    const statusEl = document.getElementById("settingsStatus");
    if (statusEl) {
      statusEl.textContent = isMonitoring ? "Active" : "Inactive";
      statusEl.className = "status-label" + (isMonitoring ? " active" : "");
    }
  });

  // Load general settings from main process
  if (window.electronAPI.getGeneralSettings) {
    window.electronAPI.getGeneralSettings().then((settings) => {
      if (settings) {
        generalSettings = { ...generalSettings, ...settings };
        updateGeneralUI();
      }
    });
  }
});

// ============================================================
// Settings Load / Save
// ============================================================

function loadSettings() {
  window.electronAPI.requestSettings();
  window.electronAPI.onSettingsData((settings) => {
    if (settings) {
      config.sensitivity = LL.clampSensitivity(settings.sensitivity);
      if (settings.audioDeviceId !== undefined) {
        selectedDeviceId = settings.audioDeviceId || "";
        const deviceSelect = document.getElementById("audioDeviceSelect");
        if (deviceSelect) deviceSelect.value = selectedDeviceId;
        updateBluetoothNote();
      }
      updateUI();
    }
  });
}

function saveSettings() {
  window.electronAPI.updateSettings({
    sensitivity: config.sensitivity,
    audioDeviceId: selectedDeviceId,
  });
}

function saveGeneralSettings() {
  if (window.electronAPI.updateGeneralSettings) {
    window.electronAPI.updateGeneralSettings(generalSettings);
  }
}

// ============================================================
// Sensitivity
// ============================================================

function setupSensitivityHandlers() {
  const slider = document.getElementById("sensitivity");
  if (!slider) return;
  slider.addEventListener("input", (e) => {
    config.sensitivity = LL.clampSensitivity(e.target.value);
    updateUI();
    saveSettings();
  });
}

function describeSensitivity(s) {
  if (s === 0) return "Default";
  return s > 0 ? s + " dB sooner" : -s + " dB later";
}

// ============================================================
// Audio Device Handlers
// ============================================================

function setupDeviceHandlers() {
  const deviceSelect = document.getElementById("audioDeviceSelect");
  if (deviceSelect) {
    deviceSelect.addEventListener("change", (e) => {
      selectedDeviceId = e.target.value;
      updateBluetoothNote();
      saveSettings();
    });
  }

  const testMicBtn = document.getElementById("testMicBtn");
  if (testMicBtn) {
    testMicBtn.addEventListener("click", () => {
      if (isMicTesting) {
        stopMicTest();
      } else {
        startMicTest();
      }
    });
  }
}

async function enumerateAudioDevices() {
  const select = document.getElementById("audioDeviceSelect");
  if (!select) return;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = SL.filterAudioInputDevices(devices);
    const transports = await getInputTransports();
    bluetoothDeviceIds = new Set(
      MP.classifyInputs(devices, transports)
        .filter((d) => d.bluetooth)
        .map((d) => d.deviceId),
    );

    select.innerHTML =
      '<option value="">System Default (skips Bluetooth mics)</option>';

    for (const device of audioInputs) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent =
        device.label +
        (bluetoothDeviceIds.has(device.deviceId) ? " (Bluetooth)" : "");
      select.appendChild(option);
    }

    if (
      selectedDeviceId &&
      Array.from(select.options).some((o) => o.value === selectedDeviceId)
    ) {
      select.value = selectedDeviceId;
    } else if (selectedDeviceId) {
      console.warn(
        "Previously selected audio device no longer available, falling back to System Default",
      );
      selectedDeviceId = "";
      select.value = "";
      saveSettings();
    }
    updateBluetoothNote();
  } catch (error) {
    console.error("Failed to enumerate audio devices:", error);
  }
}

async function getInputTransports() {
  try {
    return window.electronAPI.getInputTransports
      ? await window.electronAPI.getInputTransports()
      : null;
  } catch (_) {
    return null;
  }
}

/** "Using a Bluetooth mic…" under the picker when the chosen (or, on System
 * Default, the actually captured) mic is Bluetooth. */
function updateBluetoothNote() {
  const note = document.getElementById("bluetoothMicNote");
  if (!note) return;
  note.hidden = selectedDeviceId
    ? !bluetoothDeviceIds.has(selectedDeviceId)
    : !capturedBluetooth;
}

// ============================================================
// Mic Test — lightweight getUserMedia + AnalyserNode preview
// ============================================================

async function startMicTest() {
  const btn = document.getElementById("testMicBtn");
  const fill = document.getElementById("micTestFill");
  const label = document.getElementById("micTestLabel");

  try {
    // Same mic choice as monitoring: never open a Bluetooth default.
    const choice = await MP.resolveChoice(
      navigator.mediaDevices,
      getInputTransports,
      selectedDeviceId,
    );
    const constraints = {
      audio: choice.deviceId ? MP.audioConstraints(choice) : true,
    };
    micTestStream = await navigator.mediaDevices.getUserMedia(constraints);
    micTestAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = micTestAudioCtx.createMediaStreamSource(micTestStream);
    micTestAnalyser = micTestAudioCtx.createAnalyser();
    micTestAnalyser.fftSize = 256;
    micTestAnalyser.smoothingTimeConstant = 0.5;
    source.connect(micTestAnalyser);

    isMicTesting = true;
    btn.classList.add("active");
    btn.textContent = "Stop";

    const dataArray = new Uint8Array(micTestAnalyser.frequencyBinCount);

    function drawLevel() {
      if (!isMicTesting) return;
      micTestAnalyser.getByteFrequencyData(dataArray);

      // Calculate RMS-like average
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const pct = Math.min(100, Math.round((rms / 128) * 100));

      // Raw signal check only: not calibrated, so no zone colours.
      fill.style.width = pct + "%";
      label.textContent = pct > 2 ? "Signal" : "No signal";
      fill.className = "mic-test-fill level-normal";

      micTestAnimFrame = requestAnimationFrame(drawLevel);
    }

    drawLevel();
  } catch (err) {
    console.error("Mic test failed:", err);
    if (label) label.textContent = "Error";
  }
}

function stopMicTest() {
  isMicTesting = false;
  const btn = document.getElementById("testMicBtn");
  const fill = document.getElementById("micTestFill");
  const label = document.getElementById("micTestLabel");

  if (btn) {
    btn.classList.remove("active");
    btn.textContent = "Test Mic";
  }
  if (fill) fill.style.width = "0";
  if (label) label.textContent = "--";

  if (micTestAnimFrame) cancelAnimationFrame(micTestAnimFrame);
  if (micTestStream) {
    micTestStream.getTracks().forEach((t) => t.stop());
    micTestStream = null;
  }
  if (micTestAudioCtx) {
    micTestAudioCtx.close().catch(() => {});
    micTestAudioCtx = null;
  }
  micTestAnalyser = null;
}

// ============================================================
// General Settings Handlers
// ============================================================

function setupGeneralHandlers() {
  const launchAtLogin = document.getElementById("launchAtLogin");
  const showInMenubar = document.getElementById("showInMenubar");
  const meetingDetection = document.getElementById("meetingDetection");

  if (launchAtLogin) {
    launchAtLogin.addEventListener("change", (e) => {
      generalSettings.launchAtLogin = e.target.checked;
      saveGeneralSettings();
    });
  }
  if (showInMenubar) {
    showInMenubar.addEventListener("change", (e) => {
      generalSettings.showInMenubar = e.target.checked;
      saveGeneralSettings();
    });
  }
  if (meetingDetection) {
    // Load initial state from main process
    if (window.electronAPI.getMeetingDetectionEnabled) {
      window.electronAPI.getMeetingDetectionEnabled().then(function (enabled) {
        meetingDetection.checked = enabled;
      });
    }
    meetingDetection.addEventListener("change", (e) => {
      if (window.electronAPI.setMeetingDetectionEnabled) {
        window.electronAPI.setMeetingDetectionEnabled(e.target.checked);
      }
    });
  }
}

function updateGeneralUI() {
  const launchAtLogin = document.getElementById("launchAtLogin");
  const showInMenubar = document.getElementById("showInMenubar");

  if (launchAtLogin) launchAtLogin.checked = generalSettings.launchAtLogin;
  if (showInMenubar) showInMenubar.checked = generalSettings.showInMenubar;
}

// ============================================================
// Calibration (per actual mic)
// ============================================================

function setupCalibrationHandlers() {
  const btn = document.getElementById("recalibrateBtn");
  if (btn) {
    // Same live operation as the pill's context-menu "Recalibrate": starts
    // monitoring if needed and asks you to talk normally for ~5 s.
    btn.addEventListener("click", () => {
      window.electronAPI.requestRecalibration();
      const statusEl = document.getElementById("calibrationStatus");
      if (statusEl) statusEl.textContent = "Talk normally for about 5 seconds…";
    });
  }
}

/**
 * Show which mic is really being captured and whether it is calibrated.
 * @param {object} s — capture status reported by the widget
 */
function renderCaptureStatus(s) {
  const deviceEl = document.getElementById("calibrationDevice");
  const statusEl = document.getElementById("calibrationStatus");
  if (!statusEl) return;
  const status = s || { state: "idle" };
  capturedBluetooth = !!(
    status.state !== "idle" &&
    status.device &&
    status.device.bluetooth
  );
  updateBluetoothNote();

  if (deviceEl) {
    let text = status.device ? status.device.label || "Unnamed mic" : "—";
    if (status.fallback) text += " (selected mic unavailable)";
    deviceEl.textContent = text;
  }

  if (status.state === "idle") {
    statusEl.textContent = "Start monitoring to check your mic";
  } else if (status.state === "unavailable") {
    statusEl.textContent =
      status.reason === "permission" ? "Mic access denied" : "Mic unavailable";
  } else if (status.state !== "running") {
    statusEl.textContent = "Reconnecting to mic…";
  } else if (status.calibrating) {
    statusEl.textContent = "Calibrating — talk normally for about 5 seconds";
  } else if (status.calibration) {
    const when = new Date(status.calibration.calibratedAt);
    statusEl.textContent =
      "Calibrated " +
      (isNaN(when.getTime()) ? "" : when.toLocaleDateString() + " ") +
      "(normal ≈ " +
      Math.round(status.calibration.baselineDb) +
      " dBFS)";
  } else {
    statusEl.textContent = "Not calibrated";
  }
}

// ============================================================
// Footer Handlers
// ============================================================

function setupFooterHandlers() {
  const resetBtn = document.getElementById("resetDefaults");
  const closeBtn = document.getElementById("closeSettings");

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      config.sensitivity = 0;
      updateUI();
      saveSettings();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      stopMicTest();
      window.electronAPI.closeSettings();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      stopMicTest();
      window.electronAPI.closeSettings();
    }
  });
}

// ============================================================
// UI Update Functions
// ============================================================

function updateUI() {
  const slider = document.getElementById("sensitivity");
  const valueEl = document.getElementById("sensitivityValue");
  const descEl = document.getElementById("marginsDescription");
  const m = LL.marginsFor(config.sensitivity);

  if (slider) slider.value = config.sensitivity;
  if (valueEl) valueEl.textContent = describeSensitivity(config.sensitivity);
  if (descEl) {
    descEl.textContent =
      "Yellow at +" +
      m.warningDb +
      " dB and red at +" +
      m.dangerDb +
      " dB above your normal voice";
  }
  updateZoneBand();
}

// Live band spans -10..+20 dB relative to the calibrated normal.
const BAND_MIN_DB = -10;
const BAND_MAX_DB = 20;

function bandPercent(relDb) {
  const pct = ((relDb - BAND_MIN_DB) / (BAND_MAX_DB - BAND_MIN_DB)) * 100;
  return Math.max(0, Math.min(100, pct));
}

function updateZoneBand() {
  const m = LL.marginsFor(config.sensitivity);
  const zoneNormal = document.getElementById("zoneNormal");
  const zoneLoud = document.getElementById("zoneLoud");
  const zoneDanger = document.getElementById("zoneDanger");
  if (zoneNormal) zoneNormal.style.flex = m.warningDb - BAND_MIN_DB;
  if (zoneLoud) zoneLoud.style.flex = m.dangerDb - m.warningDb;
  if (zoneDanger) zoneDanger.style.flex = BAND_MAX_DB - m.dangerDb;
}

function updateLevelIndicator(update) {
  const marker = document.getElementById("levelMarker");
  const text = document.getElementById("liveLevelText");
  const speaking = update && typeof update.relDb === "number";
  if (marker) {
    marker.style.opacity = speaking ? "1" : "0.25";
    if (speaking) marker.style.left = bandPercent(update.relDb) + "%";
  }
  if (text) {
    text.textContent = speaking
      ? LL.formatRelative(update.relDb) + " · " + update.label
      : (update && update.label) || "Not monitoring";
  }
}

function updateCurrentLevel(update) {
  const levelElement = document.getElementById("currentLevel");
  if (levelElement) {
    levelElement.textContent = (update && update.label) || "—";
  }
}

function updateMicTestFromMainLevel(update) {
  // When not doing a standalone mic test, mirror the widget's live level
  if (isMicTesting) return;
  const fill = document.getElementById("micTestFill");
  const label = document.getElementById("micTestLabel");
  if (!fill || !label || !update) return;

  const pct = Math.max(0, Math.min(100, Math.round(update.level || 0)));
  fill.style.width = pct + "%";
  label.textContent = update.label || "--";
  fill.className = "mic-test-fill";
  if (update.visual === "normal") fill.classList.add("level-normal");
  else if (update.visual === "loud") fill.classList.add("level-loud");
  else if (update.visual === "danger") fill.classList.add("level-danger");
}

// ============================================================
// Tab Navigation (US-018)
// ============================================================

function setupTabNavigation() {
  const tabs = document.querySelectorAll(".tab-btn");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.tab;
      switchTab(tabName);
    });
  });
}

function switchTab(tabName) {
  activeTab = tabName;

  // Update tab buttons
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });

  // Update tab content
  document.querySelectorAll(".tab-content").forEach((content) => {
    content.classList.toggle("active", content.id === "tab-" + tabName);
  });

  // Load session data on first visit to history tab
  if (tabName === "history" && !sessionsLoaded) {
    loadSessionHistory();
  }
}

// ============================================================
// Session History (US-018)
// ============================================================

function setupSessionHandlers() {
  const modalClose = document.getElementById("sessionModalClose");
  const modalOverlay = document.getElementById("sessionModal");
  const deleteCancelBtn = document.getElementById("deleteCancelBtn");
  const deleteConfirmBtn = document.getElementById("deleteConfirmBtn");
  const deleteOverlay = document.getElementById("deleteConfirmModal");

  if (modalClose) {
    modalClose.addEventListener("click", () => closeSessionModal());
  }
  if (modalOverlay) {
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) closeSessionModal();
    });
  }
  if (deleteCancelBtn) {
    deleteCancelBtn.addEventListener("click", () => closeDeleteModal());
  }
  if (deleteConfirmBtn) {
    deleteConfirmBtn.addEventListener("click", () => confirmDeleteSession());
  }
  if (deleteOverlay) {
    deleteOverlay.addEventListener("click", (e) => {
      if (e.target === deleteOverlay) closeDeleteModal();
    });
  }
}

async function loadSessionHistory() {
  try {
    const [sessionsResult, statsResult] = await Promise.all([
      window.electronAPI.getSessions({ limit: 50 }),
      window.electronAPI.getSessionStats(),
    ]);

    const sessions =
      sessionsResult && sessionsResult.success ? sessionsResult.data : [];
    const stats = statsResult && statsResult.success ? statsResult.data : {};

    sessionsLoaded = true;
    renderStats(stats, sessions);
    renderSessionList(sessions);
  } catch (err) {
    console.error("Failed to load session history:", err);
    sessionsLoaded = false;
  }
}

function renderStats(stats, sessions) {
  const totalEl = document.getElementById("statTotalSessions");
  const minutesEl = document.getElementById("statTotalMinutes");
  const gradeEl = document.getElementById("statAvgGrade");

  if (totalEl) totalEl.textContent = stats.totalSessions || 0;
  if (minutesEl)
    minutesEl.textContent = SHL.formatTotalMinutes(stats.totalMinutes || 0);
  if (gradeEl) {
    const avgGrade = SHL.computeAverageGrade(sessions);
    gradeEl.textContent = avgGrade;
  }
}

function renderSessionList(sessions) {
  const list = document.getElementById("sessionList");
  const empty = document.getElementById("sessionEmpty");
  if (!list) return;

  if (!sessions || sessions.length === 0) {
    if (empty) empty.style.display = "block";
    return;
  }

  if (empty) empty.style.display = "none";

  // Clear existing session cards (keep empty placeholder)
  const existingCards = list.querySelectorAll(".session-card");
  existingCards.forEach((c) => c.remove());

  for (const session of sessions) {
    const card = createSessionCard(session);
    list.appendChild(card);
  }
}

function createSessionCard(session) {
  const grade = SHL.computeSessionGrade(session);
  const zonePct = SHL.computeSessionZonePercentages(session);
  const legacy = SHL.isLegacySession(session);

  const card = document.createElement("div");
  card.className = "session-card glass-panel";
  card.dataset.sessionId = session.id;

  card.innerHTML = `
    <div class="session-card-main" data-action="view">
      <div class="session-card-left">
        <span class="session-date">${SHL.formatDate(session.startTime)}</span>
        <span class="session-time">${SHL.formatTime(session.startTime)}</span>
        ${legacy ? '<span class="session-time" title="Recorded with the old pre-2.1 scoring; not comparable with newer sessions">pre-2.1</span>' : ""}
      </div>
      <div class="session-card-center">
        <span class="session-duration">${SHL.formatDuration(session.duration)}</span>
        <div class="zone-mini-bar">
          <div class="zone-mini-segment zone-quiet" style="width:${zonePct.quiet}%"></div>
          <div class="zone-mini-segment zone-normal" style="width:${zonePct.normal}%"></div>
          <div class="zone-mini-segment zone-loud" style="width:${zonePct.loud}%"></div>
          <div class="zone-mini-segment zone-danger" style="width:${zonePct.danger}%"></div>
        </div>
      </div>
      <div class="session-card-right">
        <span class="session-grade grade-${grade.color}">${grade.letter}</span>
      </div>
    </div>
    <button class="session-delete-btn" data-action="delete" title="Delete session">&times;</button>
  `;

  // Click to view details
  card.querySelector('[data-action="view"]').addEventListener("click", () => {
    showSessionDetail(session);
  });

  // Delete button
  card
    .querySelector('[data-action="delete"]')
    .addEventListener("click", (e) => {
      e.stopPropagation();
      showDeleteConfirm(session.id);
    });

  return card;
}

function showSessionDetail(session) {
  const modal = document.getElementById("sessionModal");
  const body = document.getElementById("sessionModalBody");
  if (!modal || !body) return;

  const grade = SHL.computeSessionGrade(session);
  const zonePct = SHL.computeSessionZonePercentages(session);
  const legacy = SHL.isLegacySession(session);
  const breakdown = legacy
    ? `
      <span class="detail-label">Zone Breakdown (pre-2.1 scoring, not comparable)</span>
      <div class="zone-mini-bar detail-bar">
        <div class="zone-mini-segment zone-quiet" style="width:${zonePct.quiet}%"></div>
        <div class="zone-mini-segment zone-normal" style="width:${zonePct.normal}%"></div>
        <div class="zone-mini-segment zone-loud" style="width:${zonePct.loud}%"></div>
        <div class="zone-mini-segment zone-danger" style="width:${zonePct.danger}%"></div>
      </div>
      <div class="zone-legend">
        <span class="zone-legend-item"><span class="zone-dot-sm zone-quiet"></span>Quiet ${zonePct.quiet}%</span>
        <span class="zone-legend-item"><span class="zone-dot-sm zone-normal"></span>Normal ${zonePct.normal}%</span>
        <span class="zone-legend-item"><span class="zone-dot-sm zone-loud"></span>Loud ${zonePct.loud}%</span>
        <span class="zone-legend-item"><span class="zone-dot-sm zone-danger"></span>Danger ${zonePct.danger}%</span>
      </div>`
    : `
      <span class="detail-label">Speaking time ${SHL.formatDuration(session.speakingTime || 0)}</span>
      <div class="zone-mini-bar detail-bar">
        <div class="zone-mini-segment zone-normal" style="width:${zonePct.normal}%"></div>
        <div class="zone-mini-segment zone-loud" style="width:${zonePct.loud}%"></div>
        <div class="zone-mini-segment zone-danger" style="width:${zonePct.danger}%"></div>
      </div>
      <div class="zone-legend">
        <span class="zone-legend-item"><span class="zone-dot-sm zone-normal"></span>Normal ${zonePct.normal}%</span>
        <span class="zone-legend-item"><span class="zone-dot-sm zone-loud"></span>Getting loud ${zonePct.loud}%</span>
        <span class="zone-legend-item"><span class="zone-dot-sm zone-danger"></span>Too loud ${zonePct.danger}%</span>
      </div>`;

  body.innerHTML = `
    <div class="detail-row">
      <span class="detail-label">Date</span>
      <span class="detail-value">${SHL.formatDate(session.startTime)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Time</span>
      <span class="detail-value">${SHL.formatTime(session.startTime)}${session.endTime ? " - " + SHL.formatTime(session.endTime) : ""}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Duration</span>
      <span class="detail-value">${SHL.formatDuration(session.duration)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Grade</span>
      <span class="detail-value session-grade grade-${grade.color}">${grade.letter}</span>
    </div>
    <div class="detail-section">${breakdown}
    </div>
  `;

  modal.classList.add("visible");
}

function closeSessionModal() {
  const modal = document.getElementById("sessionModal");
  if (modal) modal.classList.remove("visible");
}

function showDeleteConfirm(sessionId) {
  pendingDeleteId = sessionId;
  const modal = document.getElementById("deleteConfirmModal");
  if (modal) modal.classList.add("visible");
}

function closeDeleteModal() {
  pendingDeleteId = null;
  const modal = document.getElementById("deleteConfirmModal");
  if (modal) modal.classList.remove("visible");
}

async function confirmDeleteSession() {
  if (!pendingDeleteId) return;

  try {
    await window.electronAPI.deleteSession(pendingDeleteId);

    // Remove the card from DOM
    const card = document.querySelector(
      `.session-card[data-session-id="${pendingDeleteId}"]`,
    );
    if (card) card.remove();

    // Check if list is now empty
    const remaining = document.querySelectorAll(".session-card");
    if (remaining.length === 0) {
      const empty = document.getElementById("sessionEmpty");
      if (empty) empty.style.display = "block";
    }

    // Refresh stats
    sessionsLoaded = false;
    loadSessionHistory();
  } catch (err) {
    console.error("Failed to delete session:", err);
  }

  closeDeleteModal();
}
