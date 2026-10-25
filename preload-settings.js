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
  onVolumeUpdate: (callback) => {
    ipcRenderer.on("volume-update", (event, volume) => {
      callback(volume);
    });
  },
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
});
