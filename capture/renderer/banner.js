"use strict";

// Why recording can't start right now, in plain words (null = it can).
function blocker({ state, settings, health }) {
  const never = state.apps.filter((a) =>
    (settings.neverApps || []).includes(a),
  );
  if (never.length)
    return `Can't record: ${never.join(" and ")} ${never.length === 1 ? "is" : "are"} set to Never record, and recording would capture ${never.length === 1 ? "it" : "them"} too.`;
  if (health.folder.reason === "has-remote")
    return "Can't record: your transcript folder's git repo has a remote, so calls could be pushed.";
  if (!health.folder.ok)
    return "Can't record yet: choose a transcript folder first.";
  if (!health.whisper)
    return "Can't record yet: speech-to-text isn't installed.";
  if (!health.modelReady)
    return "Can't record yet: the speech model isn't downloaded.";
  if (health.mic === "denied")
    return "Can't record: microphone access is off for this app.";
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
    ? `text to ${tilde(settings.folder, home)} (git, this Mac only)`
    : "nowhere yet — choose a folder first";
  $("#audio").textContent = settings.keepAudio
    ? `kept for ${settings.keepDays} day${settings.keepDays === 1 ? "" : "s"}, then deleted`
    : "deleted once the text is saved";
  blocked = blocker(snap);
  $("#warn").hidden = !blocked;
  $("#warn").textContent = blocked || "";
  $("#accept").textContent = blocked ? "Fix in Settings" : "Record this call";
  requestAnimationFrame(() => window.qpc.fit($(".card").offsetHeight + 12));
}

window.qpc.on("snapshot", show);
window.qpc.snapshot().then(show);
$("#accept").onclick = () =>
  blocked ? window.qpc.openMain("settings") : window.qpc.accept();
$("#skip").onclick = () => window.qpc.skip();
$("#never").onclick = () => window.qpc.never();
