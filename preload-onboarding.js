const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Close setup. Set up later / Close: { startMonitoring: false }.
  onboardingComplete: (data) => {
    ipcRenderer.send("onboarding-complete", data);
  },
  // "Set normal voice": close setup and open voice setup in the panel.
  setNormalVoice: () => {
    ipcRenderer.send("onboarding-complete", { startMonitoring: false });
    ipcRenderer.send("request-recalibration");
  },
  getMicrophoneStatus: () => ipcRenderer.invoke("get-microphone-status"),
  // AC-I7: step 3 reflects a saved normal voice and whether monitoring runs.
  getCalibration: (deviceId) => ipcRenderer.invoke("get-calibration", deviceId),
  getMonitoringStatus: () =>
    new Promise((resolve) => {
      ipcRenderer.once("monitoring-status", (_event, status) => resolve(status));
      ipcRenderer.send("request-monitoring-status");
    }),
  // The only call that can show the macOS prompt (while undetermined).
  requestMicrophoneAccess: () => ipcRenderer.invoke("request-microphone-access"),
  onMicrophoneStatusChanged: (callback) => {
    ipcRenderer.on("microphone-status-changed", (_event, status) => callback(status));
  },
  openSystemSettings: () => {
    ipcRenderer.send("open-system-settings");
  },
  getInputTransports: () => ipcRenderer.invoke("get-input-transports"),
  getSettings: () =>
    new Promise((resolve) => {
      ipcRenderer.once("settings-data", (_event, settings) => resolve(settings));
      ipcRenderer.send("request-settings");
    }),
  updateSettings: (settings) => {
    ipcRenderer.send("update-settings", settings);
  },
  setupResize: (height) => {
    ipcRenderer.send("setup-resize", height);
  },
  onCloseWindow: (callback) => {
    ipcRenderer.on("close-window", () => {
      callback();
    });
  },
});
