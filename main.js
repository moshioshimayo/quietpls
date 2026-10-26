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

// Calibration data store, keyed by the real captured device id.
const calibrationStore = new Store({
  name: "quietpls-calibrations",
  defaults: { calibrations: {} },
});
const CALIBRATION_VERSION = 2;

// 2.0 calibrations were score-based and keyed by configured id ("default");
// they cannot be converted, so drop them. Each mic is calibrated once again.
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
const { createWidgetAnimator } = require("./widget-animator");
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

  // Create minimal floating pill window — sized to match compact state bounds
  const windowWidth = 72;
  const windowHeight = 28;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: Math.round((width - windowWidth) / 2), // Center horizontally
    y: 60, // Below the notch area
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

function createOnboardingWindow() {
  if (onboardingWindow) {
    onboardingWindow.focus();
    return;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  onboardingWindow = new BrowserWindow({
    width: 400,
    height: 500,
    x: Math.round((width - 400) / 2),
    y: Math.round((height - 500) / 2),
    frame: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: "Welcome to quietpls",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload-onboarding.js"),
    },
  });

  onboardingWindow.loadFile("onboarding.html");

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

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  settingsWindow = new BrowserWindow({
    width: 420,
    height: 680,
    x: Math.round((width - 420) / 2),
    y: Math.round((height - 680) / 2),
    frame: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: "Settings - quietpls",
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
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function showAboutDialog() {
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "About quietpls",
    message: `quietpls v${app.getVersion()}`,
    detail:
      "A floating audio monitor for meetings.\n\nOpen source: https://github.com/moshioshimayo/quietpls",
    buttons: ["OK"],
  });
}

// ---- Auto-update ----

// Update state surfaced in the tray menu (see updater-state.js)
const { createUpdaterState } = require("./updater-state");
const updateStatus = createUpdaterState();

function showMessage(options) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return dialog.showMessageBox(mainWindow, options);
  }
  return dialog.showMessageBox(options);
}

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) {
      showMessage({
        type: "info",
        title: "Updates",
        message: "Update checks run in the packaged app.",
        buttons: ["OK"],
      });
    }
    return;
  }
  updateStatus.onChecking();
  updateTrayMenu();
  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[Updater] check failed:", err.message);
    updateStatus.onError(); // back to retryable idle
    updateTrayMenu();
    if (manual) {
      showMessage({
        type: "warning",
        title: "Update Check",
        message: "Could not check for updates.",
        detail: String(err.message || err),
        buttons: ["OK"],
      });
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
  });

  autoUpdater.on("error", (err) => {
    console.error("[Updater] error:", err);
    updateStatus.onError(); // failed/interrupted check or download -> retryable
    updateTrayMenu();
  });

  autoUpdater.on("download-progress", (progressObj) => {
    console.log(`[Updater] downloading: ${progressObj.percent.toFixed(1)}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[Updater] update downloaded:", info.version);
    updateStatus.onDownloaded(info.version);
    updateTrayMenu();
    showMessage({
      type: "info",
      title: "Update Ready",
      message: `quietpls ${info.version} is ready to install.`,
      detail:
        "Restart now to apply it, or use “Restart to Update” in the tray menu later.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });
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
    trayIcons[stateMap[name]] = icon;
  }
}

function createTray() {
  loadTrayIcons();
  tray = new Tray(trayIcons.inactive);
  tray.setToolTip("quietpls");

  // Click tray icon to toggle monitoring
  tray.on("click", () => {
    toggleMonitoringFromMain();
  });

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
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const template = [
    {
      label: isMonitoring ? "Stop Monitoring" : "Start Monitoring",
      click: () => {
        toggleMonitoringFromMain();
      },
    },
    { type: "separator" },
    {
      label: "Settings",
      accelerator: "CmdOrCtrl+Shift+S",
      click: () => {
        createSettingsWindow();
      },
    },
    {
      label: "Show Tutorial",
      click: () => {
        createOnboardingWindow();
      },
    },
    { type: "separator" },
    {
      label: updateStatus.label,
      enabled: updateStatus.enabled,
      click: () => {
        if (updateStatus.available) {
          autoUpdater.quitAndInstall();
        } else {
          checkForUpdates(true);
        }
      },
    },
    {
      label: "About",
      click: () => {
        showAboutDialog();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      accelerator: "CmdOrCtrl+Q",
      click: () => {
        app.quit();
      },
    },
  ];

  const contextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);
}

/**
 * Draw the tray from the widget's zone decision — the tray never classifies
 * levels itself, so it always agrees with the pill.
 * @param {{ visual: string, level: number }} update
 */
function updateTrayIcon(update) {
  if (!tray || !isMonitoring || !update) return;

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
  if (!tray) return;
  currentTrayIconState = "inactive";
  tray.setImage(trayIcons.inactive);
  if (trayIconRenderer) {
    trayIconRenderer.resetVolumeHistory();
  }
}

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

  // Check and request microphone access (centralized in PermissionManager)
  await permissionManager.checkAndRequestPermission();

  // Register permission IPC handlers (get-microphone-status, microphone-track-ended)
  permissionManager.registerIPC(() => mainWindow);

  // Onboarding: request microphone access from renderer (US-019)
  ipcMain.handle("request-microphone-access", async () => {
    return permissionManager.checkAndRequestPermission();
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
  meetingDetector = createMeetingDetector({
    pollIntervalMs: 10000,
    graceMs: 30000,
    timeoutMs: 3000,
  });

  // Read setting (default: disabled)
  const meetingDetectionEnabled = generalSettingsStore
    ? generalSettingsStore.get("meetingDetection", false)
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

  ipcMain.handle("get-meeting-detection-enabled", function () {
    return generalSettingsStore
      ? generalSettingsStore.get("meetingDetection", false)
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
  widgetAnimator = createWidgetAnimator(mainWindow);
  widgetAnimator.connectStateMachine(widgetStateMachine);

  // Create system tray
  createTray();

  // Initialize auto-updater
  setupAutoUpdater();

  // Register global keyboard shortcuts
  // Cmd+Shift+M to toggle monitoring
  globalShortcut.register("CommandOrControl+Shift+M", () => {
    toggleMonitoringFromMain();
  });

  // Cmd+Shift+S to open settings
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
  ipcMain.on("open-settings", () => {
    createSettingsWindow();
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
    const sanitized = {
      sensitivity: clampSensitivity(settings.sensitivity),
      audioDeviceId:
        typeof settings.audioDeviceId === "string"
          ? settings.audioDeviceId
          : "",
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

  ipcMain.on("capture-status", (event, status) => {
    if (!status || typeof status !== "object") return;
    lastCaptureStatus = status;
    if (settingsWindow) {
      settingsWindow.webContents.send("capture-status", status);
    }
  });

  ipcMain.handle("get-capture-status", () => lastCaptureStatus);

  // Settings "Recalibrate": same live operation as the context-menu item.
  ipcMain.on("request-recalibration", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("trigger-recalibration");
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
      return { x: 0, y: 0, width: 72, height: 28 };
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
  });

  // Native context menu
  ipcMain.on("show-context-menu", (event, menuData) => {
    const template = [
      {
        label: isMonitoring ? "Stop Monitoring" : "Start Monitoring",
        icon: null, // Native menus don't support emojis well
        click: () => {
          toggleMonitoringFromMain();
        },
      },
      {
        label: "Recalibrate",
        enabled: isMonitoring === true,
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("trigger-recalibration");
          }
        },
      },
      {
        label: "Settings",
        accelerator: "CmdOrCtrl+Shift+S",
        click: () => {
          createSettingsWindow();
        },
      },
      { type: "separator" },
      {
        label: "Show Tutorial",
        click: () => {
          createOnboardingWindow();
        },
      },
      {
        label: "About",
        click: () => {
          showAboutDialog();
        },
      },
    ];

    const menu = Menu.buildFromTemplate(template);
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
    widgetAnimator = createWidgetAnimator(mainWindow);
    widgetAnimator.connectStateMachine(widgetStateMachine);
  }
});
