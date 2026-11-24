// Settings window renderer
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
let activeTab = "monitoring";
let lastCaptureStatus = null;
let idleMicGeneration = 0;
let microphoneStatus = null;
let micTestGeneration = 0;
let detailSession = null;
let deleteInvoker = null;
let detailInvoker = null;
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
  document.title = "Monitoring";
  loadSettings();
  setupSensitivityHandlers();
  setupDeviceHandlers();
  setupGeneralHandlers();
  setupFooterHandlers();
  setupSessionHandlers();
  setupCalibrationHandlers();
  enumerateAudioDevices();
  setupMicrophonePermission();
  window.electronAPI.onSelectSettingsTab?.(switchTab);
  resizeSettingsWindow();
  window.addEventListener("settings-content-changed", resizeSettingsWindow);
  window.addEventListener("beforeunload", stopMicTest);
  window.addEventListener("focus", () => {
    refreshMicrophonePermission();
    if (activeTab === "history" && !detailSession) loadSessionHistory();
  });

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
    updateLevelIndicator(update);
    updateMicTestFromMainLevel(update);
  });

  window.electronAPI.onMonitoringStatus((monitoring) => {
    const status = monitoring ? "Monitoring on" : "Monitoring off";
    document.getElementById("liveLevelText").textContent = status;
    announceMonitoringState(status);
    if (!monitoring) document.getElementById("levelMarker").hidden = true;
  });

  // Actual captured mic + its calibration
  window.electronAPI.getCaptureStatus().then(renderCaptureStatus);
  window.electronAPI.onCaptureStatus(renderCaptureStatus);

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
      refreshIdleMicrophone();
    }
  });
  window.electronAPI.requestSettings();
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
  return s > 0 ? s + " dB lower" : -s + " dB higher";
}

// ============================================================
// Audio Device Handlers
// ============================================================

function setupDeviceHandlers() {
  const deviceSelect = document.getElementById("audioDeviceSelect");
  if (deviceSelect) {
    deviceSelect.addEventListener("change", (e) => {
      stopMicTest();
      selectedDeviceId = e.target.value;
      updateBluetoothNote();
      refreshIdleMicrophone();
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
      '<option value="">Automatic (prefers non-Bluetooth)</option>';

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
        "Previously selected audio device no longer available, falling back to Automatic",
      );
      selectedDeviceId = "";
      select.value = "";
      saveSettings();
    }
    updateBluetoothNote();
    refreshIdleMicrophone();
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
    : !(capturedBluetooth || bluetoothDeviceIds.size > 0);
  resizeSettingsWindow();
}

// ============================================================
// Mic Test — lightweight getUserMedia + AnalyserNode preview
// ============================================================

async function startMicTest() {
  const btn = document.getElementById("testMicBtn");
  const fill = document.getElementById("micTestFill");
  const label = document.getElementById("micTestLabel");

  const generation = ++micTestGeneration;
  btn.disabled = true;
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
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (generation !== micTestGeneration || activeTab !== "monitoring") {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    micTestStream = stream;
    micTestAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = micTestAudioCtx.createMediaStreamSource(micTestStream);
    micTestAnalyser = micTestAudioCtx.createAnalyser();
    micTestAnalyser.fftSize = 256;
    micTestAnalyser.smoothingTimeConstant = 0.5;
    source.connect(micTestAnalyser);

    isMicTesting = true;
    btn.classList.add("active");
    btn.textContent = "Stop test";

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
      const signal = pct > 2 ? "Signal" : "No signal";
      if (label.textContent !== signal) label.textContent = signal;
      fill.className = "level-normal";

      micTestAnimFrame = requestAnimationFrame(drawLevel);
    }

    drawLevel();
  } catch (err) {
    console.error("Mic test failed:", err);
    if (generation === micTestGeneration) {
      stopMicTest();
      if (label) label.textContent = "Mic unavailable";
    }
  } finally {
    if (generation === micTestGeneration) btn.disabled = false;
  }
}

function stopMicTest() {
  micTestGeneration++;
  isMicTesting = false;
  const btn = document.getElementById("testMicBtn");
  const fill = document.getElementById("micTestFill");
  const label = document.getElementById("micTestLabel");

  if (btn) {
    btn.classList.remove("active");
    btn.textContent = "Test mic";
    btn.disabled = false;
  }
  if (fill) fill.style.width = "0";
  if (label) label.textContent = "—";

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
    // The same guided voice setup used by the pill.
    btn.addEventListener("click", () => {
      stopMicTest();
      window.electronAPI.requestRecalibration();
      const statusEl = document.getElementById("calibrationStatus");
      if (statusEl) statusEl.textContent = "Use your normal call voice for about 10 seconds…";
    });
  }
}

/**
 * Show which mic is really being captured and whether it is calibrated.
 * @param {object} s — capture status reported by the widget
 */
function renderCaptureStatus(s) {
  lastCaptureStatus = s;
  idleMicGeneration++;
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
    refreshIdleMicrophone();
  } else if (status.state === "unavailable") {
    statusEl.textContent =
      status.reason === "permission" ? "Microphone access is off" : "Mic unavailable";
  } else if (status.state !== "running") {
    statusEl.textContent = "Reconnecting to mic…";
  } else if (status.calibrating) {
    statusEl.textContent = "Learning your normal voice…";
  } else if (status.calibration) {
    const when = new Date(status.calibration.calibratedAt);
    statusEl.textContent = "Normal voice saved " +
      (isNaN(when.getTime()) ? "" : when.toLocaleDateString());
  } else {
    statusEl.textContent = "Normal voice not set";
  }
}

// Read the selected mic's saved normal without opening its audio stream.
async function refreshIdleMicrophone() {
  if (lastCaptureStatus && lastCaptureStatus.state !== "idle") return;
  const generation = ++idleMicGeneration;
  try {
    const choice = await MP.resolveChoice(navigator.mediaDevices, getInputTransports, selectedDeviceId);
    const record = choice.deviceId ? await window.electronAPI.getCalibration(choice.deviceId) : null;
    if (generation !== idleMicGeneration) return;
    document.getElementById("calibrationDevice").textContent = choice.label || "Unnamed mic";
    const when = record ? new Date(record.calibratedAt) : null;
    document.getElementById("calibrationStatus").textContent = record
      ? "Normal voice saved " + (isNaN(when.getTime()) ? "" : when.toLocaleDateString())
      : "Normal voice not set";
  } catch (error) { console.error("Could not read saved normal voice:", error); }
}

// ============================================================
// Footer Handlers
// ============================================================

function setupFooterHandlers() {
  document.getElementById("resetDefaults").addEventListener("click", () => {
    config.sensitivity = 0;
    updateUI();
    // This action only changes sensitivity; the microphone and general settings stay intact.
    saveSettings();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && ["1", "2"].includes(event.key)) {
      event.preventDefault();
      switchTab(event.key === "1" ? "monitoring" : "history");
      document.getElementById(event.key === "1" ? "monitoringTab" : "historyTab").focus();
    } else if (event.key === "Escape") {
      if (document.getElementById("deleteConfirmModal").open) return;
      if (detailSession) { closeSessionModal(); event.preventDefault(); }
      else { stopMicTest(); window.electronAPI.closeSettings(); }
    }
  });
}

function resizeSettingsWindow() {
  // Measure the selected pane rather than the current window (which can shrink).
  requestAnimationFrame(() => {
    const pane = document.getElementById("tab-" + activeTab);
    const confirm = document.getElementById("deleteConfirmModal");
    const height = Math.max(pane.offsetHeight, confirm.open ? Math.max(confirm.offsetHeight, confirm.scrollHeight + 2) : 0);
    window.electronAPI.resizeSettings?.(Math.ceil(height + 48 + 14), activeTab);
  });
}

async function refreshMicrophonePermission() {
  if (!window.electronAPI.getMicrophoneStatus) return;
  try { renderMicrophonePermission(await window.electronAPI.getMicrophoneStatus()); }
  catch (error) { console.error("Could not check microphone access:", error); }
}

function renderMicrophonePermission(status) {
  const wasBlocked = ["denied", "restricted"].includes(microphoneStatus);
  microphoneStatus = status;
  const blocked = ["denied", "restricted"].includes(status);
  document.getElementById("microphoneGroups").hidden = blocked;
  document.getElementById("microphoneDenied").hidden = !blocked;
  document.getElementById("microphonePermissionHelp").textContent = status === "restricted"
    ? "Your organization manages microphone access. Contact your administrator."
    : "Turn on quietpls in System Settings → Privacy & Security → Microphone.";
  if (blocked) stopMicTest();
  else if (wasBlocked) {
    enumerateAudioDevices();
    window.electronAPI.getCaptureStatus().then(renderCaptureStatus);
  }
  resizeSettingsWindow();
}

function setupMicrophonePermission() {
  document.getElementById("openMicrophoneSettings").addEventListener("click", () => window.electronAPI.openMicrophoneSettings());
  document.getElementById("checkMicrophoneAccess").addEventListener("click", refreshMicrophonePermission);
  window.electronAPI.onMicrophoneStatusChanged?.(renderMicrophonePermission);
  refreshMicrophonePermission();
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
      "Getting loud: +" +
      m.warningDb +
      " dB. Ease your voice: +" +
      m.dangerDb +
      " dB above normal.";
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
  announceMonitoringState(update?.label || "Monitoring off");
  if (marker) {
    marker.hidden = !speaking;
    if (speaking) marker.style.left = bandPercent(update.relDb) + "%";
  }
  if (text) {
    text.textContent = speaking
      ? LL.formatRelative(update.relDb) + " · " + update.label
      : (update && update.label) || "Monitoring off";
  }
}

function announceMonitoringState(label) {
  const announcement = document.getElementById("monitoringAnnouncement");
  if (announcement.textContent !== label) announcement.textContent = label;
}

function updateMicTestFromMainLevel(update) {
  // When not doing a standalone mic test, mirror the widget's live level
  if (isMicTesting) return;
  const fill = document.getElementById("micTestFill");
  const label = document.getElementById("micTestLabel");
  if (!fill || !label || !update) return;

  const pct = Math.max(0, Math.min(100, Math.round(update.level || 0)));
  fill.style.width = pct + "%";
  label.textContent = update.label || "—";
  fill.className = "";
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
    tab.addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const name = event.key === "Home" ? "monitoring" : event.key === "End" ? "history" : activeTab === "history" ? "monitoring" : "history";
        switchTab(name);
        document.querySelector(`[data-tab="${name}"]`).focus();
      }
    });
  });
}

function switchTab(tabName) {
  if (!["monitoring", "history"].includes(tabName)) return;
  activeTab = tabName;
  if (tabName === "history") stopMicTest();
  document.querySelectorAll(".tab-btn").forEach((button) => {
    const selected = button.dataset.tab === tabName;
    button.classList.toggle("on", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll(".tab-content").forEach((pane) => { pane.hidden = pane.id !== "tab-" + tabName; });
  document.title = tabName === "history" ? "History" : "Monitoring";
  if (tabName === "history") loadSessionHistory();
  resizeSettingsWindow();
}

function setupSessionHandlers() {
  document.getElementById("sessionModalClose").addEventListener("click", closeSessionModal);
  document.getElementById("retryHistory").addEventListener("click", loadSessionHistory);
  document.getElementById("detailDeleteBtn").addEventListener("click", () => showDeleteConfirm(detailSession.id));
  document.getElementById("deleteCancelBtn").addEventListener("click", closeDeleteModal);
  document.getElementById("deleteConfirmBtn").addEventListener("click", confirmDeleteSession);
  document.getElementById("deleteConfirmModal").addEventListener("cancel", (event) => { event.preventDefault(); closeDeleteModal(); });
}

function showHistoryState(state) {
  document.getElementById("historyContents").hidden = state !== "ready";
  document.getElementById("sessionEmpty").hidden = state !== "empty";
  document.getElementById("historyError").hidden = state !== "error";
  document.getElementById("historyLoading").hidden = state !== "loading";
  resizeSettingsWindow();
}

async function loadSessionHistory() {
  try {
    if (!sessionsLoaded) showHistoryState("loading");
    const [sessionsResult, statsResult] = await Promise.all([
      window.electronAPI.getSessions({ limit: 50 }),
      window.electronAPI.getSessionStats(),
    ]);
    if (!sessionsResult?.success || !statsResult?.success) throw new Error("History unavailable");
    sessionsLoaded = true;
    renderStats(statsResult.data);
    renderSessionList(sessionsResult.data);
    if (detailSession) document.getElementById("historyContents").hidden = true;
  } catch (error) {
    console.error("Could not load session history:", error);
    sessionsLoaded = false;
    if (!detailSession) showHistoryState("error");
  }
}

function glyph(symbol, kind) {
  return `<svg class="g ${kind || ""}" aria-hidden="true"><use href="#${symbol}"/></svg>`;
}

function splitBar(percentages, legacy = false) {
  const p = percentages;
  return `<div class="split" role="img" aria-label="Normal ${p.normal}%, Getting loud ${p.loud}%, Ease your voice ${p.danger}%">${legacy ? `<i class="quiet" style="width:${p.quiet}%"></i>` : ""}<i class="normal" style="width:${p.normal}%"></i><i class="rising" style="width:${p.loud}%"></i><i class="loud" style="width:${p.danger}%"></i></div>`;
}

function legend(percentages) {
  const p = percentages;
  return `<span>${glyph("g-ok", "normal")}Normal ${p.normal}%</span><span>${glyph("g-rise", "rising")}Getting loud ${p.loud}%</span><span>${glyph("g-loud", "loud")}Ease your voice ${p.danger}%</span>`;
}

function renderStats(stats) {
  document.getElementById("historyTotals").textContent = `${stats.totalSessions || 0} sessions · ${SHL.formatTotalMinutes(stats.totalMinutes || 0)} monitored`;
  const percentages = SHL.computeSessionZonePercentages({ algorithmVersion: 4, zoneTime: stats.zoneTime, speakingTime: stats.speakingTime });
  document.getElementById("overviewBar").innerHTML = splitBar(percentages);
  document.getElementById("overviewLegend").innerHTML = legend(percentages);
}

function renderSessionList(sessions) {
  const list = document.getElementById("sessionList");
  list.replaceChildren();
  for (const session of sessions || []) list.appendChild(createSessionCard(session));
  showHistoryState(sessions?.length ? "ready" : "empty");
}

function createSessionCard(session) {
  const percentages = SHL.computeSessionZonePercentages(session);
  const legacy = SHL.isLegacySession(session);
  const card = document.createElement("div");
  card.className = "session-card" + (legacy ? " legacy" : "");
  card.dataset.sessionId = session.id;
  const view = document.createElement("button");
  view.className = "session-card-main";
  view.dataset.action = "view";
  view.innerHTML = `<span class="session-date">${SHL.formatDate(session.startTime)} ${SHL.formatTime(session.startTime)}</span><span class="num sub">${SHL.formatDuration(session.duration)}</span>${legacy ? '<span class="small" title="Uses scoring from before version 2.1; compare with other sessions from that version">Before 2.1</span>' : splitBar(percentages) + `<span class="small num">Normal ${percentages.normal}%</span>`}`;
  view.addEventListener("click", () => showSessionDetail(session));
  const remove = document.createElement("button");
  remove.className = "session-delete-btn";
  remove.dataset.action = "delete";
  remove.setAttribute("aria-label", "Delete session");
  remove.title = "Delete session";
  remove.innerHTML = glyph("g-trash");
  remove.addEventListener("click", () => showDeleteConfirm(session.id));
  card.append(view, remove);
  return card;
}

function showSessionDetail(session) {
  detailInvoker = document.activeElement;
  detailSession = session;
  const body = document.getElementById("sessionModalBody");
  const percentages = SHL.computeSessionZonePercentages(session);
  const legacy = SHL.isLegacySession(session);
  body.replaceChildren();
  const header = document.createElement("div");
  header.className = "detail-title";
  header.innerHTML = `<h3 class="rd">${SHL.formatDate(session.startTime)}</h3><span class="num sub">${SHL.formatDuration(session.duration)} monitored</span>`;
  const summary = document.createElement("div");
  summary.className = "form detail-summary";
  if (legacy) {
    summary.innerHTML = `<p class="small">Voice levels · before 2.1 scoring</p>${splitBar(percentages, true)}<p>Quiet ${percentages.quiet}% · Normal ${percentages.normal}% · Loud ${percentages.loud}% · High ${percentages.danger}%</p>`;
  } else {
    summary.innerHTML = splitBar(percentages);
    for (const insight of window.SessionInsights.generateInsights(session)) {
      const line = document.createElement("p");
      line.textContent = insight;
      summary.appendChild(line);
    }
    const talking = document.createElement("p");
    talking.className = "small";
    talking.textContent = `Detected talking · ${SHL.formatDuration(session.speakingTime || 0)}`;
    summary.appendChild(talking);
  }
  body.append(header, summary);
  for (const [label, value] of [["Date", SHL.formatDate(session.startTime)], ["Time", SHL.formatTime(session.startTime) + (session.endTime ? " – " + SHL.formatTime(session.endTime) : "")], ["Monitored time", SHL.formatDuration(session.duration)]]) {
    const row = document.createElement("div");
    row.className = "detail-row";
    row.innerHTML = `<span class="detail-label">${label}</span><span class="num">${value}</span>`;
    body.appendChild(row);
  }
  showHistoryState("detail");
  document.getElementById("sessionModal").hidden = false;
  document.getElementById("sessionModalClose").focus();
  resizeSettingsWindow();
}

function closeSessionModal() {
  detailSession = null;
  document.getElementById("sessionModal").hidden = true;
  showHistoryState(document.querySelector(".session-card") ? "ready" : "empty");
  if (detailInvoker?.isConnected) detailInvoker.focus();
  else document.getElementById("historyTab").focus();
}

function showDeleteConfirm(sessionId) {
  pendingDeleteId = sessionId;
  deleteInvoker = document.activeElement;
  document.getElementById("deleteError").hidden = true;
  document.getElementById("deleteConfirmModal").showModal();
  document.getElementById("deleteCancelBtn").focus();
  resizeSettingsWindow();
}

function closeDeleteModal() {
  pendingDeleteId = null;
  document.getElementById("deleteConfirmModal").close();
  if (deleteInvoker?.isConnected) deleteInvoker.focus();
  resizeSettingsWindow();
}

async function confirmDeleteSession() {
  if (!pendingDeleteId) return;
  const button = document.getElementById("deleteConfirmBtn");
  button.disabled = true;
  try {
    const result = await window.electronAPI.deleteSession(pendingDeleteId);
    if (!result?.success || !result.deleted) throw new Error("Session was not deleted");
    if (detailSession?.id === pendingDeleteId) closeSessionModal();
    closeDeleteModal();
    sessionsLoaded = false;
    await loadSessionHistory();
    document.getElementById("historyTab").focus();
  } catch (error) {
    console.error("Could not delete session:", error);
    document.getElementById("deleteError").hidden = false;
  } finally {
    button.disabled = false;
  }
}
