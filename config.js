// Shared configuration module for quietpls
// Default settings and store names in one place.

// Zones are relative to each mic's calibrated normal voice (see level-logic.js):
// yellow at +6 dB, red at +10 dB. Sensitivity (-4..+4 dB) shifts both.
const defaultSettings = {
  sensitivity: 0,
  audioDeviceId: "",
};

const SETTINGS_STORE = "quietpls-settings";

module.exports = {
  defaultSettings,
  SETTINGS_STORE,
};
