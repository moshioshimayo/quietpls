const { contextBridge, ipcRenderer } = require("electron");

// Inline defaults since sandboxed preloads can't require local modules
const defaultThresholds = {
  quietThreshold: 30,
  normalThreshold: 50,
  warningThreshold: 78,
};

contextBridge.exposeInMainWorld("electronAPI", {
  onToggleMonitoring: (callback) => {
    ipcRenderer.on("toggle-monitoring", (event, isMonitoring) => {
      callback(isMonitoring);
    });
  },
  requestMonitoringStatus: () => {
    ipcRenderer.send("request-monitoring-status");
  },
  onMonitoringStatus: (callback) => {
    ipcRenderer.on("monitoring-status", (event, status) => {
      callback(status);
    });
  },
  setMonitoring: (status) => {
    ipcRenderer.send("set-monitoring", status);
  },
  openSettings: () => {
    ipcRenderer.send("open-settings");
  },
  showOnboarding: () => {
    ipcRenderer.send("show-onboarding");
  },
  showAbout: () => {
    ipcRenderer.send("show-about");
  },
  sendVolumeUpdate: (volume) => {
    ipcRenderer.send("volume-update", volume);
  },
  onSettingsUpdated: (callback) => {
    ipcRenderer.on("settings-updated", (event, settings) => {
      callback(settings);
    });
  },
  showContextMenu: (menuData) => {
    ipcRenderer.send("show-context-menu", menuData);
  },
  getMicrophoneStatus: () => ipcRenderer.invoke("get-microphone-status"),
  notifyMicrophoneTrackEnded: () => ipcRenderer.send("microphone-track-ended"),
  onMicrophonePermissionRevoked: (callback) => {
    ipcRenderer.on("microphone-permission-revoked", (event, data) => {
      callback(data);
    });
  },
  defaultThresholds: { ...defaultThresholds },

  // Widget state machine (mirrored from main process via IPC)
  widgetGetState: () => ipcRenderer.invoke("widget-get-state"),
  widgetTransition: (targetState, context) =>
    ipcRenderer.invoke("widget-transition", targetState, context),
  onWidgetStateChanged: (callback) => {
    ipcRenderer.on("widget-state-changed", (event, payload) => {
      callback(payload);
    });
  },

  // Screen / window position (US-006 snap-to-position)
  getScreenDimensions: () => ipcRenderer.invoke("get-screen-dimensions"),
  getWindowPosition: () => ipcRenderer.invoke("get-window-position"),
  getWindowBounds: () => ipcRenderer.invoke("get-window-bounds"),
  setWindowPosition: (x, y) => ipcRenderer.invoke("set-window-position", x, y),

  // Calibration (US-008/US-009)
  getCalibration: (deviceId) => ipcRenderer.invoke("get-calibration", deviceId),
  saveCalibration: (deviceId, data) =>
    ipcRenderer.send("save-calibration", { deviceId, data }),
  clearCalibration: (deviceId) =>
    ipcRenderer.send("clear-calibration", { deviceId }),
  onTriggerRecalibration: (callback) =>
    ipcRenderer.on("trigger-recalibration", () => callback()),

  // Meeting detection (US-016)
  onMeetingDetectionChanged: (callback) =>
    ipcRenderer.on("meeting-detection-changed", (event, data) =>
      callback(data),
    ),
  getMeetingDetectionEnabled: () =>
    ipcRenderer.invoke("get-meeting-detection-enabled"),
  setMeetingDetectionEnabled: (enabled) =>
    ipcRenderer.send("set-meeting-detection-enabled", { enabled }),

  // Session storage (US-012)
  getSessions: (options) => ipcRenderer.invoke("get-sessions", options),
  getSession: (id) => ipcRenderer.invoke("get-session", id),
  saveSession: (data) => ipcRenderer.invoke("save-session", data),
  deleteSession: (id) => ipcRenderer.invoke("delete-session", id),
  getSessionStats: () => ipcRenderer.invoke("get-session-stats"),
});
