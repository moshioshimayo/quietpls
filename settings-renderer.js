// Settings window renderer — quietpls v2.0
// Dependencies loaded via <script> tags: SettingsLogic, SettingsHistoryLogic
// Access via SL.xxx and SHL.xxx to avoid redeclaration with script-loaded globals
const SL = window.SettingsLogic || {};
const SHL = window.SettingsHistoryLogic || {};
const defaultThresholds = {
  quietThreshold: 30,
  normalThreshold: 50,
  warningThreshold: 78,
};

// ============================================================
// State
// ============================================================

let config = {
  quietThreshold: defaultThresholds.quietThreshold,
  normalThreshold: defaultThresholds.normalThreshold,
  warningThreshold: defaultThresholds.warningThreshold,
};

let selectedDeviceId = "";
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
  setupThresholdHandlers();
  setupDeviceHandlers();
  setupGeneralHandlers();
  setupFooterHandlers();
  setupSessionHandlers();
  enumerateAudioDevices();
  loadCalibrationStatus();

  // Device change listener
  if (
    navigator.mediaDevices &&
    navigator.mediaDevices.ondevicechange !== undefined
  ) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      enumerateAudioDevices();
    });
  }

  // Volume updates from main window
  window.electronAPI.onVolumeUpdate((volume) => {
    updateCurrentLevel(volume);
    updateLevelIndicator(volume);
    updateMicTestFromMainVolume(volume);
  });

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
      config = { ...config, ...settings };
      if (settings.audioDeviceId !== undefined) {
        selectedDeviceId = settings.audioDeviceId || "";
        const deviceSelect = document.getElementById("audioDeviceSelect");
        if (deviceSelect) deviceSelect.value = selectedDeviceId;
      }
      updateUI();
    }
  });
}

function saveSettings() {
  window.electronAPI.updateSettings({
    ...config,
    audioDeviceId: selectedDeviceId,
  });
}

function saveGeneralSettings() {
  if (window.electronAPI.updateGeneralSettings) {
    window.electronAPI.updateGeneralSettings(generalSettings);
  }
}

// ============================================================
// Threshold Handlers
// ============================================================

function setupThresholdHandlers() {
  const quietSlider = document.getElementById("quietThreshold");
  const normalSlider = document.getElementById("normalThreshold");
  const warningSlider = document.getElementById("warningThreshold");

  const quietMinus = document.getElementById("quietMinus");
  const quietPlus = document.getElementById("quietPlus");
  const normalMinus = document.getElementById("normalMinus");
  const normalPlus = document.getElementById("normalPlus");
  const warningMinus = document.getElementById("warningMinus");
  const warningPlus = document.getElementById("warningPlus");

  // Quiet
  quietSlider.addEventListener("input", (e) => {
    updateQuietThreshold(parseInt(e.target.value));
  });
  quietMinus.addEventListener("click", () => {
    updateQuietThreshold(config.quietThreshold - 1);
  });
  quietPlus.addEventListener("click", () => {
    updateQuietThreshold(config.quietThreshold + 1);
  });

  // Normal
  normalSlider.addEventListener("input", (e) => {
    updateNormalThreshold(parseInt(e.target.value));
  });
  normalMinus.addEventListener("click", () => {
    updateNormalThreshold(config.normalThreshold - 1);
  });
  normalPlus.addEventListener("click", () => {
    updateNormalThreshold(config.normalThreshold + 1);
  });

  // Warning
  warningSlider.addEventListener("input", (e) => {
    updateWarningThreshold(parseInt(e.target.value));
  });
  warningMinus.addEventListener("click", () => {
    updateWarningThreshold(config.warningThreshold - 1);
  });
  warningPlus.addEventListener("click", () => {
    updateWarningThreshold(config.warningThreshold + 1);
  });
}

function updateQuietThreshold(value) {
  value = SL.clampThreshold(value, 1, config.normalThreshold - 1);
  config.quietThreshold = value;
  document.getElementById("quietValue").textContent = value;
  document.getElementById("quietThreshold").value = value;
  updateZoneBand();
  saveSettings();
}

function updateNormalThreshold(value) {
  value = SL.clampThreshold(
    value,
    config.quietThreshold + 1,
    config.warningThreshold - 1,
  );
  config.normalThreshold = value;
  document.getElementById("normalValue").textContent = value;
  document.getElementById("normalThreshold").value = value;
  updateZoneBand();
  saveSettings();
}

function updateWarningThreshold(value) {
  value = SL.clampThreshold(value, config.normalThreshold + 1, 100);
  config.warningThreshold = value;
  document.getElementById("warningValue").textContent = value;
  document.getElementById("warningThreshold").value = value;
  updateZoneBand();
  saveSettings();
}

// ============================================================
// Audio Device Handlers
// ============================================================

function setupDeviceHandlers() {
  const deviceSelect = document.getElementById("audioDeviceSelect");
  if (deviceSelect) {
    deviceSelect.addEventListener("change", (e) => {
      selectedDeviceId = e.target.value;
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

    select.innerHTML = '<option value="">System Default</option>';

    for (const device of audioInputs) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label;
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
  } catch (error) {
    console.error("Failed to enumerate audio devices:", error);
  }
}

// ============================================================
// Mic Test — lightweight getUserMedia + AnalyserNode preview
// ============================================================

async function startMicTest() {
  const btn = document.getElementById("testMicBtn");
  const fill = document.getElementById("micTestFill");
  const label = document.getElementById("micTestLabel");

  try {
    const constraints = {
      audio: selectedDeviceId
        ? { deviceId: { exact: selectedDeviceId } }
        : true,
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

      fill.style.width = pct + "%";
      label.textContent = pct + "%";

      // Color based on zone
      fill.className = "mic-test-fill";
      const zone = SL.getZoneForVolume(pct, config);
      if (zone === "normal") fill.classList.add("level-normal");
      else if (zone === "loud") fill.classList.add("level-loud");
      else if (zone === "danger") fill.classList.add("level-danger");

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
// Calibration Status (US-018)
// ============================================================

async function loadCalibrationStatus() {
  var statusEl = document.getElementById("calibrationStatus");
  var recalibrateBtn = document.getElementById("recalibrateBtn");
  if (!statusEl) return;

  try {
    // Get current audio device ID (or 'default')
    var deviceId = selectedDeviceId || "default";
    var data = await window.electronAPI.getCalibration(deviceId);
    if (data && data.calibratedAt) {
      var date = new Date(data.calibratedAt);
      statusEl.textContent = "Calibrated on " + date.toLocaleDateString();
    } else {
      statusEl.textContent = "Not calibrated";
    }
  } catch (err) {
    statusEl.textContent = "Not calibrated";
  }

  if (recalibrateBtn) {
    recalibrateBtn.addEventListener("click", function () {
      var deviceId = selectedDeviceId || "default";
      window.electronAPI.clearCalibration(deviceId);
      statusEl.textContent = "Not calibrated";
    });
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
      config.quietThreshold = defaultThresholds.quietThreshold;
      config.normalThreshold = defaultThresholds.normalThreshold;
      config.warningThreshold = defaultThresholds.warningThreshold;
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
  const quietSlider = document.getElementById("quietThreshold");
  const normalSlider = document.getElementById("normalThreshold");
  const warningSlider = document.getElementById("warningThreshold");
  const quietValue = document.getElementById("quietValue");
  const normalValue = document.getElementById("normalValue");
  const warningValue = document.getElementById("warningValue");

  if (quietSlider) quietSlider.value = config.quietThreshold;
  if (normalSlider) normalSlider.value = config.normalThreshold;
  if (warningSlider) warningSlider.value = config.warningThreshold;
  if (quietValue) quietValue.textContent = config.quietThreshold;
  if (normalValue) normalValue.textContent = config.normalThreshold;
  if (warningValue) warningValue.textContent = config.warningThreshold;

  updateZoneBand();
}

function updateZoneBand() {
  const q = config.quietThreshold;
  const n = config.normalThreshold;
  const w = config.warningThreshold;

  const zoneQuiet = document.getElementById("zoneQuiet");
  const zoneNormal = document.getElementById("zoneNormal");
  const zoneLoud = document.getElementById("zoneLoud");
  const zoneDanger = document.getElementById("zoneDanger");

  if (zoneQuiet) zoneQuiet.style.flex = q;
  if (zoneNormal) zoneNormal.style.flex = n - q;
  if (zoneLoud) zoneLoud.style.flex = w - n;
  if (zoneDanger) zoneDanger.style.flex = 100 - w;
}

function updateLevelIndicator(volume) {
  const marker = document.getElementById("levelMarker");
  if (marker) {
    const pct = Math.max(0, Math.min(100, volume));
    marker.style.left = pct + "%";
  }
}

function updateCurrentLevel(volume) {
  const levelElement = document.getElementById("currentLevel");
  if (levelElement) {
    levelElement.textContent = Math.round(volume) + "%";
  }
}

function updateMicTestFromMainVolume(volume) {
  // When not doing a standalone mic test, update the mic test meter from main volume
  if (isMicTesting) return;
  const fill = document.getElementById("micTestFill");
  const label = document.getElementById("micTestLabel");
  if (!fill || !label) return;

  const pct = Math.max(0, Math.min(100, Math.round(volume)));
  fill.style.width = pct + "%";
  label.textContent = pct + "%";

  fill.className = "mic-test-fill";
  const zone = SL.getZoneForVolume(pct, config);
  if (zone === "normal") fill.classList.add("level-normal");
  else if (zone === "loud") fill.classList.add("level-loud");
  else if (zone === "danger") fill.classList.add("level-danger");
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
  const grade = SHL.computeGrade(session.zoneTime);
  const zonePct = SHL.computeZonePercentages(session.zoneTime);

  const card = document.createElement("div");
  card.className = "session-card glass-panel";
  card.dataset.sessionId = session.id;

  card.innerHTML = `
    <div class="session-card-main" data-action="view">
      <div class="session-card-left">
        <span class="session-date">${SHL.formatDate(session.startTime)}</span>
        <span class="session-time">${SHL.formatTime(session.startTime)}</span>
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

  const grade = SHL.computeGrade(session.zoneTime);
  const zonePct = SHL.computeZonePercentages(session.zoneTime);

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
    <div class="detail-section">
      <span class="detail-label">Zone Breakdown</span>
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
      </div>
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
