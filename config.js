// Shared configuration module for quietpls
// Default settings and store names in one place.

// Acoustic research–based defaults (see docs/specs and README):
// <=30 dB calm/quiet, <=50 normal, <=78 loud-but-ok, >78 too loud.
const defaultThresholds = {
  quietThreshold: 30,
  normalThreshold: 50,
  warningThreshold: 78,
};

const SETTINGS_STORE = "quietpls-settings";

module.exports = {
  defaultThresholds,
  SETTINGS_STORE,
};
