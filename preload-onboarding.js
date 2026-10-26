const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onboardingComplete: (data) => {
    ipcRenderer.send("onboarding-complete", data);
  },
  getAppVersion: () => {
    return ipcRenderer.invoke("get-app-version");
  },
  getMicrophoneStatus: () => {
    return ipcRenderer.invoke("get-microphone-status");
  },
  requestMicrophoneAccess: () => {
    return ipcRenderer.invoke("request-microphone-access");
  },
  getInputTransports: () => {
    return ipcRenderer.invoke("get-input-transports");
  },
  openSystemSettings: () => {
    ipcRenderer.send("open-system-settings");
  },
  onCloseWindow: (callback) => {
    ipcRenderer.on("close-window", () => {
      callback();
    });
  },
});
