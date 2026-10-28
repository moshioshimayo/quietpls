"use strict";

// The "Capture (beta)" section of quietpls's Settings window. Capture's own settings
// (folder, speech model, audio, always-on) live in the transcripts window.
(function () {
  const api = window.electronAPI;
  const toggle = document.getElementById("captureEnabled");
  if (!api || !api.captureSummary || !toggle) return;
  const description = document.getElementById("captureDescription");
  const actions = document.getElementById("captureActions");

  function show(s) {
    toggle.checked = s.enabled;
    actions.hidden = !s.enabled && !s.ambient;
    description.textContent = !s.enabled
      ? "Off. Monitoring never records anything."
      : s.setupDone
        ? "On. You're asked before any call is recorded."
        : "On, but not set up yet. Open Capture settings to finish.";
  }

  toggle.addEventListener("change", async () => {
    const s = await api.setCaptureEnabled(toggle.checked);
    show(s);
    if (s.enabled && !s.setupDone) api.openTranscripts("settings");
  });
  document.getElementById("captureSettingsBtn").onclick = () =>
    api.openTranscripts("settings");
  document.getElementById("captureTranscriptsBtn").onclick = () =>
    api.openTranscripts("calls");
  window.addEventListener("focus", () => api.captureSummary().then(show));
  api.captureSummary().then(show);
})();
