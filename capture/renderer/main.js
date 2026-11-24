"use strict";

const api = window.qpc;
let snap = null;
let tab = "calls";
let calls = [];
let selected = null;
let query = "";
let lastKey = { settings: "", calls: "", alerts: "" };

const STATUS = {
  off: ["Call prompts off", "Turn on"],
  idle: ["Waiting for a call", null],
  detected: ["Not recording this call", null],
  asking: ["Record this call?", "Record"],
  recording: ["Recording", "Stop"],
  transcribing: ["Transcribing…", null],
  saved: ["Transcript saved", "View"],
  error: ["Check recording", null],
  ambient: ["ALWAYS ON · mic + system audio", "Stop"],
};

const glyph = (id) =>
  `<svg class="g" aria-hidden="true"><use href="#g-${id}"></use></svg>`;

// The one Terminal command in the UI, with a Copy button (installing it for you is Later).
const command = (cmd) =>
  `<span class="cmd">${esc(cmd)}</span> <button class="sm" data-copy="${esc(cmd)}">Copy</button>`;

function setupDone(s) {
  return Boolean(s.health.whisper && s.health.modelReady && s.health.folder.ok);
}

// MARK: header status — every phase readable at a glance

function renderStatus() {
  const { phase, apps, file } = snap.state;
  // Waiting only once setup is complete; until then the chip says what's missing.
  const [text, wanted] =
    phase === "idle" && !setupDone(snap) ? ["Set up transcripts", null] : STATUS[phase];
  const action = phase === "off" && !setupDone(snap) ? null : wanted;
  $("#status").className = `cstatus ${phase}`;
  $("#status-dot").className = `dot ${phase}`;
  const appText =
    apps.length && ["detected", "asking", "recording"].includes(phase)
      ? ` · ${apps.join(", ")}`
      : "";
  $("#status-text").textContent =
    phase === "recording"
      ? `${snap.micOnly ? "Recording mic only" : "Recording"} ${clock(snap.elapsed)}${appText}`
      : text + appText;
  const btn = $("#status-action");
  btn.hidden = !action;
  btn.textContent = action || "";
  btn.className =
    phase === "recording" || phase === "ambient"
      ? "sm danger"
      : phase === "asking" || phase === "off"
        ? "sm primary"
        : "sm";
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
  // Plain text (rendered with textContent): file names and remotes are never markup.
  if (state.phase === "error" && state.error)
    out.push({
      kind: "bad",
      text: state.error,
      action: ["Dismiss", () => api.dismiss()],
    });
  if (health.folder.reason === "has-remote") {
    out.push({
      kind: "bad",
      text: `Capture can’t save to ${tilde(settings.folder, home)} because it syncs to an online code repository. Choose another folder.`,
      action: ["Choose folder…", () => api.chooseFolder()],
    });
  } else if (health.folder.reason === "missing") {
    out.push({
      kind: "bad",
      text: `Transcript folder not found: ${tilde(settings.folder, home)}`,
      action: ["Choose folder…", () => api.chooseFolder()],
    });
  }
  if (health.mic === "denied")
    out.push({
      kind: "bad",
      text: "Microphone access is off. Turn on quietpls in System Settings → Privacy & Security → Microphone.",
      action: ["Open System Settings", () => api.openPrivacy("mic")],
    });
  if (!health.whisper && setupStarted())
    out.push({
      kind: "warn",
      text: "Install speech-to-text. In Terminal, run brew install whisper-cpp, then choose Check again.",
      action: ["Check again", () => api.refresh()],
    });
  if (health.lastCallMicOnly)
    out.push({
      kind: "warn",
      text: `Call audio unavailable for ${health.lastCallMicOnly}. Only your microphone was recorded.`,
    });
  else if ((health.lastCallSilent || []).includes("them"))
    out.push({
      kind: "warn",
      text: "No call audio was captured in the last recording. Check Screen & System Audio Recording in System Settings.",
      action: ["Open System Settings", () => api.openPrivacy("audio")],
    });
  return out;
}

function setupStarted() {
  return setupDone(snap) || snap.settings.folder;
}

function renderAlerts() {
  const list = alerts();
  const key = JSON.stringify(list.map((a) => a.text));
  if (key === lastKey.alerts) return;
  lastKey.alerts = key;
  const box = $("#alerts");
  box.innerHTML = "";
  for (const a of list) {
    const el = document.createElement("div");
    el.className = `alert ${a.kind}`;
    el.innerHTML = `${glyph(a.kind === "bad" ? "x" : "unsure")}<span class="msg"></span>`;
    el.querySelector(".msg").textContent = a.text;
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
        <span class="p muted">${esc(when(c.meta))} · ${snippet(c) ? mark(snippet(c)) : "No transcript text"}</span></li>`,
        )
        .join("")
    : `<li class="none">${calls.length ? `No transcripts match “${esc(query)}”. Try another search.` : "No transcripts yet"}</li>`;
  rows
    .querySelectorAll(".row")
    .forEach((r) => (r.onclick = () => select(r.dataset.name)));
  if (!calls.length) {
    reading = null;
    reader.innerHTML = `<div class="empty"><h2 class="rd">No transcripts yet</h2>
      <p>When a call is detected, choose Record this call. Its transcript appears here after recording stops.</p>
      <p>${snap.settings.enabled ? "Call prompts are on." : "Call prompts are off. Choose Turn on to enable them."}</p></div>`;
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
    reader.innerHTML = `<div class="empty"><h2 class="rd">Transcript file not found</h2><p>${esc(name)}</p></div>`;
    return;
  }
  const m = t.meta;
  const channel = (who) => (who === "you" ? "You" : "Call audio");
  reader.innerHTML = `<h1 class="rd">${esc(m.title || name)}</h1>
    <div class="meta"><span>${esc(when(m))}</span>·<span class="num">${esc(dur(m.duration))}</span>·<span>${esc((m.apps || []).join(", "))}</span>·<span>Audio: ${esc(m.audio || "")}</span>
      <span class="tools"><button id="copy" class="sm">Copy text</button><button id="reveal" class="sm">Show in Finder</button></span></div>
    ${t.notes.map((n) => `<p class="tnote">${esc(n)}</p>`).join("")}
    <div class="lines">${t.lines.map((l) => `<span class="at">${esc(l.at)}</span><span class="who ${l.who}">${l.speaker ? `<button class="speaker" data-speaker="${esc(l.speaker)}" title="Rename speaker · ${channel(l.who)}">${esc(l.speaker)}</button>` : channel(l.who)}</span><span>${mark(l.text)}</span>`).join("")}</div>`;
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
        // A failed rename says why beside the field and keeps what was typed (AC-I7).
        const why = document.createElement("span");
        why.className = "rename-error";
        why.setAttribute("role", "alert");
        input.after(why);
        input.onkeydown = async (e) => {
          if (e.key === "Escape") return select(name);
          if (e.key !== "Enter") return;
          input.disabled = true;
          try {
            await api.speakerRename(name, from, input.value);
            await select(name);
          } catch (err) {
            input.disabled = false;
            why.textContent = renameError(err);
            input.focus();
          }
        };
      }),
  );
}

// "Error invoking remote method 'capture:speaker-rename': Error: Enter a speaker name" → readable.
function renameError(err) {
  const detail = String((err && err.message) || err || "").replace(
    /^Error invoking remote method \S+: (?:\w*Error: )?/,
    "",
  );
  return `Couldn’t rename speaker. ${detail}`.trim();
}

function setupHtml() {
  const { health, settings, home, models } = snap;
  const model = models.find((m) => m.id === settings.model) || models[0];
  const dl = health.download;
  const folderBad =
    health.folder.reason === "has-remote" || health.folder.reason === "missing";
  const steps = [
    {
      state: health.whisper ? "done" : "",
      what: "Install speech-to-text",
      why: health.whisper
        ? `<span title="${esc(health.whisper)}">Installed</span>`
        : `quietpls uses the free whisper-cpp tool to turn calls into text. Install it once in Terminal with Homebrew:<br>${command("brew install whisper-cpp")}`,
      action: health.whisper
        ? ""
        : '<button class="sm" data-do="refresh">Check again</button>',
    },
    {
      state: health.modelReady ? "done" : dl && dl.error ? "bad" : "",
      what: `Download transcription data · ${esc(model.size)}`,
      why: health.modelReady
        ? "Transcription data ready"
        : dl && dl.error
          ? `Couldn’t download. Try again. ${esc(dl.error)}`
          : "Downloaded once, then used for every call.",
      action: health.modelReady
        ? ""
        : dl && !dl.error
          ? `<progress max="1" value="${dl.progress}"></progress>`
          : '<button class="sm primary" data-do="download">Download</button>',
    },
    {
      state: health.folder.ok ? "done" : folderBad ? "bad" : "",
      what: "Choose a transcript folder",
      why: health.folder.ok
        ? `<span title="${esc(tilde(settings.folder, home))}">${esc(shortPath(settings.folder, home))}</span>`
        : folderBad
          ? "Choose a folder that exists and doesn’t sync to an online code repository"
          : "Saves each call transcript as a text file. Choose a folder that doesn’t sync to an online code repository.",
      action: `<button class="sm${health.folder.ok ? "" : " primary"}" data-do="folder">${health.folder.ok ? "Change…" : "Choose…"}</button>`,
    },
    {
      state: settings.enabled ? "done" : "",
      what: "Turn on call prompts",
      why: settings.enabled
        ? "On. Choose which detected calls to record."
        : "Call recording starts only after you choose Record this call.",
      action: settings.enabled
        ? ""
        : `<button ${setupDone(snap) ? 'class="sm primary"' : 'class="sm" disabled'} data-do="enable">Turn on</button>`,
    },
  ];
  // Lead with the next missing step; finished steps follow in their usual order.
  const ordered = [
    ...steps.filter((s) => s.state !== "done"),
    ...steps.filter((s) => s.state === "done"),
  ];
  const icon = { done: glyph("ok"), bad: glyph("x"), "": glyph("off") };
  return `<div class="setup">
    <h2 class="rd">${setupDone(snap) ? "Ready for call transcripts" : "Set up transcripts"}</h2>
    <p class="sub">Choose which calls to record. Capture creates a transcript on this Mac and saves it to your folder. Only you see the recording prompt; quietpls doesn’t notify the other people on the call.</p>
    <ol class="steps">${ordered
      .map(
        (s) => `<li class="${s.state}">${icon[s.state]}
      <div class="l"><div class="what">${s.what}</div><div class="why">${s.why}</div></div><div class="act">${s.action}</div></li>`,
      )
      .join("")}</ol>
    <p class="privacy">By default, audio is deleted after the transcript is saved.</p>
  </div>`;
}

function wireCopy() {
  document
    .querySelectorAll("[data-copy]")
    .forEach((b) => (b.onclick = () => api.copy(b.dataset.copy)));
}

function wireSetup() {
  wireCopy();
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
    ? '<span class="muted">No folder selected</span>'
    : health.folder.ok
      ? '<span class="ok">✓ Ready. Saves transcripts on this Mac.</span>'
      : health.folder.reason === "has-remote"
        ? '<span class="bad">✗ This folder syncs to an online code repository. Choose another folder.</span>'
        : '<span class="bad">✗ Folder not found</span>';
  const apps = [
    ...new Set([...(settings.seenApps || []), ...(settings.neverApps || [])]),
  ].sort();
  $("#settings").innerHTML = `
    <section><h3>Call recording</h3><div class="body">
      <label class="switch"><input type="checkbox" role="switch" id="enabled" ${settings.enabled ? "checked" : ""}> Ask to record calls</label>
      <span class="hint">${settings.enabled ? "Prompts when a call is detected. Recording starts after you approve." : "Call prompts are off. Always-on recording is controlled separately."}</span>
    </div></section>
    <section><h3>Always-on recording</h3><div class="body">
      <div><button id="ambient" class="sm${snap.state.phase === "ambient" ? " danger" : ""}">${snap.state.phase === "ambient" ? "Stop always-on recording" : "Set up always-on…"}</button></div>
      <span class="hint">Records mic and system audio beyond calls after a separate confirmation. These transcripts are deleted after 24 hours by default and never added to the folder’s history. Audio is deleted after processing.</span>
    </div></section>
    <section><h3>Speaker labels</h3><div class="body">
      <label class="switch"><input id="speakers" type="checkbox" role="switch" ${settings.speakerLabels ? "checked" : ""} ${!health.speakerModelReady || !health.uv ? "disabled" : ""}> Add speaker labels</label>
      <span class="hint">${health.speakerModelReady ? "Speaker labeling ready · 26 MB" : '<button id="speaker-download" class="sm">Download speaker labeling · 26 MB</button>'}</span>
      <span class="hint">${health.uv ? "Setup downloads the required tools. Speaker labeling then runs on this Mac." : "In Terminal, run brew install uv first. " + command("brew install uv")}</span>
      <span class="hint">Call voices get Speaker 1, Speaker 2, and so on. The main mic voice is You. Select a label to rename it, then press Return. One person may receive more than one label.</span>
      ${health.speakerError ? `<span class="bad">Couldn’t set up speaker labels. ${esc(health.speakerError)}</span>` : ""}
    </div></section>
    <section><h3>Transcript folder</h3><div class="body">
      <span class="path" title="${esc(tilde(settings.folder, home))}">${esc(shortPath(settings.folder, home)) || "—"}</span>${folderLine}
      <div><button id="folder" class="sm">Choose folder…</button></div>
      <span class="hint">Each call transcript is a text file on this Mac, and the folder keeps its version history. Capture won’t use a folder that syncs to an online code repository.</span>
    </div></section>
    <section><h3>Transcription</h3><div class="body">
      <div class="models">${models
        .map(
          (m) => `
        <input type="radio" name="model" value="${m.id}" id="m-${m.id}" ${m.id === settings.model ? "checked" : ""}>
        <label for="m-${m.id}">${esc(m.label)} <span class="muted">· ${esc(m.size)}</span></label>
        <span>${m.ready ? '<span class="ok">✓ Ready</span>' : dl && dl.id === m.id && !dl.error ? `<progress max="1" value="${dl.progress}"></progress>` : `<button class="sm" data-dl="${m.id}">Download</button>`}</span>`,
        )
        .join("")}
      </div>
      ${dl && dl.error ? `<span class="bad">Couldn’t download. Try again. ${esc(dl.error)}</span>` : ""}
      <span class="hint">${health.whisper ? "Speech-to-text installed · " + esc(health.whisper) : "Install speech-to-text: run brew install whisper-cpp in Terminal. " + command("brew install whisper-cpp")}</span>
      <span class="hint">Transcription data downloads once and stays on this Mac in ~/Library/Application Support/quietpls/models. Calls are transcribed here.</span>
    </div></section>
    <section><h3>Audio retention</h3><div class="body">
      <label class="choice"><input type="radio" name="keep" value="no" ${settings.keepAudio ? "" : "checked"}> Delete audio after transcript is saved (default)</label>
      <label class="choice"><input type="radio" name="keep" value="yes" ${settings.keepAudio ? "checked" : ""}> Keep audio for <input type="number" id="days" min="1" max="365" value="${settings.keepDays}" aria-label="Days to keep audio"> days, then delete</label>
      <span class="hint">Kept audio is stored on this Mac, separate from your transcripts.</span>
    </div></section>
    <section><h3>Call apps</h3><div class="body">
      ${
        apps.length
          ? `<div class="apps">${apps
              .map((a) => {
                const never = settings.neverApps.includes(a);
                return `<span>${esc(a)}</span><span class="seg2"><button data-app="${esc(a)}" data-never="0" aria-pressed="${!never}">Ask</button><button data-app="${esc(a)}" data-never="1" aria-pressed="${never}">Never</button></span>`;
              })
              .join("")}</div>`
          : '<span class="muted">Apps appear here when quietpls detects them using the mic.</span>'
      }
      <span class="hint">Never blocks call recording while that app is detected. It doesn’t apply to always-on recording.</span>
    </div></section>
    <section><h3>Permissions</h3><div class="body">
      <span>Microphone: ${health.mic === "granted" ? '<span class="ok">✓ Allowed</span>' : health.mic === "denied" ? '<span class="bad">✗ Off</span> <button id="mic" class="sm">Open System Settings</button>' : '<span class="muted">macOS may ask for access when the mic starts</span>'}</span>
      <span>System audio: <span class="muted">macOS may request System Audio Recording access when Capture starts</span></span>
    </div></section>`;
  wireCopy();
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
