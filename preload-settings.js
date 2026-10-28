const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  requestSettings: () => {
    ipcRenderer.send("request-settings");
  },
  onSettingsData: (callback) => {
    ipcRenderer.once("settings-data", (event, settings) => {
      callback(settings);
    });
  },
  updateSettings: (settings) => {
    ipcRenderer.send("update-settings", settings);
  },
  onSettingsUpdated: (callback) => {
    ipcRenderer.on("settings-updated", (event, settings) => {
      callback(settings);
    });
  },
  onLevelUpdate: (callback) => {
    ipcRenderer.on("level-update", (event, update) => {
      callback(update);
    });
  },
  getCaptureStatus: () => ipcRenderer.invoke("get-capture-status"),
  getInputTransports: () => ipcRenderer.invoke("get-input-transports"),
  onCaptureStatus: (callback) => {
    ipcRenderer.on("capture-status", (event, status) => {
      callback(status);
    });
  },
  requestRecalibration: () => ipcRenderer.send("request-recalibration"),
  onMonitoringStatus: (callback) => {
    ipcRenderer.on("monitoring-status", (event, status) => {
      callback(status);
    });
  },
  closeSettings: () => {
    ipcRenderer.send("close-settings");
  },
  // General settings (launch at login, menubar, notification sounds)
  getGeneralSettings: () => {
    return ipcRenderer.invoke("get-general-settings");
  },
  updateGeneralSettings: (settings) => {
    ipcRenderer.send("update-general-settings", settings);
  },

  // Meeting detection (US-016)
  getMeetingDetectionEnabled: () =>
    ipcRenderer.invoke("get-meeting-detection-enabled"),
  setMeetingDetectionEnabled: (enabled) =>
    ipcRenderer.send("set-meeting-detection-enabled", { enabled }),

  // Session history (US-018)
  getSessions: (options) => ipcRenderer.invoke("get-sessions", options),
  getSession: (id) => ipcRenderer.invoke("get-session", id),
  deleteSession: (id) => ipcRenderer.invoke("delete-session", id),
  getSessionStats: () => ipcRenderer.invoke("get-session-stats"),

  // Calibration (US-018)
  getCalibration: (deviceId) => ipcRenderer.invoke("get-calibration", deviceId),
  clearCalibration: (deviceId) =>
    ipcRenderer.send("clear-calibration", { deviceId }),

  // Capture (beta) section (capture/settings-section.js)
  captureSummary: () => ipcRenderer.invoke("capture:summary"),
  setCaptureEnabled: (enabled) =>
    ipcRenderer.invoke("capture:set-enabled", enabled),
  openTranscripts: (tab) => ipcRenderer.invoke("capture:open-main", tab),
});
