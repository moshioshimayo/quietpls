const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  dialog,
  Menu,
  shell,
  Tray,
  nativeImage,
  systemPreferences,
} = require("electron");
const path = require("path");
const Store = require("electron-store");
const { autoUpdater } = require("electron-updater");
const { defaultSettings, SETTINGS_STORE } = require("./config");

// E2E runs use a throwaway profile so tests never touch real user data.
if (process.env.QUIETPLS_E2E_TEST === "1" && process.env.QUIETPLS_USER_DATA) {
  app.setPath("userData", process.env.QUIETPLS_USER_DATA);
}
const { createWidgetStateMachine, STATES } = require("./widget-state-machine");
const { createMeetingDetector } = require("./meeting-detector");
const { createInputTransports } = require("./input-transports");
// Capture (beta): opt-in call capture, off by default (README.md, "Capture (beta)").
const { createCaptureMode } = require("./capture/mode");

// CoreAudio transport types of the audio inputs (Bluetooth detection).
// E2E runs (unpackaged only) never read the real Mac's devices: tests set
// globalThis.__quietplsFakeTransports, otherwise transports are unknown.
const E2E_FAKES = process.env.QUIETPLS_E2E_TEST === "1" && !app.isPackaged;
// On by default; off in E2E so parallel test instances don't see each other's
// mic use as a call (a test can still enable it in the settings file).
const MEETING_DETECTION_DEFAULT = !E2E_FAKES;
const inputTransports = E2E_FAKES
  ? { get: async () => globalThis.__quietplsFakeTransports || null }
  : createInputTransports();

const BLUETOOTH_ONLY_NOTE = {
  type: "info",
  buttons: ["OK"],
  message: "Using Your Bluetooth Mic",
  detail:
    "No other mic is available. Headset audio may sound less clear while monitoring. A wired or USB mic can avoid this.",
};

// Calibration data store, keyed by the real captured device id.
const calibrationStore = new Store({
  name: "quietpls-calibrations",
  defaults: { calibrations: {} },
});
const { CALIBRATION_VERSION } = require("./calibration-manager");

// Older baselines do not meet the current calibration rules; each mic is
// calibrated once again. Keep current records across subsequent launches.
function discardLegacyCalibrations() {
  const all = calibrationStore.get("calibrations") || {};
  const kept = {};
  for (const [key, value] of Object.entries(all)) {
    if (value && value.version === CALIBRATION_VERSION) kept[key] = value;
  }
  if (Object.keys(kept).length !== Object.keys(all).length) {
    calibrationStore.set("calibrations", kept);
  }
}
discardLegacyCalibrations();

function clampSensitivity(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(4, Math.max(-4, n));
}
const { createWidgetAnimator, STATE_BOUNDS, WIDGET_INSETS } = require("./widget-animator");
const { registerSessionIpc } = require("./session-ipc");
const PermissionManager = require("./permission-manager");
let trayIconRenderer;
try {
  trayIconRenderer = require("./tray-icon-renderer");
} catch (err) {
  console.warn(
    "[main] Dynamic tray icon renderer unavailable, using static icons:",
    err.message,
  );
  trayIconRenderer = null;
}

const permissionManager = new PermissionManager();

// Widget state machine — single source of truth for widget UI state
const widgetStateMachine = createWidgetStateMachine(STATES.COMPACT);

// Forward every state-machine transition to all renderer windows via IPC
widgetStateMachine.onTransition((payload) => {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send("widget-state-changed", payload);
    }
  }
});

// App state store (for onboarding completion, etc.)
const appStateStore = new Store({
  name: "quietpls-app-state",
  defaults: {
    onboardingComplete: false,
  },
});

// Local settings store — single source of truth for thresholds (cloud sync removed)
const settingsStore = new Store({
  name: SETTINGS_STORE,
  defaults: {
    sensitivity: defaultSettings.sensitivity,
    audioDeviceId: null,
  },
});

let mainWindow;
let widgetAnimator = null;
let onboardingWindow;
let settingsWindow;
let tray = null;
let meetingDetector = null;
let captureMode = null;
let isMonitoring = false;
let monitoringStartTime = null;
let currentSettings = { ...defaultSettings };
// Latest capture status from the widget (actual mic, calibration), for Settings.
let lastCaptureStatus = { state: "idle" };

// General settings store (launch at login, menubar, notification sounds)
const generalSettingsStore = new Store({
  name: "quietpls-general-settings",
  defaults: {
    launchAtLogin: false,
    showInMenubar: true,
  },
});

// Tray icon variants (pre-loaded on tray creation)
let trayIcons = {};
let currentTrayIconState = "inactive";
let lastTrayIconUpdate = 0;
const TRAY_ICON_THROTTLE_MS = 100; // max ~10 updates/second

function createWindow() {
  // Get the primary display's work area
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const area = screen.getPrimaryDisplay().workArea;
  const savedPosition = appStateStore.get("pillPosition");

  // Floating pill window — sized to match compact state bounds
  const { width: windowWidth, height: windowHeight } =
    STATE_BOUNDS[STATES.COMPACT];

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: savedPosition ? savedPosition.x : area.x + width - windowWidth + WIDGET_INSETS.right - 22,
    y: savedPosition ? savedPosition.y : area.y + 8 - WIDGET_INSETS.top,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Load the index.html file
  mainWindow.loadFile("index.html");

  // Push persisted settings to the renderer once it is ready
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.send("settings-updated", currentSettings);
  });

  // Forward renderer console logs to main process stdout for debugging
  mainWindow.webContents.on(
    "console-message",
    (event, level, message, line, sourceId) => {
      const prefix =
        ["[renderer LOG]", "[renderer WARN]", "[renderer ERROR]"][level] ||
        "[renderer]";
      console.log(`${prefix} ${message} (${sourceId}:${line})`);
    },
  );

  // Set window level to floating
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true);
  mainWindow.setFullScreenable(false);

  // Prevent window from being hidden on minimize
  mainWindow.on("minimize", (event) => {
    event.preventDefault();
  });

  // Check if onboarding is needed
  checkOnboarding();
}

function checkOnboarding() {
  // Show onboarding on first launch (tracked via electron-store)
  const onboardingComplete = appStateStore.get("onboardingComplete");

  if (!onboardingComplete) {
    createOnboardingWindow();
  }
}

function broadcastMicrophoneStatus() {
  const status = permissionManager.getStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("microphone-status-changed", status);
  }
}

function resizeContentWindow(win, event, width, height) {
  if (!win || win.isDestroyed() || event.sender !== win.webContents ||
      !Number.isFinite(height)) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const area = display.workArea;
  const frameHeight = win.getBounds().height - win.getContentBounds().height;
  win.setContentSize(width, Math.round(Math.max(200, Math.min(height, area.height - frameHeight))));
  const bounds = win.getBounds();
  win.setPosition(
    Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
    Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)),
  );
}

function createOnboardingWindow(query) {
  if (onboardingWindow) {
    onboardingWindow.focus();
    return;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  onboardingWindow = new BrowserWindow({
    width: 580,
    useContentSize: true,
    titleBarStyle: "hiddenInset",
    height: 500,
    x: Math.round((width - 580) / 2),
    y: Math.round((height - 500) / 2),
    frame: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    title: "Welcome to quietpls",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload-onboarding.js"),
    },
  });

  onboardingWindow.loadFile("onboarding.html", query ? { query } : undefined);

  onboardingWindow.webContents.on(
    "console-message",
    (event, level, message, line, sourceId) => {
      const prefix =
        ["[onboarding LOG]", "[onboarding WARN]", "[onboarding ERROR]"][
          level
        ] || "[onboarding]";
      console.log(`${prefix} ${message} (${sourceId}:${line})`);
    },
  );

  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
  });
}

function createSettingsWindow(tab = "monitoring") {
  if (settingsWindow) {
    settingsWindow.webContents.send("select-settings-tab", tab);
    settingsWindow.setTitle(tab === "history" ? "History" : "Monitoring");
    settingsWindow.focus();
    return;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  settingsWindow = new BrowserWindow({
    width: 540,
    useContentSize: true,
    titleBarStyle: "hiddenInset",
    height: 680,
    x: Math.round((width - 540) / 2),
    y: Math.round((height - 680) / 2),
    frame: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    title: "Monitoring",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload-settings.js"),
    },
  });

  settingsWindow.loadFile("settings.html");

  settingsWindow.webContents.on(
    "console-message",
    (event, level, message, line, sourceId) => {
      const prefix =
        ["[settings LOG]", "[settings WARN]", "[settings ERROR]"][level] ||
        "[settings]";
      console.log(`${prefix} ${message} (${sourceId}:${line})`);
    },
  );

  // Send current monitoring status
  settingsWindow.webContents.on("did-finish-load", () => {
    settingsWindow.webContents.send("monitoring-status", isMonitoring);
    settingsWindow.webContents.send("select-settings-tab", tab);
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function showAboutDialog() {
  app.setAboutPanelOptions({
    applicationName: "quietpls",
    applicationVersion: app.getVersion(),
    version: "",
    copyright: "Voice-level feedback for calls.",
    website: "https://github.com/moshioshimayo/quietpls",
  });
  app.showAboutPanel();
}

// ---- Auto-update ----

// Update state surfaced in the tray menu (see updater-state.js)
const { createUpdaterState } = require("./updater-state");
const updateStatus = createUpdaterState();
let manualUpdateCheck = false;

// A standard app alert (icon, bold message, detail), never a sheet on the pill
// window. macOS shows no `title`, so the headline goes in `message`.
function showMessage(options) {
  app.focus({ steal: true });
  return dialog.showMessageBox(options);
}

function showUpdateError(error) {
  showMessage({
    type: "warning",
    title: "Couldn’t Check for Updates",
    message: "Try Check for Updates again from the menu bar.",
    buttons: ["OK", "Show Details"], defaultId: 0, cancelId: 0,
  }).then(({ response }) => {
    if (response !== 1) return;
    showMessage({
      type: "info", title: "Update Details", message: "Couldn’t Check for Updates",
      detail: String(error.message || error), buttons: ["OK"],
    });
  });
}

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) {
      showMessage({
        type: "info",
        title: "Updates",
        message: "Install the released app to check for updates.",
        buttons: ["OK"],
      });
    }
    return;
  }
  if (updateStatus.available) return;
  manualUpdateCheck = manual;
  updateStatus.onChecking();
  updateTrayMenu();
  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[Updater] check failed:", err.message);
    updateStatus.onError(); // back to retryable idle
    updateTrayMenu();
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      showUpdateError(err);
    }
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true; // Download in the background once available
  autoUpdater.autoInstallOnAppQuit = true;

  // Check for updates on startup and every hour
  setTimeout(() => checkForUpdates(false), 10 * 1000);
  setInterval(() => checkForUpdates(false), 60 * 60 * 1000);

  autoUpdater.on("checking-for-update", () => {
    console.log("[Updater] checking for updates...");
    updateStatus.onChecking();
    updateTrayMenu();
  });

  autoUpdater.on("update-available", (info) => {
    console.log("[Updater] update available:", info.version);
    updateStatus.onAvailable(info.version);
    updateTrayMenu();
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[Updater] no update available");
    updateStatus.onNotAvailable();
    updateTrayMenu();
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      showMessage({ type: "info", title: "You’re Up to Date", message: "You’re Up to Date",
        detail: `quietpls ${app.getVersion()} is the latest version.`, buttons: ["OK"] });
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("[Updater] error:", err);
    updateStatus.onError();
    updateTrayMenu();
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      showUpdateError(err);
    }
  });

  autoUpdater.on("download-progress", (progressObj) => {
    console.log(`[Updater] downloading: ${progressObj.percent.toFixed(1)}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[Updater] update downloaded:", info.version);
    updateStatus.onDownloaded(info.version);
    updateTrayMenu();
    manualUpdateCheck = false;
    maybePromptUpdate();
  });
}

function maybePromptUpdate() {
  updateStatus.setActive(isMonitoring || !!(captureMode &&
    (captureMode.summary().phase === "recording" || captureMode.summary().ambient)));
  if (!updateStatus.takePrompt()) return;
  showMessage({
    type: "info", title: "Update Ready",
    message: `quietpls ${updateStatus.version} is ready to install.`,
    detail: "Restart to install it. If you choose Later, it installs when quietpls quits.",
    buttons: ["Restart Now", "Later"], defaultId: 0,
  }).then((result) => { if (result.response === 0) autoUpdater.quitAndInstall(); });
}

// ---- System Tray ----

function loadTrayIcons() {
  const iconNames = [
    "trayIconTemplate",
    "trayIcon-silent",
    "trayIcon-quiet",
    "trayIcon-normal",
    "trayIcon-loud",
  ];
  const stateMap = {
    trayIconTemplate: "inactive",
    "trayIcon-silent": "silent",
    "trayIcon-quiet": "quiet",
    "trayIcon-normal": "normal",
    "trayIcon-loud": "loud",
  };

  for (const name of iconNames) {
    const iconPath = path.join(__dirname, "assets", `${name}.png`);
    const icon = nativeImage.createFromPath(iconPath);
    icon.setTemplateImage(true);
    trayIcons[stateMap[name]] = trayIconRenderer?.createTrayIcon(0, stateMap[name]) || icon;
  }
}

function createTray() {
  loadTrayIcons();
  tray = new Tray(trayIcons.inactive);
  tray.setToolTip("quietpls");

  // macOS opens the installed context menu on click. No monitoring action here.

  updateTrayMenu();
}

function toggleMonitoringFromMain() {
  isMonitoring = !isMonitoring;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("toggle-monitoring", isMonitoring);
  }
  if (settingsWindow) {
    settingsWindow.webContents.send("monitoring-status", isMonitoring);
  }
  if (!isMonitoring) {
    resetTrayIcon();
  } else {
    tray.setImage(trayIconRenderer?.createTrayIcon(0, "normal") || trayIcons.normal);
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate(buildMenuTemplate({ isMonitoring }));
  tray.setContextMenu(contextMenu);
  maybePromptUpdate();
}

// Both native menu entry points consume this model.
function buildMenuTemplate(state) {
  return [
    { label: state.isMonitoring ? "Stop Monitoring" : "Start Monitoring", click: toggleMonitoringFromMain },
    { label: "Voice Setup…", click: () => createOnboardingWindow({ step: "check" }) },
    { label: "History", click: () => createSettingsWindow("history") },
    { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => createSettingsWindow("monitoring") },
    ...(captureMode ? captureMode.menuItems() : []),
    { type: "separator" },
    { label: updateStatus.label, enabled: updateStatus.enabled, click: () => {
      if (updateStatus.available) autoUpdater.quitAndInstall();
      else checkForUpdates(true);
    } },
    { label: "About quietpls", click: showAboutDialog },
    { type: "separator" },
    { label: "Quit quietpls", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
  ];
}

/**
 * Draw the tray from the widget's zone decision — the tray never classifies
 * levels itself, so it always agrees with the pill.
 * @param {{ visual: string, level: number }} update
 */
function updateTrayIcon(update) {
  if (!tray || !isMonitoring || !update) return;
  // While capture is asking/recording/transcribing it draws the tray (red dot + time).
  if (captureMode && captureMode.ownsTray()) return;

  // Throttle updates to max ~10/second, but never drop a zone change
  const zone = ["quiet", "normal", "loud", "danger"].includes(update.visual)
    ? update.visual
    : "quiet";
  const now = Date.now();
  if (
    now - lastTrayIconUpdate < TRAY_ICON_THROTTLE_MS &&
    zone === currentTrayIconState
  )
    return;
  lastTrayIconUpdate = now;
  const volume = Math.max(0, Math.min(100, Number(update.level) || 0));

  // Try dynamic icon first
  if (trayIconRenderer) {
    const dynamicIcon = trayIconRenderer.createTrayIcon(volume, zone);
    if (dynamicIcon) {
      tray.setImage(dynamicIcon);
      currentTrayIconState = zone;
      return;
    }
    // Dynamic rendering failed — fall through to static icons
  }

  // Fallback: static icon swapping (only update when state changes)
  // Map zone names to static icon keys
  const zoneToStaticKey = {
    quiet: "silent",
    normal: "quiet",
    loud: "normal",
    danger: "loud",
  };
  const newState = zoneToStaticKey[zone] || "inactive";

  if (newState !== currentTrayIconState) {
    currentTrayIconState = newState;
    tray.setImage(trayIcons[newState]);
  }
}

function resetTrayIcon() {
  if (!tray || (captureMode && captureMode.ownsTray())) return;
  currentTrayIconState = "inactive";
  tray.setImage(trayIcons.inactive);
  if (trayIconRenderer) {
    trayIconRenderer.resetVolumeHistory();
  }
}

// App pages never navigate away or open windows. The few links the app shows
// open in the default browser; anything else is dropped.
const EXTERNAL_LINKS = new Set(["https://github.com/moshioshimayo/quietpls/issues"]);
function openExternalLink(url) {
  if (EXTERNAL_LINKS.has(url)) shell.openExternal(url);
  else console.warn("[navigation] blocked", url);
}
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => {
    if (event.url === contents.getURL()) return;
    event.preventDefault();
    openExternalLink(event.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: "deny" };
  });
});

app.whenReady().then(async () => {
  // Load locally persisted settings (single source of truth)
  currentSettings = {
    sensitivity: clampSensitivity(settingsStore.get("sensitivity")),
    audioDeviceId: settingsStore.get("audioDeviceId") || "",
  };
  // 2.0 score thresholds have no meaning on the dB scale.
  for (const key of ["quietThreshold", "normalThreshold", "warningThreshold"]) {
    if (settingsStore.has(key)) settingsStore.delete(key);
  }

  // Register permission IPC handlers (get-microphone-status, microphone-track-ended)
  permissionManager.registerIPC(() => mainWindow);

  // Onboarding: request microphone access from renderer (US-019)
  ipcMain.handle("request-microphone-access", async () => {
    const status = await permissionManager.request();
    broadcastMicrophoneStatus();
    return status;
  });

  // Checking access never opens the macOS permission prompt.
  app.on("browser-window-focus", broadcastMicrophoneStatus);

  ipcMain.on("setup-resize", (event, height) => {
    resizeContentWindow(onboardingWindow, event, 580, height);
  });
  ipcMain.on("settings-resize", (event, height, tab) => {
    if (height && typeof height === "object") {
      tab = height.tab;
      height = height.height;
    }
    resizeContentWindow(settingsWindow, event, 540, height);
    if (settingsWindow && event.sender === settingsWindow.webContents) {
      settingsWindow.setTitle(tab === "history" ? "History" : "Monitoring");
    }
  });

  // Onboarding: open System Settings for mic permission (US-019)
  ipcMain.on("open-system-settings", () => {
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );
  });

  // Register session storage IPC (US-012)
  registerSessionIpc();

  // IPC handlers that need app to be ready
  ipcMain.handle("get-app-version", () => {
    return app.getVersion();
  });

  // General settings IPC (US-017)
  ipcMain.handle("get-general-settings", () => {
    return {
      launchAtLogin: generalSettingsStore.get("launchAtLogin"),
      showInMenubar: generalSettingsStore.get("showInMenubar"),
    };
  });

  ipcMain.on("update-general-settings", (event, settings) => {
    if (settings.launchAtLogin !== undefined) {
      generalSettingsStore.set("launchAtLogin", settings.launchAtLogin);
      app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
    }
    if (settings.showInMenubar !== undefined) {
      generalSettingsStore.set("showInMenubar", settings.showInMenubar);
    }
  });

  // Sanitize device IDs to prevent electron-store path injection
  function safeDeviceId(id) {
    return String(id || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  // Calibration IPC handlers (US-008)
  ipcMain.handle("get-calibration", (event, deviceId) => {
    return (
      calibrationStore.get("calibrations." + safeDeviceId(deviceId)) || null
    );
  });

  ipcMain.on("save-calibration", (event, { deviceId, data }) => {
    calibrationStore.set("calibrations." + safeDeviceId(deviceId), data);
  });

  ipcMain.on("clear-calibration", (event, { deviceId }) => {
    calibrationStore.delete("calibrations." + safeDeviceId(deviceId));
  });

  // Meeting detection (US-016)
  // A call = another app using the mic; quietpls's own processes don't count.
  meetingDetector = createMeetingDetector({
    pollIntervalMs: 3000,
    graceMs: 30000,
    timeoutMs: 3000,
    getOwnPids: () => [
      ...app.getAppMetrics().map((m) => m.pid),
      // The capture helper is quietpls's own mic user, never a call.
      ...(captureMode ? captureMode.helperPids() : []),
    ],
    ...(app.isPackaged && {
      helperPath: path.join(process.resourcesPath, "mic-users"),
    }),
  });

  const meetingDetectionEnabled = generalSettingsStore
    ? generalSettingsStore.get("meetingDetection", MEETING_DETECTION_DEFAULT)
    : false;
  if (meetingDetectionEnabled) meetingDetector.start();

  meetingDetector.onDetectionChange(function (data) {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send("meeting-detection-changed", data);
      }
    }
  });

  // The widget asks once its listener is in place, so a call already running
  // at launch (detected before the window loaded) still starts monitoring.
  ipcMain.handle("get-meeting-detection", function () {
    return {
      detected: meetingDetector.isDetected(),
      apps: meetingDetector.getDetectedApps(),
    };
  });

  ipcMain.handle("get-meeting-detection-enabled", function () {
    return generalSettingsStore
      ? generalSettingsStore.get("meetingDetection", MEETING_DETECTION_DEFAULT)
      : false;
  });

  ipcMain.on("set-meeting-detection-enabled", function (event, { enabled }) {
    if (generalSettingsStore)
      generalSettingsStore.set("meetingDetection", enabled);
    if (enabled) meetingDetector.start();
    else meetingDetector.stop();
  });

  createWindow();

  // Wire up widget animator — smoothly resizes window on state transitions (US-005)
  widgetAnimator = createWidgetAnimator(mainWindow, { getWorkArea: (bounds) => screen.getDisplayMatching(bounds).workArea });
  widgetAnimator.connectStateMachine(widgetStateMachine);

  // Create system tray
  createTray();

  // Capture (beta). Does nothing until the user turns it on in Settings.
  captureMode = createCaptureMode({
    app,
    binDir: app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, "bin"),
    getTray: () => tray,
    onTrayReleased: resetTrayIcon,
    // Capture's phase, call prompts or always-on changed: the menu and Settings' Capture row.
    onMenuChanged: () => {
      updateTrayMenu();
      if (settingsWindow && !settingsWindow.isDestroyed() && captureMode)
        settingsWindow.webContents.send("capture:summary-changed", captureMode.summary());
    },
    deps:
      E2E_FAKES && process.env.QUIETPLS_CAPTURE_FAKES === "1"
        ? require("./capture/e2e-fakes")
        : {},
  });
  captureMode.start();
  updateTrayMenu();

  // Initialize auto-updater
  setupAutoUpdater();

  if (E2E_FAKES) {
    globalThis.__quietplsE2E = {
      popUpTrayMenu: () => tray.popUpContextMenu(),
      showAbout: showAboutDialog,
      checkForUpdates: ({ result } = {}) => {
        manualUpdateCheck = true;
        if (result === "none") autoUpdater.emit("update-not-available");
        else if (result === "error") autoUpdater.emit("error", new Error("Check your connection, then try again."));
        else checkForUpdates(true);
      },
      updateDownloaded: (version) => autoUpdater.emit("update-downloaded", { version }),
    };
  }

  // Register global keyboard shortcuts
  // Cmd+Shift+M to toggle monitoring
  globalShortcut.register("CommandOrControl+Shift+M", () => {
    toggleMonitoringFromMain();
  });

  // Cmd+Shift+S to open settings (as in 2.4.3). Never a global Cmd+, : that is every
  // other app's Settings shortcut; ⌘, stays the quietpls menu's accelerator.
  globalShortcut.register("CommandOrControl+Shift+S", () => {
    createSettingsWindow();
  });

  // Cmd+Shift+O to show onboarding
  globalShortcut.register("CommandOrControl+Shift+O", () => {
    createOnboardingWindow();
  });

  // Handle IPC messages
  ipcMain.on("request-monitoring-status", (event) => {
    event.reply("monitoring-status", isMonitoring);
  });

  ipcMain.on("set-monitoring", (event, status) => {
    const previousStatus = isMonitoring;
    isMonitoring = status;

    if (status && !previousStatus) {
      // Started monitoring
      monitoringStartTime = Date.now();
    } else if (!status && previousStatus && monitoringStartTime) {
      // Stopped monitoring
      monitoringStartTime = null;
    }

    if (!status) {
      resetTrayIcon();
    }

    if (settingsWindow) {
      settingsWindow.webContents.send("monitoring-status", isMonitoring);
    }
    updateTrayMenu();
  });

  // Onboarding completion
  ipcMain.on("onboarding-complete", (event, data) => {
    if (onboardingWindow) {
      onboardingWindow.close();
    }

    // Save that onboarding is complete
    appStateStore.set("onboardingComplete", true);

    if (data.startMonitoring) {
      isMonitoring = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("toggle-monitoring", true);
      }
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send("monitoring-status", isMonitoring);
      }
    }
    updateTrayMenu();
  });

  // Settings window requests
  ipcMain.on("open-settings", (event, tab) => {
    createSettingsWindow(tab);
  });

  ipcMain.on("close-settings", () => {
    if (settingsWindow) {
      settingsWindow.close();
    }
  });

  ipcMain.on("request-settings", (event) => {
    event.reply("settings-data", currentSettings);
  });

  ipcMain.on("update-settings", async (event, settings) => {
    // Validate and sanitize renderer-supplied settings
    if (!settings || typeof settings !== "object") return;
    // Only the fields this window sent change, so no window writes a stale value back.
    const sanitized = {
      sensitivity: "sensitivity" in settings
        ? clampSensitivity(settings.sensitivity)
        : currentSettings.sensitivity,
      audioDeviceId: "audioDeviceId" in settings
        ? (typeof settings.audioDeviceId === "string" ? settings.audioDeviceId : "")
        : currentSettings.audioDeviceId,
    };
    currentSettings = sanitized;

    // Persist locally
    settingsStore.set("sensitivity", sanitized.sensitivity);
    settingsStore.set("audioDeviceId", sanitized.audioDeviceId || null);

    // Send to main window
    mainWindow.webContents.send("settings-updated", sanitized);
  });

  // Onboarding window requests
  ipcMain.on("show-onboarding", () => {
    createOnboardingWindow();
  });

  // About dialog
  ipcMain.on("show-about", () => {
    showAboutDialog();
  });

  // Volume updates from main window to settings
  // The widget's zone decision drives the tray and the Settings meter.
  ipcMain.on("level-update", (event, update) => {
    if (!update || typeof update !== "object") return;
    if (settingsWindow) {
      settingsWindow.webContents.send("level-update", update);
    }
    updateTrayIcon(update);
  });

  ipcMain.handle("get-input-transports", () => inputTransports.get());

  ipcMain.on("capture-status", (event, status) => {
    if (!status || typeof status !== "object") return;
    lastCaptureStatus = status;
    // One-time note when only a Bluetooth mic is available.
    if (
      status.state === "running" &&
      status.policy === "bluetooth-only" &&
      !appStateStore.get("bluetoothOnlyNoteShown")
    ) {
      appStateStore.set("bluetoothOnlyNoteShown", true);
      if (E2E_FAKES) {
        globalThis.__quietplsNotes = (globalThis.__quietplsNotes || []).concat(
          BLUETOOTH_ONLY_NOTE.message,
        );
      } else {
        dialog.showMessageBox(BLUETOOTH_ONLY_NOTE).catch(() => {});
      }
    }
    if (settingsWindow) {
      settingsWindow.webContents.send("capture-status", status);
    }
  });

  ipcMain.handle("get-capture-status", () => lastCaptureStatus);

  // Settings "Recalibrate": same live operation as the context-menu item.
  ipcMain.on("request-recalibration", (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("trigger-recalibration", {
        setup: event.sender.getURL().includes("onboarding.html"),
      });
    }
  });

  // ---- Widget State Machine IPC ----
  ipcMain.handle("widget-get-state", () => {
    return widgetStateMachine.getState();
  });

  ipcMain.handle("widget-transition", (event, targetState, context) => {
    if (typeof targetState !== "string") {
      return { success: false, error: "targetState must be a string" };
    }
    if (
      context !== undefined &&
      context !== null &&
      typeof context !== "object"
    ) {
      return { success: false, error: "context must be an object or null" };
    }
    try {
      const payload = widgetStateMachine.transition(targetState, context || {});
      return { success: true, payload: payload };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.on("widget-resize", (event, height) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !Number.isFinite(height)) return;
    widgetAnimator.setContentHeight(height);
  });
  ipcMain.on("widget-reduce-motion", (event, reduced) => {
    if (mainWindow && event.sender === mainWindow.webContents) widgetAnimator.setReducedMotion(!!reduced);
  });
  ipcMain.on("show-input-menu", async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const devices = await mainWindow.webContents.executeJavaScript(
      "navigator.mediaDevices.enumerateDevices().then(ds => ds.filter(d => d.kind === 'audioinput').map(d => ({deviceId:d.deviceId,label:d.label})))");
    Menu.buildFromTemplate(devices.filter(d => !["default", "communications"].includes(d.deviceId)).map(d => ({
      label: d.label || "Unnamed mic", type: "radio", checked: d.deviceId === currentSettings.audioDeviceId,
      click: () => {
        currentSettings.audioDeviceId = d.deviceId;
        settingsStore.set("audioDeviceId", d.deviceId);
        mainWindow.webContents.send("settings-updated", currentSettings);
        settingsWindow?.webContents.send("settings-updated", currentSettings);
      },
    }))).popup({window:mainWindow});
  });

  // ---- Screen / Window Position IPC (US-006 snap-to-position) ----
  ipcMain.handle("get-screen-dimensions", () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    return { width, height };
  });

  ipcMain.handle("get-window-position", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0 };
    const [x, y] = mainWindow.getPosition();
    return { x, y };
  });

  ipcMain.handle("get-window-bounds", () => {
    if (!mainWindow || mainWindow.isDestroyed())
      return { x: 0, y: 0, ...STATE_BOUNDS[STATES.COMPACT] };
    return mainWindow.getBounds();
  });

  ipcMain.handle("set-window-position", (event, x, y) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      return;
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const clampedX = Math.max(-200, Math.min(Math.round(x), width + 200));
    const clampedY = Math.max(-200, Math.min(Math.round(y), height + 200));
    mainWindow.setPosition(clampedX, clampedY);
    const bounds = mainWindow.getBounds();
    appStateStore.set("pillPosition", {
      x: clampedX + bounds.width - STATE_BOUNDS[STATES.COMPACT].width,
      y: clampedY,
    });
  });

  // Native context menu
  ipcMain.on("show-context-menu", (event, menuData) => {
    const menu = Menu.buildFromTemplate(buildMenuTemplate({ isMonitoring }));
    menu.popup({
      window: mainWindow,
      x: menuData.x,
      y: menuData.y,
    });
  });
});

app.on("will-quit", () => {
  // Clean up meeting detector (US-016)
  if (meetingDetector) {
    meetingDetector.destroy();
  }

  // Unregister all shortcuts
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    // Re-attach widget animator to the new window
    if (widgetAnimator) {
      widgetAnimator.destroy();
    }
    widgetAnimator = createWidgetAnimator(mainWindow, { getWorkArea: (bounds) => screen.getDisplayMatching(bounds).workArea });
    widgetAnimator.connectStateMachine(widgetStateMachine);
  }
});
