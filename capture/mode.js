"use strict";

// quietpls Capture (beta): the Electron side of the opt-in call capture mode.
// Off by default. When turned on, it asks before every call, records you (mic) and
// them (system audio), transcribes locally and commits one markdown file per call to
// a local git repo with no remote. quietpls's monitoring never depends on this file;
// main.js only calls the small API returned by createCaptureMode().
const {
  BrowserWindow,
  Menu,
  nativeImage,
  ipcMain,
  dialog,
  shell,
  screen,
  clipboard,
} = require("electron");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFile } = require("child_process");

const { createDetector } = require("./lib/detector");
const S = require("./lib/state");
const W = require("./lib/whisper");
const repo = require("./lib/repo");
const policy = require("./lib/audio-policy");
const { finishCall, purgeScratch } = require("./lib/pipeline");
const { parseMarkdown, clock } = require("./lib/transcript");
const { dotBitmap } = require("./lib/tray-icon");
const speakers = require("./lib/speakers");
const ambient = require("./lib/ambient");
const { transcriptFiles } = require("./lib/search");
const { startCapture: realStartCapture } = require("./lib/recorder");

const DEFAULTS = {
  enabled: false,
  folder: null,
  model: W.DEFAULT_MODEL,
  keepAudio: false,
  keepDays: 7,
  neverApps: [],
  seenApps: [],
  speakerLabels: false,
  ambientKeepHours: 24,
  // Earlier transcript folders that still hold always-on text: swept until empty.
  ambientFolders: [],
};

// Phases in which the tray shows the capture dot and title instead of the level icon.
const TRAY_PHASES = [
  "asking",
  "recording",
  "transcribing",
  "saved",
  "error",
  "ambient",
];

/**
 * app: Electron app. binDir: where the native helpers live (bin/ or Resources/).
 * getTray(): quietpls's Tray. onTrayReleased(): capture stopped drawing the tray.
 * onMenuChanged(): rebuild the tray menu (capture items come from menuItems()).
 * deps: test doubles for the detector, recorder and transcriber (e2e only).
 */
function createCaptureMode({
  app,
  binDir,
  getTray,
  onTrayReleased = () => {},
  onMenuChanged = () => {},
  deps = {},
}) {
  const DATA = app.getPath("userData");
  const AUDIO_DIR = path.join(DATA, "capture-audio");
  const SCRATCH_DIR = path.join(DATA, "capture-scratch");
  const MODEL_DIR = path.join(DATA, "models");
  const SETTINGS_FILE = path.join(DATA, "capture-settings.json");
  const CAPTURE_BIN = path.join(binDir, "capture");
  const startCapture = deps.startCapture || realStartCapture;
  const transcribe = deps.transcribe || W.transcribe;
  const findWhisper = deps.findWhisper || W.findBinary;
  const checkMic =
    deps.checkMic ||
    (() =>
      new Promise((resolve) => {
        execFile(CAPTURE_BIN, ["--check"], { timeout: 3000 }, (_err, out) => {
          try {
            resolve(JSON.parse(out).mic);
          } catch {
            resolve("unknown");
          }
        });
      }));

  // MARK: settings

  let settings = { ...DEFAULTS };
  try {
    settings = {
      ...DEFAULTS,
      ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")),
    };
  } catch {
    /* first use */
  }
  function saveSettings() {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  }

  // MARK: state

  let state = S.initialState(settings);
  let health = {
    whisper: null,
    modelReady: false,
    mic: "unknown",
    folder: { ok: false, reason: "not-chosen", remotes: [] },
    download: null,
    lastCallSilent: [],
  };
  let levels = { you: 0, them: 0 };
  let capture = null; // { child, wavPath, start, apps }
  let starting = false; // accept() is between the click and launching the recorder
  let callGen = 0; // bumped on every detection change: a consent answers one call
  let ambientActive = false; // session only: never resumes after a relaunch
  let chunkTimer = null;
  let processing = false;
  let quitRequested = false;
  let trayOwned = false;
  let menuKey = "";

  function dispatch(event) {
    const before = state.phase;
    state = S.next(state, event, settings);
    if (state.phase !== before) log(`phase ${before} → ${state.phase}`);
    render();
  }

  function log(msg) {
    console.log(`[capture ${new Date().toISOString().slice(11, 19)}] ${msg}`);
  }

  function snapshot() {
    return {
      state,
      settings,
      health,
      levels,
      home: app.getPath("home"),
      models: W.MODELS.map((m) => ({
        ...m,
        ready: fs.existsSync(W.modelPath(MODEL_DIR, m.id)),
      })),
      elapsed: capture ? (Date.now() - capture.start.getTime()) / 1000 : 0,
    };
  }

  async function refreshHealth() {
    health.whisper = findWhisper();
    health.modelReady = fs.existsSync(W.modelPath(MODEL_DIR, settings.model));
    health.speakerModelReady = fs.existsSync(
      path.join(MODEL_DIR, speakers.MODEL.file),
    );
    health.uv = speakers.findUv();
    health.folder = await repo.checkFolder(settings.folder).catch((e) => ({
      ok: false,
      reason: "missing",
      remotes: [],
      detail: e.message,
    }));
    health.mic = await checkMic();
    render();
  }

  // MARK: windows

  let banner = null;
  let indicator = null;
  let main = null;
  let consent = null;

  function makeWindow(page, opts) {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      ...opts,
    });
    win.loadFile(path.join(__dirname, "renderer", `${page}.html`));
    win.webContents.on("did-finish-load", () =>
      win.webContents.send("snapshot", snapshot()),
    );
    return win;
  }

  function topRight(width, y) {
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - width - 12, y: area.y + y };
  }

  function floating(page, width, height, y) {
    const win = makeWindow(page, {
      width,
      height,
      ...topRight(width, y),
      title: `quietpls capture ${page}`,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: page === "banner",
      hasShadow: true,
      fullscreenable: false,
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    return win;
  }

  // The banner and indicator only exist once capture has been turned on.
  function ensureFloating() {
    if (!banner || banner.isDestroyed())
      banner = floating("banner", 430, 180, 8);
    if (!indicator || indicator.isDestroyed())
      indicator = floating("indicator", 300, 52, 8);
  }

  function openMain(tab) {
    if (!main || main.isDestroyed()) {
      main = makeWindow("main", {
        width: 900,
        height: 600,
        minWidth: 640,
        minHeight: 420,
        title: "quietpls — Transcripts",
        titleBarStyle: "hiddenInset",
        backgroundColor: "#00000000",
        vibrancy: "sidebar",
      });
      main.once("ready-to-show", () => main.show());
      main.on("closed", () => {
        main = null;
      });
    } else {
      main.show();
      main.focus();
    }
    if (!tab) return;
    if (main.webContents.isLoading())
      main.webContents.once("did-finish-load", () =>
        main.webContents.send("tab", tab),
      );
    else main.webContents.send("tab", tab);
  }

  function trayImage(phase) {
    const bmp = dotBitmap(phase);
    const img = nativeImage.createFromBitmap(bmp.buf, {
      width: bmp.size,
      height: bmp.size,
      scaleFactor: 2,
    });
    img.setTemplateImage(bmp.template);
    return img;
  }

  function trayTitle(phase, elapsed) {
    return (
      {
        recording: ` REC ${clock(elapsed)}`,
        transcribing: " Transcribing…",
        asking: " Record call?",
        saved: " Saved",
        error: " Needs attention",
        ambient: ` ALWAYS ON ${capture ? clock(elapsed) : "· transcribing"}`,
      }[phase] || ""
    );
  }

  function render() {
    const snap = snapshot();
    for (const w of [banner, indicator, main])
      if (w && !w.isDestroyed()) w.webContents.send("snapshot", snap);

    const { phase } = state;
    const tray = getTray();
    if (tray) {
      if (TRAY_PHASES.includes(phase)) {
        tray.setImage(trayImage(phase));
        tray.setTitle(trayTitle(phase, snap.elapsed), {
          fontType: "monospacedDigit",
        });
        trayOwned = true;
      } else if (trayOwned) {
        trayOwned = false;
        tray.setTitle("");
        onTrayReleased();
      }
    }

    if (phase === "asking" || TRAY_PHASES.includes(phase)) ensureFloating();
    if (banner && !banner.isDestroyed()) {
      if (phase === "asking" && !banner.isVisible()) {
        banner.showInactive();
        banner.moveTop();
      }
      if (phase !== "asking" && banner.isVisible()) banner.hide();
    }
    if (indicator && !indicator.isDestroyed()) {
      const show =
        ["recording", "transcribing", "saved", "error", "ambient"].includes(
          phase,
        ) &&
        (phase !== "error" || capture || state.startedAt);
      if (show && !indicator.isVisible()) indicator.showInactive();
      if (!show && indicator.isVisible()) indicator.hide();
    }
    const key = JSON.stringify([
      phase,
      state.apps,
      settings.enabled,
      ambientActive,
      Boolean(capture || processing),
    ]);
    if (key !== menuKey) {
      menuKey = key;
      onMenuChanged();
    }
  }

  function phaseWords(phase) {
    return {
      off: "Capture off",
      idle: "Capture on — waiting for a call",
      detected: `Call on (${state.apps.join(", ")}) — not recording`,
      asking: `Call on (${state.apps.join(", ")}) — waiting for your OK`,
      recording: `Recording ${state.apps.join(", ")}`,
      transcribing: "Turning the call into text",
      saved: "Transcript saved",
      error: state.error || "Something went wrong",
      ambient: "ALWAYS ON — microphone + system audio",
    }[phase];
  }

  /** Tray menu items for capture; none until capture is turned on. */
  function menuItems() {
    if (!settings.enabled && !ambientActive && !capture && !processing)
      return [];
    const items = [
      { type: "separator" },
      { label: phaseWords(state.phase), enabled: false },
    ];
    if (state.phase === "recording")
      items.push({ label: "Stop recording", click: () => stopRecording() });
    if (state.phase === "asking")
      items.push(
        { label: "Record this call", click: () => accept() },
        { label: "Not this time", click: () => dispatch({ type: "skip" }) },
      );
    items.push(
      ambientActive
        ? { label: "Stop always-on capture", click: stopAmbient }
        : {
            label: "Always-on capture…",
            click: openConsent,
            enabled: !capture && !processing,
          },
      { label: "View transcripts…", click: () => openMain("calls") },
    );
    return items;
  }

  // MARK: detection (quietpls's meeting detector, a separate instance)

  const ownPids = () => [
    process.pid,
    ...app.getAppMetrics().map((m) => m.pid),
    ...(capture && capture.child.pid ? [capture.child.pid] : []),
  ];

  const detector = createDetector({
    getOwnPids: ownPids,
    ...(app.isPackaged && {
      helperPath: path.join(binDir, "mic-users"),
    }),
    ...(deps.detectorExecFile && { execFile: deps.detectorExecFile }),
    onChange: ({ apps }) => {
      callGen++;
      log(`call apps: ${apps.join(", ") || "(none)"}`);
      if (apps.length) {
        const seen = new Set(settings.seenApps);
        apps.forEach((a) => seen.add(a));
        if (seen.size !== settings.seenApps.length) {
          settings.seenApps = [...seen].sort();
          saveSettings();
        }
      }
      // Consent covers exactly the apps that were on the call when the user said
      // yes: when that set changes (an app joins or leaves, or the call ends), stop
      // and save. Stop first: "stopped" marks this call as handled, so it isn't
      // asked about again until the call ends; the next call is asked about fresh.
      if (capture && !capture.ambient && !sameApps(apps, capture.apps))
        stopRecording();
      dispatch({ type: "call", apps });
      if (apps.length) refreshHealth(); // the banner shows whether recording can start
    },
    // A poll with nobody on the mic ends the consented call, even if the same app
    // is back before the grace runs out: that is a new call, and it is asked about.
    onPoll: ({ apps }) => {
      if (!capture || capture.ambient || capture.end) return;
      if (!apps.length) capture.sawEmpty = true;
      else if (capture.sawEmpty && sameApps(apps, capture.apps)) {
        callGen++;
        log(`call apps: new call on ${apps.join(", ")}`);
        stopRecording();
        dispatch({ type: "call", apps: [] }); // the next detection is asked fresh
        dispatch({ type: "call", apps });
      }
    },
  });

  function sameApps(a, b) {
    return a.length === b.length && a.every((x) => b.includes(x));
  }

  function applyDetection() {
    if (ambientActive || !settings.enabled) detector.stop();
    else detector.start();
  }

  // MARK: recording

  async function accept(isAmbient = false) {
    if (
      capture ||
      processing ||
      starting ||
      (!isAmbient && state.phase !== "asking")
    )
      return;
    starting = true;
    try {
      await startRecording(isAmbient);
    } finally {
      starting = false;
    }
  }

  async function startRecording(isAmbient) {
    // The checks below take seconds; the user may say no, turn capture off or the
    // call may end meanwhile. Only a consent that still stands starts the recorder.
    const gen = callGen;
    const withdrawn = () =>
      isAmbient
        ? !ambientActive
        : !settings.enabled || state.phase !== "asking" || gen !== callGen;
    await refreshHealth();
    if (withdrawn()) {
      log("not recording: consent withdrawn while checking");
      return;
    }
    // "Never" for one app on the call outranks a yes to the others: the recorder
    // takes all system audio, so it would record that app too.
    const never = isAmbient
      ? []
      : state.apps.filter((a) => settings.neverApps.includes(a));
    const blocker = never.length
      ? `Not recorded: ${never.join(" and ")} ${never.length === 1 ? "is" : "are"} set to Never record. Change it in Settings to record calls while ${never.length === 1 ? "it's" : "they're"} on.`
      : !health.folder.ok
        ? health.folder.reason === "has-remote"
          ? "Your transcript folder's repo has a remote, so nothing was recorded. Pick a folder with no remote."
          : "Choose a transcript folder first."
        : !health.whisper
          ? "Speech-to-text isn't installed (brew install whisper-cpp)."
          : !health.modelReady
            ? "Download the speech model first (Settings)."
            : null;
    if (blocker) {
      if (isAmbient) {
        ambientActive = false;
        dispatch({ type: "ambient-off" });
        applyDetection();
      }
      log(`not recording: ${blocker}`);
      dispatch({ type: "skip" });
      // A remote already has its own alert on screen until it's fixed; don't repeat it.
      if (never.length || health.folder.reason !== "has-remote")
        dispatch({ type: "failed", error: blocker });
      openMain("settings");
      return;
    }
    await repo.prepareFolder(settings.folder);
    if (withdrawn()) {
      log("not recording: consent withdrawn while checking");
      return;
    }
    const start = new Date();
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const wavPath = path.join(
      AUDIO_DIR,
      `${isAmbient ? "ambient-" : ""}${start.toISOString().replace(/[:.]/g, "-")}.wav`,
    );
    const exclude = [
      process.pid,
      ...app.getAppMetrics().map((m) => m.pid),
      ...String(process.env.QUIETPLS_CAPTURE_EXCLUDE_PIDS || "")
        .split(",")
        .filter(Boolean)
        .map(Number),
    ];
    const c = {
      wavPath,
      start,
      apps: isAmbient ? [] : [...state.apps],
      saved: null,
      error: null,
      ambient: isAmbient,
      settings: { ...settings },
    };
    c.child = startCapture({
      output: wavPath,
      excludePids: exclude,
      helper: CAPTURE_BIN,
      onMessage: (msg) => {
        if (msg.type === "level") {
          levels = { you: msg.you, them: msg.them };
          return;
        }
        log(`capture: ${JSON.stringify(msg)}`);
        if (msg.type === "saved") c.saved = msg;
        if (msg.type === "error") c.error = msg;
      },
      onStderr: (d) => log(`capture stderr: ${d.trim()}`),
      onExit: onCaptureExit,
    });
    capture = c;
    dispatch({
      type: isAmbient ? "ambient-on" : "accept",
      at: start.getTime(),
    });
    log(`recording → ${wavPath}`);
    if (isAmbient)
      chunkTimer = setTimeout(
        stopRecording,
        ambient.DEFAULTS.chunkSeconds * 1000,
      );
  }

  function stopRecording() {
    if (!capture || capture.end) return;
    clearTimeout(chunkTimer);
    log("stopping recording");
    capture.end = new Date();
    dispatch({ type: "stopped" });
    capture.child.kill("SIGINT");
  }

  function openConsent() {
    if (capture || processing || ambientActive) return;
    if (consent && !consent.isDestroyed()) {
      consent.show();
      return;
    }
    consent = makeWindow("ambient-consent", {
      width: 560,
      height: 650,
      resizable: false,
      title: "Always-on capture — explicit consent",
      parent: main || undefined,
      modal: Boolean(main),
    });
    consent.once("ready-to-show", () => consent.show());
    consent.on("closed", () => {
      consent = null;
    });
  }

  function stopAmbient() {
    ambientActive = false;
    clearTimeout(chunkTimer);
    stopRecording();
    dispatch({ type: "ambient-off" });
    applyDetection();
  }

  const ERRORS = {
    "mic-denied":
      "Microphone access is off. Turn it on in System Settings → Privacy & Security → Microphone.",
    "mic-unavailable": "No microphone was found.",
    "system-audio-unavailable":
      "macOS didn't allow system audio recording. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording.",
  };

  async function onCaptureExit(code) {
    const c = capture;
    capture = null;
    clearTimeout(chunkTimer);
    levels = { you: 0, them: 0 };
    if (!c) return;
    processing = true;
    if (!c.saved) {
      const err = c.error
        ? ERRORS[c.error.code] || c.error.detail
        : `Recording stopped unexpectedly (exit ${code}).`;
      if (c.error && c.error.code === "mic-denied") health.mic = "denied";
      processing = false;
      if (c.ambient) {
        fs.rmSync(c.wavPath, { force: true });
        stopAmbient();
      }
      dispatch({ type: "failed", error: err });
      if (quitRequested) app.quit();
      return;
    }
    if (state.phase === "recording") dispatch({ type: "stopped" });
    health.lastCallSilent = [];
    try {
      const callSettings = c.ambient
        ? ambient.chunkSettings(c.settings)
        : c.settings;
      const modelFile = W.modelPath(MODEL_DIR, callSettings.model);
      const result = await finishCall({
        wavPath: c.wavPath,
        start: c.start,
        end: c.end || new Date(),
        apps: c.apps,
        settings: callSettings,
        model: callSettings.model,
        ambient: c.ambient,
        scratchDir: SCRATCH_DIR,
        transcribeSide: (wav) =>
          transcribe(health.whisper || findWhisper(), modelFile, wav),
        diarizeSide:
          callSettings.speakerLabels && health.speakerModelReady && health.uv
            ? (wavPath, segments) =>
                speakers.diarizeSide({
                  uv: health.uv,
                  model: path.join(MODEL_DIR, speakers.MODEL.file),
                  wavPath,
                  segments,
                })
            : undefined,
      });
      health.lastCallSilent = result.silent;
      log(
        `saved ${result.file} @ ${result.sha}; ${result.lines.length} lines; audio ${result.audioDeleted ? "deleted" : "kept"}`,
      );
      if (!c.ambient || ambientActive)
        dispatch({ type: "saved", file: result.name });
      policy.sweep(AUDIO_DIR, settings);
      sweepAmbientAll(callSettings.folder);
      if (!c.ambient) setTimeout(() => dispatch({ type: "dismiss" }), 8000);
    } catch (e) {
      log(`save failed: ${e.message}`);
      if (c.ambient) {
        fs.rmSync(c.wavPath, { force: true });
        stopAmbient();
      }
      dispatch({
        type: "failed",
        error: `Couldn't save the transcript: ${e.message} ${c.ambient ? "Always-on stopped; audio deleted." : `Audio kept at ${c.wavPath}.`}`,
      });
    }
    purgeScratch(SCRATCH_DIR);
    processing = false;
    await refreshHealth();
    // Capture pauses while each always-on chunk is transcribed, then resumes. The
    // indicator says "transcribing" during this gap; always-on is not gapless.
    if (quitRequested) app.quit();
    else if (c.ambient && ambientActive) await accept(true);
  }

  // MARK: settings + transcripts

  async function updateSettings(patch) {
    settings = { ...settings, ...patch };
    saveSettings();
    // Never for an app on the call being recorded withdraws its consent: stop now.
    if (
      capture &&
      !capture.ambient &&
      capture.apps.some((a) => settings.neverApps.includes(a))
    )
      stopRecording();
    applyDetection();
    dispatch({ type: "settings" });
    await refreshHealth();
  }

  function listTranscripts() {
    const dir = settings.folder;
    if (!dir || !fs.existsSync(dir)) return [];
    return transcriptFiles(dir)
      .map((name) => {
        const text = fs.readFileSync(path.join(dir, name), "utf8");
        const { meta, lines } = parseMarkdown(text);
        return {
          name,
          meta,
          count: lines.length,
          preview: lines
            .slice(0, 2)
            .map((l) => l.text)
            .join(" "),
          text: lines
            .map((l) => l.text)
            .join(" ")
            .toLowerCase(),
        };
      })
      .sort((a, b) =>
        String(b.meta.start || b.name).localeCompare(
          String(a.meta.start || a.name),
        ),
      );
  }

  function transcriptPath(name) {
    const safe = String(name);
    if (!/^(ambient\/)?[^/\\\\]+\.md$/.test(safe) || safe.includes(".."))
      throw new Error("Invalid transcript name");
    return path.join(settings.folder || "", safe);
  }

  /** Expire always-on text in the current folder and in earlier ones that still hold some. */
  function sweepAmbientAll(extra) {
    const hours = settings.ambientKeepHours;
    const pending = [];
    for (const dir of new Set([
      settings.folder,
      extra,
      ...(settings.ambientFolders || []),
    ])) {
      if (!dir) continue;
      try {
        ambient.sweepAmbient(dir, hours);
      } catch (e) {
        log(`ambient sweep ${dir}: ${e.message}`);
      }
      if (dir !== settings.folder && hasAmbientText(dir)) pending.push(dir);
    }
    if (
      JSON.stringify(pending) !== JSON.stringify(settings.ambientFolders || [])
    ) {
      settings.ambientFolders = pending;
      saveSettings();
    }
  }

  function hasAmbientText(dir) {
    const d = path.join(dir, "ambient");
    try {
      return fs.readdirSync(d).some((n) => ambient.OWN_FILE.test(n));
    } catch {
      return false;
    }
  }

  async function setFolder(folder) {
    const previous = settings.folder;
    if (previous && previous !== folder && hasAmbientText(previous))
      settings.ambientFolders = [
        ...new Set([...(settings.ambientFolders || []), previous]),
      ];
    settings.folder = folder;
    const check = await repo
      .prepareFolder(folder)
      .catch((e) => ({ ok: false, detail: e.message }));
    log(
      `folder ${folder}: ${check.ok ? "ok" : check.reason}${check.initialized ? " (git init)" : ""}`,
    );
    await updateSettings({});
  }

  // All capture IPC is namespaced "capture:" so it never meets quietpls's channels.
  const handle = (name, fn) => ipcMain.handle(`capture:${name}`, fn);
  handle("snapshot", () => snapshot());
  // quietpls's Settings window: the "Capture (beta)" section.
  handle("summary", () => summary());
  handle("set-enabled", async (_e, enabled) => {
    await updateSettings({ enabled: enabled === true });
    return summary();
  });
  handle("ambient-dialog", openConsent);
  handle("ambient-cancel", () => {
    if (consent) consent.close();
  });
  handle("ambient-stop", stopAmbient);
  handle("ambient-confirm", async (e, confirmation) => {
    if (
      !consent ||
      e.sender !== consent.webContents ||
      confirmation !== "ALWAYS ON"
    )
      return;
    consent.close();
    ambientActive = true;
    detector.stop();
    await accept(true);
  });
  handle("speaker-download", async () => {
    try {
      await speakers.downloadModel(MODEL_DIR);
    } catch (e) {
      health.speakerError = e.message;
    }
    await refreshHealth();
  });
  handle("speaker-rename", async (_e, name, from, to) => {
    const file = transcriptPath(name);
    const md = speakers.renameSpeaker(fs.readFileSync(file, "utf8"), from, to);
    if (String(name).startsWith("ambient/")) fs.writeFileSync(file, md);
    else
      await repo.saveTranscript(
        settings.folder,
        path.basename(file),
        md,
        `Rename speaker ${from}`,
      );
    return parseMarkdown(md);
  });
  handle("transcripts", () => listTranscripts());
  handle("transcript", (_e, name) => {
    const file = transcriptPath(name);
    return fs.existsSync(file)
      ? parseMarkdown(fs.readFileSync(file, "utf8"))
      : null;
  });
  handle("settings", (_e, patch) => updateSettings(patch));
  handle("choose-folder", async () => {
    const r = await dialog.showOpenDialog(main, {
      title: "Choose where transcripts go",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Use this folder",
    });
    if (r.canceled || !r.filePaths[0]) return;
    await setFolder(r.filePaths[0]);
  });
  handle("download-model", async (_e, id) => {
    if (health.download) return;
    health.download = { id, progress: 0 };
    render();
    try {
      await W.downloadModel(MODEL_DIR, id, (p) => {
        health.download = { id, progress: p };
        render();
      });
      health.download = null;
    } catch (e) {
      health.download = { id, error: e.message };
    }
    await refreshHealth();
  });
  handle("accept", () => accept());
  handle("skip", () => dispatch({ type: "skip" }));
  handle("never", () => {
    settings.neverApps = [
      ...new Set([
        ...settings.neverApps,
        ...S.askableApps(state.apps, settings),
      ]),
    ];
    saveSettings();
    dispatch({ type: "never" });
  });
  handle("stop", () => stopRecording());
  handle("dismiss", () => dispatch({ type: "dismiss" }));
  handle("open-main", (_e, tab) => openMain(tab));
  handle("reveal", (_e, name) => shell.showItemInFolder(transcriptPath(name)));
  handle("copy", (_e, text) => clipboard.writeText(text));
  handle("open-privacy", (_e, pane) =>
    shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${pane === "audio" ? "Privacy_ScreenCapture" : "Privacy_Microphone"}`,
    ),
  );
  handle("refresh", () => refreshHealth());
  // The banner sizes itself to its content (it grows when it has to explain a problem).
  handle("fit", (e, height) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.setSize(win.getSize()[0], Math.ceil(height));
  });

  // MARK: dev control (QUIETPLS_CAPTURE_DEV=<fifo>, unpackaged only): line commands
  // used by the scripted simulated-meeting run and the UI-state screenshots.

  function devControl(fifo) {
    const wins = () => ({
      banner,
      indicator,
      main,
      consent,
      // quietpls's own Settings window
      settings: BrowserWindow.getAllWindows().find((b) =>
        b.webContents.getURL().endsWith("/settings.html"),
      ),
    });
    readline
      .createInterface({ input: fs.createReadStream(fifo) })
      .on("line", async (line) => {
        const [cmd, ...rest] = line.trim().split(/\s+/);
        try {
          if (cmd === "shot") {
            const w = wins()[rest[0]];
            const img = await w.webContents.capturePage();
            fs.writeFileSync(rest[1], img.toPNG());
            log(`shot ${rest[0]} → ${rest[1]}`);
          } else if (cmd === "shot-tray") {
            // The menubar can't be screen-captured from here, so draw the exact icon
            // bitmap + title the tray has right now onto a menubar-colored strip.
            const bmp = dotBitmap(state.phase);
            const icon = trayImage(state.phase).toDataURL();
            const title = getTray() ? getTray().getTitle() : "";
            const win = new BrowserWindow({
              show: false,
              width: 260,
              height: 30,
              webPreferences: { offscreen: true },
            });
            const html = `<body style="margin:0;background:#2b2b2e;color:#fff;font:13px -apple-system,system-ui;display:flex;align-items:center;justify-content:flex-end;height:30px;padding-right:12px;gap:4px;font-variant-numeric:tabular-nums"><img src="${icon}" style="width:18px;height:18px;${bmp.template ? "filter:invert(1)" : ""}"><span>${title}</span></body>`;
            await win.loadURL(
              `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
            );
            await new Promise((r) => setTimeout(r, 300));
            fs.writeFileSync(
              rest[0],
              (await win.webContents.capturePage()).toPNG(),
            );
            win.destroy();
            log(`shot tray (${state.phase}, "${title}") → ${rest[0]}`);
          } else if (cmd === "click") {
            const ok = await wins()[rest[0]].webContents.executeJavaScript(
              `(() => { const b = document.querySelector(${JSON.stringify(rest.slice(1).join(" "))}); if (!b) return false; b.click(); return true; })()`,
            );
            log(`click ${rest.join(" ")}: ${ok ? "ok" : "not found"}`);
          } else if (cmd === "scroll") {
            await wins()[rest[0]].webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(rest.slice(1).join(" "))}).scrollIntoView()`,
            );
          } else if (cmd === "quietpls-settings") ipcMain.emit("open-settings");
          else if (cmd === "open") openMain(rest[0]);
          else if (cmd === "refresh") await refreshHealth();
          else if (cmd === "folder") await setFolder(rest.join(" "));
          else if (cmd === "set")
            await updateSettings(JSON.parse(rest.join(" ")));
          else if (cmd === "exclude")
            process.env.QUIETPLS_CAPTURE_EXCLUDE_PIDS = rest.join(","); // test players kept out of "them"
          else if (cmd === "accept") await accept();
          else if (cmd === "stop") stopRecording();
          else if (cmd === "state")
            log(
              `state ${JSON.stringify(state)} health ${JSON.stringify(health)}`,
            );
          else if (cmd === "quit") app.quit();
        } catch (e) {
          log(`dev ${cmd} failed: ${e.message}`);
        }
      });
  }

  // MARK: lifecycle

  function start() {
    applyDetection();
    refreshHealth().catch((e) => log(`health: ${e.message}`));
    policy.sweep(AUDIO_DIR, settings);
    // A crash cannot run shutdown cleanup; remove interrupted always-on audio on relaunch.
    if (fs.existsSync(AUDIO_DIR))
      for (const n of fs.readdirSync(AUDIO_DIR)) {
        if (n.startsWith("ambient-") && n.endsWith(".wav"))
          fs.rmSync(path.join(AUDIO_DIR, n), { force: true });
      }
    // Per-side audio and whisper output left by a crash mid-transcription.
    purgeScratch(SCRATCH_DIR);
    sweepAmbientAll();
    setInterval(() => sweepAmbientAll(), 60 * 1000);
    setInterval(() => {
      if (capture || ambientActive) render();
    }, 1000);
    setInterval(() => {
      if (capture && indicator && indicator.isVisible())
        indicator.webContents.send("levels", levels);
    }, 120);
    const fifo = process.env.QUIETPLS_CAPTURE_DEV;
    if (fifo && !app.isPackaged) devControl(fifo);
    app.on("before-quit", (e) => {
      if (!capture && !processing) return;
      e.preventDefault();
      quitRequested = true;
      ambientActive = false;
      clearTimeout(chunkTimer);
      stopRecording(); // onCaptureExit finishes/deletes audio, then quits
    });
    log(`ready; capture ${settings.enabled ? "on" : "off"}`);
  }

  function summary() {
    return {
      enabled: settings.enabled,
      folder: settings.folder,
      phase: state.phase,
      ambient: ambientActive,
      setupDone: Boolean(
        health.whisper && health.modelReady && health.folder.ok,
      ),
    };
  }

  return {
    start,
    menuItems,
    openTranscripts: (tab = "calls") => openMain(tab),
    /** True while capture draws the tray (recording, asking, ...). */
    ownsTray: () => trayOwned,
    /** The capture helper's pid while recording: quietpls's own process, not a call. */
    helperPids: () => (capture && capture.child.pid ? [capture.child.pid] : []),
    summary,
  };
}

module.exports = { createCaptureMode, DEFAULTS };
