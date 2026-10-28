"use strict";

// Loudness → bar width; speech peaks around 0.05–0.3 RMS, so use a log-ish scale.
const width = (rms) =>
  `${Math.round(Math.min(1, Math.max(0, (Math.log10(rms + 1e-5) + 3.2) / 2.6)) * 100)}%`;

function show(snap) {
  const { phase, file, error } = snap.state;
  $("#pill").className = `pill ${phase}`;
  $("#dot").className = `dot ${phase}`;
  const recording = phase === "recording";
  if (phase === "ambient") {
    $("#pill").className = "pill recording ambient";
    $("#dot").className = "dot recording";
    $("#label").textContent = "ALWAYS ON";
    $("#meters").hidden = true;
    $("#detail").hidden = false;
    $("#detail").textContent = snap.elapsed
      ? clock(snap.elapsed)
      : "transcribing…";
    $("#stop").hidden = false;
    $("#open").hidden = true;
    $("#stop").onclick = () => window.qpc.ambientStop();
    return;
  }
  $("#stop").onclick = () => window.qpc.stop();
  $("#meters").hidden = !recording;
  $("#stop").hidden = !recording;
  $("#detail").hidden = recording;
  $("#open").hidden = !(phase === "saved" || phase === "error");
  if (recording) $("#label").textContent = `REC ${clock(snap.elapsed)}`;
  if (phase === "transcribing") {
    $("#label").textContent = "Transcribing";
    $("#detail").textContent = "turning the call into text…";
  }
  if (phase === "saved") {
    $("#label").textContent = "Saved";
    $("#detail").textContent = "transcript committed";
    $("#detail").title = file || "";
  }
  if (phase === "error") {
    $("#label").textContent = "Not saved";
    $("#detail").textContent = error || "";
    $("#detail").title = error || "";
  }
}

window.qpc.on("snapshot", show);
window.qpc.on("levels", (l) => {
  $("#you").style.width = width(l.you);
  $("#them").style.width = width(l.them);
});
window.qpc.snapshot().then(show);
$("#stop").onclick = () => window.qpc.stop();
$("#open").onclick = () => {
  window.qpc.openMain("calls");
  window.qpc.dismiss();
};
