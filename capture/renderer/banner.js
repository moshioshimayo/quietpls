"use strict";

// Why recording can't start right now, as one line (null = it can).
function blocker({ state, settings, health }) {
  const never = state.apps.filter((a) =>
    (settings.neverApps || []).includes(a),
  );
  if (never.length)
    return `Recording blocked. ${never.join(" and ")} ${never.length === 1 ? "is" : "are"} set to Never.`;
  if (health.folder.reason === "has-remote")
    return "Your transcript folder syncs to an online code repository. Choose another folder in Settings.";
  if (!health.folder.ok) return "Choose a transcript folder in Settings first.";
  if (!health.whisper)
    return "Install speech-to-text in Capture settings first.";
  if (!health.modelReady) return "Download a speech model in Settings first.";
  if (health.mic === "denied")
    return "Turn on quietpls microphone access in System Settings.";
  return null;
}

let blocked = null;

function show(snap) {
  const { state, settings, home } = snap;
  // Every app using the mic is named: recording takes all of their audio.
  $("#app").textContent = appList(state.apps);
  const askable = state.apps.filter(
    (a) => !(settings.neverApps || []).includes(a),
  );
  $("#app2").textContent = askable.length === 1 ? askable[0] : "these apps";
  $("#where").textContent = settings.folder
    ? `${shortPath(settings.folder, home)} · on this Mac`
    : "Choose a transcript folder first";
  $("#where").title = settings.folder ? tilde(settings.folder, home) : "";
  $("#audio").textContent = settings.keepAudio
    ? settings.keepDays === 1
      ? "Kept for 1 day, then deleted"
      : `Kept for ${settings.keepDays} days, then deleted`
    : "Deleted after transcript is saved";
  blocked = blocker(snap);
  $("#warn").hidden = !blocked;
  $("#warn").textContent = blocked || "";
  $("#facts").hidden = $("#private").hidden = Boolean(blocked);
  $("#accept").textContent = blocked ? "Open settings" : "Record this call";
  // Card plus the body's transparent margin (6 top + 22 bottom).
  requestAnimationFrame(() => window.qpc.fit($(".card").offsetHeight + 28));
}

window.qpc.on("snapshot", show);
window.qpc.snapshot().then(show);
$("#accept").onclick = () =>
  blocked ? window.qpc.openMain("settings") : window.qpc.accept();
$("#skip").onclick = () => window.qpc.skip();
$("#never").onclick = () => window.qpc.never();
