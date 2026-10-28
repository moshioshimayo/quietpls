"use strict";

const api = window.qpc;
let snap = null;
let tab = "calls";
let calls = [];
let selected = null;
let query = "";
let lastKey = { settings: "", calls: "", alerts: "" };

const STATUS = {
  off: ["Off — not listening for calls", "Turn on"],
  idle: ["Waiting for a call", null],
  detected: ["Call on — not recording", null],
  asking: ["Call on — asking to record", "Record"],
  recording: ["Recording", "Stop"],
  transcribing: ["Transcribing…", null],
  saved: ["Transcript saved", "Show"],
  error: ["Needs attention", null],
  ambient: ["ALWAYS ON — microphone + system audio", "Stop"],
};

function setupDone(s) {
  return Boolean(s.health.whisper && s.health.modelReady && s.health.folder.ok);
}

// MARK: header status — every phase readable at a glance

function renderStatus() {
  const { phase, apps, file } = snap.state;
  const [text, wanted] = STATUS[phase];
  const action = phase === "off" && !setupDone(snap) ? null : wanted;
  $("#status").className = `status ${phase}`;
  $("#status-dot").className = `dot ${phase}`;
  const appText =
    apps.length && ["detected", "asking", "recording"].includes(phase)
      ? ` · ${apps.join(", ")}`
      : "";
  $("#status-text").textContent =
    phase === "recording"
      ? `Recording ${clock(snap.elapsed)}${appText}`
      : text + appText;
  const btn = $("#status-action");
  btn.hidden = !action;
  btn.textContent = action || "";
  btn.className =
    phase === "recording"
      ? "danger"
      : phase === "asking" || phase === "off"
        ? "primary"
        : "";
  btn.onclick = () => {
    if (phase === "off") api.setSettings({ enabled: true });
    if (phase === "asking") api.accept();
    if (phase === "recording") api.stop();
    if (phase === "ambient") api.ambientStop();
    if (phase === "saved") {
      showTab("calls");
      select(file);
    }
  };
}

// MARK: alerts — problems stay on screen until fixed

function alerts() {
  const { health, state, settings, home } = snap;
  const out = [];
  if (state.phase === "error" && state.error)
    out.push({
      kind: "bad",
      html: esc(state.error),
      action: ["OK", () => api.dismiss()],
    });
  if (health.folder.reason === "has-remote") {
    const r = health.folder.remotes
      .map((x) => `${esc(x.name)} → ${esc(x.url)}`)
      .join(", ");
    out.push({
      kind: "bad",
      html: `<b>Transcripts are paused.</b> ${esc(tilde(settings.folder, home))} is a git repo with a remote (${r}). Calls are never written to a repo that can be pushed. Remove the remote or pick another folder.`,
      action: ["Choose folder…", () => api.chooseFolder()],
    });
  } else if (health.folder.reason === "missing") {
    out.push({
      kind: "bad",
      html: `<b>Transcript folder not found:</b> ${esc(tilde(settings.folder, home))}`,
      action: ["Choose folder…", () => api.chooseFolder()],
    });
  }
  if (health.mic === "denied")
    out.push({
      kind: "bad",
      html: "<b>Microphone access is off,</b> so your side can't be recorded. Turn it on in System Settings → Privacy &amp; Security → Microphone.",
      action: ["Open System Settings", () => api.openPrivacy("mic")],
    });
  if (!health.whisper && setupStarted())
    out.push({
      kind: "warn",
      html: "<b>Speech-to-text isn't installed.</b> In Terminal, run <code>brew install whisper-cpp</code>, then check again.",
      action: ["Check again", () => api.refresh()],
    });
  if ((health.lastCallSilent || []).includes("them"))
    out.push({
      kind: "warn",
      html: "<b>The last call had no sound from the other side.</b> macOS may be blocking system audio. Allow it in System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording.",
      action: ["Open System Settings", () => api.openPrivacy("audio")],
    });
  return out;
}

function setupStarted() {
  return setupDone(snap) || snap.settings.folder;
}

function renderAlerts() {
  const list = alerts();
  const key = JSON.stringify(list.map((a) => a.html));
  if (key === lastKey.alerts) return;
  lastKey.alerts = key;
  const box = $("#alerts");
  box.innerHTML = "";
  for (const a of list) {
    const el = document.createElement("div");
    el.className = `alert ${a.kind}`;
    el.innerHTML = `<span class="msg">${a.html}</span>`;
    if (a.action) {
      const b = document.createElement("button");
      b.textContent = a.action[0];
      b.onclick = a.action[1];
      el.append(b);
    }
    box.append(el);
  }
}

// MARK: calls tab

async function loadCalls() {
  calls = await api.transcripts();
  renderCalls();
}

function matches(c) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    c.text.includes(q) ||
    String(c.meta.title || "")
      .toLowerCase()
      .includes(q) ||
    c.name.includes(q)
  );
}

// "00:12:31" → "12:31", "01:02:03" stays
const dur = (d) => String(d || "").replace(/^00:/, "");

function when(meta) {
  const d = new Date(meta.start);
  if (isNaN(d)) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function mark(text) {
  const t = esc(text);
  if (!query) return t;
  const q = esc(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return t.replace(new RegExp(q, "ig"), (m) => `<mark>${m}</mark>`);
}

function snippet(c) {
  if (!query) return c.preview;
  const i = c.text.indexOf(query.toLowerCase());
  return i < 0 ? c.preview : "…" + c.text.slice(Math.max(0, i - 12), i + 80);
}

function renderCalls() {
  const reader = $("#reader");
  const rows = $("#rows");
  if (!setupDone(snap) || (!snap.settings.enabled && !calls.length)) {
    $(".list").hidden = true;
    $("#calls").style.gridTemplateColumns = "1fr";
    reading = null;
    reader.innerHTML = setupHtml();
    wireSetup();
    return;
  }
  $(".list").hidden = false;
  $("#calls").style.gridTemplateColumns = "";
  const shown = calls.filter(matches);
  rows.innerHTML = shown.length
    ? shown
        .map(
          (
            c,
          ) => `<li class="row${c.name === selected ? " sel" : ""}" data-name="${esc(c.name)}">
        <span class="t">${esc(c.meta.title || c.name)}</span><span class="muted num">${esc(dur(c.meta.duration))}</span>
        <span class="p muted">${esc(when(c.meta))} · ${mark(snippet(c) || "no speech")}</span></li>`,
        )
        .join("")
    : `<li class="none">${calls.length ? `No calls match “${esc(query)}”.` : "No calls yet."}</li>`;
  rows
    .querySelectorAll(".row")
    .forEach((r) => (r.onclick = () => select(r.dataset.name)));
  if (!calls.length) {
    reading = null;
    reader.innerHTML = `<div class="empty"><h2>No calls yet</h2>
      <p>When a call starts (Zoom, Meet, Teams, FaceTime…), a small box asks before anything is recorded.
      Say yes and the transcript shows up here, newest first.</p>
      <p>${snap.settings.enabled ? "Listening for calls now." : "Asking is off. Turn it on in the top right."}</p></div>`;
    return;
  }
  if (!selected || !calls.some((c) => c.name === selected))
    select(shown[0] ? shown[0].name : calls[0].name);
  else if (selected !== reading) select(selected);
}

let reading = null; // the call shown in the reader

async function select(name) {
  selected = reading = name;
  document
    .querySelectorAll(".row")
    .forEach((r) => r.classList.toggle("sel", r.dataset.name === name));
  const t = await api.transcript(name);
  const reader = $("#reader");
  if (!t) {
    reader.innerHTML = `<div class="empty"><h2>That call's file is gone</h2><p>${esc(name)}</p></div>`;
    return;
  }
  const m = t.meta;
  reader.innerHTML = `<h1>${esc(m.title || name)}</h1>
    <div class="meta"><span>${esc(when(m))}</span>·<span class="num">${esc(dur(m.duration))}</span>·<span>${esc((m.apps || []).join(", "))}</span>·<span>audio ${esc(m.audio || "")}</span>
      <span class="tools"><button id="copy">Copy text</button><button id="reveal">Show in Finder</button></span></div>
    ${t.notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}
    <div class="lines">${t.lines.map((l) => `<span class="at">${esc(l.at)}</span><span class="who ${l.who}">${l.speaker ? `<button class="speaker" data-speaker="${esc(l.speaker)}" title="${l.who} channel — click to rename">${esc(l.speaker)}</button>` : l.who === "you" ? "You" : "Them"}</span><span>${mark(l.text)}</span>`).join("")}</div>`;
  $("#copy").onclick = () =>
    api.copy(
      t.lines
        .map(
          (l) =>
            `[${l.at}] [${l.who}]${l.speaker ? ` (${l.speaker})` : ""} ${l.text}`,
        )
        .join("\n"),
    );
  $("#reveal").onclick = () => api.reveal(name);
  reader.querySelectorAll("[data-speaker]").forEach(
    (b) =>
      (b.onclick = () => {
        const from = b.dataset.speaker;
        const input = document.createElement("input");
        input.value = from;
        input.setAttribute("aria-label", `Rename ${from}`);
        b.replaceWith(input);
        input.focus();
        input.select();
        input.onkeydown = async (e) => {
          if (e.key === "Escape") return select(name);
          if (e.key !== "Enter") return;
          input.disabled = true;
          try {
            await api.speakerRename(name, from, input.value);
            await select(name);
          } catch (err) {
            input.disabled = false;
            input.title = err.message;
          }
        };
      }),
  );
}

function setupHtml() {
  const { health, settings, home, models } = snap;
  const model = models.find((m) => m.id === settings.model) || models[0];
  const dl = health.download;
  const step = (
    state,
    n,
    what,
    why,
    action,
  ) => `<li class="${state}"><span class="mark">${state === "done" ? "✓" : state === "bad" ? "!" : n}</span>
    <div><div class="what">${what}</div><div class="why">${why}</div></div><div>${action || ""}</div></li>`;
  const folderBad =
    health.folder.reason === "has-remote" || health.folder.reason === "missing";
  return `<div class="setup">
    <h2>${setupDone(snap) ? "Ready" : "Set up call transcripts"}</h2>
    <p>Records your calls only when you say yes, turns them into text on this Mac, and saves one file per call to a folder you pick.</p>
    <ol class="steps">
      ${step(health.whisper ? "done" : "", 1, "Install speech-to-text", health.whisper ? `Found ${esc(health.whisper)}` : "In Terminal, run <code>brew install whisper-cpp</code>", health.whisper ? "" : '<button data-do="refresh">Check again</button>')}
      ${step(
        health.modelReady ? "done" : dl && dl.error ? "bad" : "",
        2,
        `Download the speech model (${esc(model.size)})`,
        health.modelReady
          ? `${esc(model.id)} is ready`
          : dl && dl.error
            ? esc(dl.error)
            : "Downloaded once from Hugging Face and kept in ~/Library/Application Support/quietpls/models. Capture makes no other network requests.",
        health.modelReady
          ? ""
          : dl && !dl.error
            ? `<progress max="1" value="${dl.progress}"></progress>`
            : `<button class="primary" data-do="download">Download</button>`,
      )}
      ${step(
        health.folder.ok ? "done" : folderBad ? "bad" : "",
        3,
        "Choose a transcript folder",
        health.folder.ok
          ? `${esc(tilde(settings.folder, home))} · local git repo, no remote`
          : folderBad
            ? "That folder's repo has a remote. Pick one that can't be pushed."
            : "Each call is saved there as a markdown file and committed with git. It must not have a git remote.",
        `<button ${health.folder.ok ? "" : 'class="primary"'} data-do="folder">${health.folder.ok ? "Change…" : "Choose…"}</button>`,
      )}
      ${step(
        settings.enabled ? "done" : "",
        4,
        "Turn on “ask when a call starts”",
        settings.enabled
          ? "On. You'll be asked at the start of every call."
          : "Nothing is recorded unless you say yes to that call.",
        settings.enabled
          ? ""
          : `<button ${setupDone(snap) ? 'class="primary"' : "disabled"} data-do="enable">Turn on</button>`,
      )}
    </ol>
    <p class="privacy">Recordings and transcripts stay on this Mac. Audio is deleted once the text is saved (change this in Settings).</p>
  </div>`;
}

function wireSetup() {
  document.querySelectorAll("[data-do]").forEach(
    (b) =>
      (b.onclick = () => {
        const what = b.dataset.do;
        if (what === "refresh") api.refresh();
        if (what === "download") api.downloadModel(snap.settings.model);
        if (what === "folder") api.chooseFolder();
        if (what === "enable") api.setSettings({ enabled: true });
      }),
  );
}

// MARK: settings tab

function renderSettings() {
  const { settings, health, models, home } = snap;
  const dl = health.download;
  const folderLine = !settings.folder
    ? '<span class="muted">No folder chosen</span>'
    : health.folder.ok
      ? '<span class="ok">✓ Local git repo, no remote</span>'
      : health.folder.reason === "has-remote"
        ? `<span class="bad">✗ Has a remote (${health.folder.remotes.map((r) => esc(r.name)).join(", ")}). Nothing will be saved here.</span>`
        : '<span class="bad">✗ Folder not found</span>';
  const apps = [
    ...new Set([...(settings.seenApps || []), ...(settings.neverApps || [])]),
  ].sort();
  $("#settings").innerHTML = `
    <section><h3>Capture</h3><div class="body">
      <label class="switch"><input type="checkbox" id="enabled" ${settings.enabled ? "checked" : ""}> Ask to record when a call starts</label>
      <span class="hint">${settings.enabled ? "On: when an app starts using the mic, you're asked before anything is recorded." : "Off: calls aren't noticed and nothing is recorded."}</span>
    </div></section>
    <section><h3>Always-on</h3><div class="body">
      <div><button id="ambient" class="${snap.state.phase === "ambient" ? "danger" : ""}">${snap.state.phase === "ambient" ? "Stop always-on recording" : "Set up always-on…"}</button></div>
      <span class="hint">Separate explicit consent. Records beyond calls. 24-hour transcript retention; no audio kept. Ambient files are excluded from git history.</span>
    </div></section>
    <section><h3>Speaker labels</h3><div class="body">
      <label class="switch"><input id="speakers" type="checkbox" ${settings.speakerLabels ? "checked" : ""} ${!health.speakerModelReady || !health.uv ? "disabled" : ""}> Label different speakers locally</label>
      <span class="hint">${health.speakerModelReady ? "26 MB ONNX model ready." : '<button id="speaker-download">Download speaker model (26 MB)</button>'} ${health.uv ? "Setup downloads Python dependencies via uv; processing then runs offline." : "Install the Python runner first: brew install uv"}</span>
      <span class="hint">Speaker 1/2/… on the far side; primary mic voice stays You. Click a speaker label to rename it, then press Enter. Estimates may split one person into several labels.</span>
      ${health.speakerError ? `<span class="bad">${esc(health.speakerError)}</span>` : ""}
    </div></section>
    <section><h3>Transcript folder</h3><div class="body">
      <span class="path">${esc(tilde(settings.folder, home)) || "—"}</span>${folderLine}
      <div><button id="folder">Choose folder…</button></div>
      <span class="hint">One markdown file per call, committed to this folder's git repo. Folders with a git remote are refused so calls can't be pushed by accident.</span>
    </div></section>
    <section><h3>Speech model</h3><div class="body">
      <div class="models">${models
        .map(
          (m) => `
        <input type="radio" name="model" value="${m.id}" id="m-${m.id}" ${m.id === settings.model ? "checked" : ""}>
        <label for="m-${m.id}">${esc(m.label)} <span class="muted">· ${esc(m.id)}</span></label>
        <span class="size">${esc(m.size)}</span>
        <span>${m.ready ? '<span class="ok">✓ Ready</span>' : dl && dl.id === m.id && !dl.error ? `<progress max="1" value="${dl.progress}"></progress>` : `<button data-dl="${m.id}">Download</button>`}</span>`,
        )
        .join("")}
      </div>
      ${dl && dl.error ? `<span class="bad">Download failed: ${esc(dl.error)}</span>` : ""}
      <span class="hint">${health.whisper ? `Runs on this Mac with ${esc(health.whisper)}.` : "Speech-to-text isn't installed: run <code>brew install whisper-cpp</code>."} Models download once from Hugging Face into ~/Library/Application Support/quietpls/models; Capture makes no other network requests.</span>
    </div></section>
    <section><h3>Audio</h3><div class="body">
      <label class="choice"><input type="radio" name="keep" value="no" ${settings.keepAudio ? "" : "checked"}> Delete audio once the text is saved (recommended)</label>
      <label class="choice"><input type="radio" name="keep" value="yes" ${settings.keepAudio ? "checked" : ""}> Keep audio for <input type="number" id="days" min="1" max="365" value="${settings.keepDays}"> days, then delete</label>
      <span class="hint">Audio is never put in the git repo.</span>
    </div></section>
    <section><h3>Apps</h3><div class="body">
      ${
        apps.length
          ? `<div class="apps">${apps
              .map((a) => {
                const never = settings.neverApps.includes(a);
                return `<span>${esc(a)}</span><span class="seg"><button data-app="${esc(a)}" data-never="0" aria-pressed="${!never}">Ask</button><button data-app="${esc(a)}" data-never="1" aria-pressed="${never}">Never</button></span>`;
              })
              .join("")}</div>`
          : '<span class="muted">Apps show up here after their first call.</span>'
      }
      <span class="hint">“Never” means that app's calls are ignored: no box, no recording.</span>
    </div></section>
    <section><h3>Permissions</h3><div class="body">
      <span>Microphone: ${health.mic === "granted" ? '<span class="ok">✓ Allowed</span>' : health.mic === "denied" ? '<span class="bad">✗ Off</span> <button id="mic">Open System Settings</button>' : "macOS asks the first time you record"}</span>
      <span>Call audio: <span class="muted">macOS asks the first time you record (System Audio Recording)</span></span>
    </div></section>`;
  $("#enabled").onchange = (e) =>
    api.setSettings({ enabled: e.target.checked });
  $("#folder").onclick = () => api.chooseFolder();
  $("#ambient").onclick = () =>
    snap.state.phase === "ambient" ? api.ambientStop() : api.ambientDialog();
  $("#speakers").onchange = (e) =>
    api.setSettings({ speakerLabels: e.target.checked });
  if ($("#speaker-download"))
    $("#speaker-download").onclick = () => api.speakerDownload();
  document
    .querySelectorAll('input[name="model"]')
    .forEach((r) => (r.onchange = () => api.setSettings({ model: r.value })));
  document
    .querySelectorAll("[data-dl]")
    .forEach((b) => (b.onclick = () => api.downloadModel(b.dataset.dl)));
  document
    .querySelectorAll('input[name="keep"]')
    .forEach(
      (r) =>
        (r.onchange = () => api.setSettings({ keepAudio: r.value === "yes" })),
    );
  $("#days").onchange = (e) =>
    api.setSettings({
      keepDays: Math.max(1, Math.min(365, Number(e.target.value) || 7)),
    });
  document.querySelectorAll("[data-app]").forEach(
    (b) =>
      (b.onclick = () => {
        const set = new Set(snap.settings.neverApps);
        if (b.dataset.never === "1") set.add(b.dataset.app);
        else set.delete(b.dataset.app);
        api.setSettings({ neverApps: [...set] });
      }),
  );
  if ($("#mic")) $("#mic").onclick = () => api.openPrivacy("mic");
}

// MARK: plumbing

function showTab(name) {
  tab = name;
  document
    .querySelectorAll(".tabs button")
    .forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.tab === name)),
    );
  $("#calls").hidden = name !== "calls";
  $("#settings").hidden = name !== "settings";
  lastKey.settings = lastKey.calls = "";
  render();
}

function render() {
  if (!snap) return;
  renderStatus();
  renderAlerts();
  const settingsKey = JSON.stringify([snap.settings, snap.health, snap.models]);
  if (tab === "settings" && settingsKey !== lastKey.settings) {
    lastKey.settings = settingsKey;
    renderSettings();
  }
  const callsKey = JSON.stringify([
    snap.settings,
    snap.health,
    snap.state.file,
    snap.state.phase === "saved",
  ]);
  if (tab === "calls" && callsKey !== lastKey.calls) {
    lastKey.calls = callsKey;
    // A call was just saved: show it.
    if (snap.state.phase === "saved" && snap.state.file)
      selected = snap.state.file;
    loadCalls();
  }
}

document
  .querySelectorAll(".tabs button")
  .forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
function search(q) {
  query = q.trim();
  reading = null; // re-render the reader so its matches get highlighted
  renderCalls();
}
$("#search").oninput = (e) => search(e.target.value);
api.on("snapshot", (s) => {
  snap = s;
  render();
});
api.on("tab", showTab);
api.on("search", (q) => {
  $("#search").value = q;
  search(q);
});
api.snapshot().then((s) => {
  snap = s;
  render();
});
