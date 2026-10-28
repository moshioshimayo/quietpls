"use strict";

// Capture windows (banner, indicator, transcripts, always-on consent). Every call goes to
// a "capture:"-prefixed channel handled in capture/mode.js.
const { contextBridge, ipcRenderer } = require("electron");

const call =
  (name) =>
  (...args) =>
    ipcRenderer.invoke(`capture:${name}`, ...args);

contextBridge.exposeInMainWorld("qpc", {
  snapshot: call("snapshot"),
  ambientDialog: call("ambient-dialog"),
  ambientConfirm: call("ambient-confirm"),
  ambientCancel: call("ambient-cancel"),
  ambientStop: call("ambient-stop"),
  speakerDownload: call("speaker-download"),
  speakerRename: call("speaker-rename"),
  transcripts: call("transcripts"),
  transcript: call("transcript"),
  setSettings: call("settings"),
  chooseFolder: call("choose-folder"),
  downloadModel: call("download-model"),
  accept: call("accept"),
  skip: call("skip"),
  never: call("never"),
  stop: call("stop"),
  dismiss: call("dismiss"),
  openMain: call("open-main"),
  reveal: call("reveal"),
  copy: call("copy"),
  openPrivacy: call("open-privacy"),
  refresh: call("refresh"),
  fit: call("fit"),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, data) => fn(data)),
});
