// Setup window (S5): Welcome · Microphone · Check your mic.
// Vanilla JS, loaded via <script> tag in onboarding.html.
//
// The macOS microphone prompt appears only after Continue on step 2 (B2).
// Step 2 is skipped when access is already granted (B3). Access off or
// managed stays a recoverable state here; the window re-checks access when it
// regains focus and moves on without a restart (B4).

// The check only confirms the mic hears you; it never rates the voice.
const HEARING_MIN_VOLUME = 20; // computeRmsVolume scale, ~1% RMS
const HEARING_HOLD_MS = 800; // keep "Mic is responding" through short gaps

// ---- Pure helpers (exported for testing via globalThis) ----

/** Panel for a microphone status once the user is past Welcome. */
function panelForStatus(status) {
  return (
    {
      granted: "check",
      denied: "off",
      restricted: "managed",
      "not-determined": "ask",
    }[status] || "error"
  );
}

/**
 * First panel. A real first run always starts at Welcome; Voice Setup…
 * (`?step=check`) opens the mic check, or the access state that blocks it.
 */
function resolveInitialPanel(status, step) {
  return step === "check" ? panelForStatus(status) : "welcome";
}

/** One-time announcement for a microphone status change. */
function statusAnnouncement(status) {
  switch (status) {
    case "granted":
      return "Microphone ready";
    case "denied":
      return "Microphone access is off.";
    case "restricted":
      return "Microphone access is managed by your organization.";
    case "not-determined":
      return "";
    default:
      return "Couldn’t check microphone access. Try again.";
  }
}

/** Explanation under the mic name when Automatic avoids a Bluetooth mic. */
function micNote(choice, devices) {
  if (!choice || choice.reason !== "avoid-bluetooth") return "";
  const airpods = (devices || []).some((d) => /airpods/i.test(d.label || ""));
  return airpods
    ? "Automatic keeps AirPods audio clear by using this mic."
    : "Automatic keeps Bluetooth audio clear by using this mic.";
}

/**
 * Compute RMS volume (0-100) from an AnalyserNode's time-domain data.
 * This mirrors the volume-processor.js piecewise mapping.
 * @param {Uint8Array} timeDomainData - getByteTimeDomainData output (0-255, 128 = silence)
 * @returns {number} Normalized volume 0-100
 */
function computeRmsVolume(timeDomainData) {
  if (!timeDomainData || timeDomainData.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    const normalized = (timeDomainData[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / timeDomainData.length) * 100;

  // Piecewise linear mapping matching volume-processor.js
  let volume;
  if (rms < 0.3) {
    volume = rms * 16.67;
  } else if (rms < 1) {
    volume = 5 + ((rms - 0.3) / 0.7) * 15;
  } else if (rms < 2) {
    volume = 20 + ((rms - 1) / 1) * 15;
  } else if (rms < 3.5) {
    volume = 35 + ((rms - 2) / 1.5) * 30;
  } else if (rms < 5) {
    volume = 65 + ((rms - 3.5) / 1.5) * 20;
  } else {
    volume = 85 + Math.min((rms - 5) * 10, 15);
  }
  return Math.min(100, Math.max(0, volume));
}

/**
 * Whether to say "Mic is responding": input now, or within HEARING_HOLD_MS.
 * @returns {{ hearing: boolean, lastHeardAt: number|null }}
 */
function updateHearing(volume, now, lastHeardAt) {
  const heardAt = volume >= HEARING_MIN_VOLUME ? now : lastHeardAt;
  return {
    hearing: heardAt !== null && now - heardAt <= HEARING_HOLD_MS,
    lastHeardAt: heardAt,
  };
}

if (typeof globalThis !== "undefined") {
  globalThis.__onboardingHelpers = {
    panelForStatus,
    resolveInitialPanel,
    statusAnnouncement,
    micNote,
    computeRmsVolume,
    updateHearing,
  };
}

// ---- DOM wiring (only runs in browser with a document) ----

if (typeof document === "undefined") {
  if (typeof module !== "undefined") module.exports = {};
} else {
  const api = window.electronAPI || {};
  const $ = (id) => document.getElementById(id);
  const panels = () => [...document.querySelectorAll("[data-panel]")];

  let panel = null;
  let sawAsk = false; // Back from the check returns to step 2 only if it was shown
  let settings = null;
  let level = null; // { ctx, stream, frame }
  let announcedHearing = false;

  function announce(text) {
    if (text) $("announce").textContent = text;
  }

  function show(name) {
    if (name === panel) return;
    if (panel === "check") stopLevel();
    panel = name;
    if (name === "ask") sawAsk = true;
    let el = null;
    for (const p of panels()) {
      p.hidden = p.dataset.panel !== name;
      if (!p.hidden) el = p;
    }
    const step = el.dataset.step;
    const count = $("stepCount");
    count.textContent = step + " of 3";
    count.setAttribute("aria-valuenow", step);
    $("skipBtn").hidden = name === "managed";
    const primary = el.querySelector(".btn.primary");
    if (primary) primary.focus();
    if (name === "check") startLevel();
    resize();
  }

  function resize() {
    requestAnimationFrame(() => {
      if (api.setupResize) api.setupResize(document.documentElement.scrollHeight);
    });
  }

  async function readStatus() {
    try {
      return await api.getMicrophoneStatus();
    } catch (_) {
      return "error";
    }
  }

  // On every status from main (focus, request) or Check again: step 2 moves
  // on by itself once macOS allows the mic; the check falls back if it goes.
  async function onStatus(status) {
    const next = panelForStatus(status);
    if (panel === "welcome" || next === panel) return;
    announce(statusAnnouncement(status));
    show(next);
  }

  function close(data) {
    stopLevel();
    if (api.onboardingComplete) api.onboardingComplete(data);
  }

  async function onContinue() {
    const btn = $("continueBtn");
    btn.disabled = true;
    $("askStatus").textContent = "Waiting for microphone access…";
    let status;
    try {
      status = await api.requestMicrophoneAccess();
    } catch (_) {
      status = "error";
    }
    btn.disabled = false;
    $("askStatus").textContent = "";
    announce(statusAnnouncement(status));
    show(panelForStatus(status));
  }

  // ---- Live level for the actual mic ----

  async function chooseMic() {
    const MP = window.MicPolicy;
    const preferred = (settings && settings.audioDeviceId) || "";
    if (!MP) return { deviceId: preferred, label: "", reason: "explicit" };
    return MP.resolveChoice(
      navigator.mediaDevices,
      api.getInputTransports ? () => api.getInputTransports() : null,
      preferred,
    );
  }

  async function fillMicMenu() {
    const select = $("micSelect");
    let devices = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications",
      );
    } catch (_) {
      devices = [];
    }
    const current = (settings && settings.audioDeviceId) || "";
    select.replaceChildren(
      new Option("Automatic", "", false, current === ""),
      ...devices.map((d) => new Option(d.label || "Unnamed mic", d.deviceId, false, d.deviceId === current)),
    );
    return devices;
  }

  function setHearing(hearing) {
    $("hearChip").classList.toggle("on", hearing);
    $("hearChip").querySelector("use").setAttribute("href", hearing ? "#g-listen" : "#g-off");
    $("hearLabel").textContent = hearing ? "Mic is responding" : "Waiting for input";
    if (hearing && !announcedHearing) {
      announcedHearing = true;
      announce("Mic is responding");
    }
  }

  function setLevel(volume) {
    $("levelFill").style.width = Math.round(volume) + "%";
    $("levelFill").parentElement.setAttribute("aria-valuenow", String(Math.round(volume)));
  }

  async function startLevel() {
    stopLevel();
    const token = (level = {});
    setHearing(false);
    setLevel(0);
    $("micError").hidden = true;
    $("hearChip").hidden = false;
    try {
      if (!settings && api.getSettings) settings = await api.getSettings();
      const devices = await fillMicMenu();
      const choice = await chooseMic();
      const MP = window.MicPolicy;
      const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: MP ? MP.audioConstraints(choice, base) : base,
      });
      if (level !== token) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = stream.getAudioTracks()[0];
      $("micName").textContent = (track && track.label) || choice.label || "Unnamed mic";
      const note = micNote(choice, devices);
      $("micNote").textContent = note;
      $("micNote").hidden = !note;
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      Object.assign(token, { ctx, stream });
      const data = new Uint8Array(analyser.fftSize);
      let lastHeardAt = null;
      let shown = false;
      const poll = () => {
        if (level !== token) return;
        analyser.getByteTimeDomainData(data);
        const volume = computeRmsVolume(data);
        const h = updateHearing(volume, performance.now(), lastHeardAt);
        lastHeardAt = h.lastHeardAt;
        setLevel(volume);
        if (h.hearing !== shown) setHearing((shown = h.hearing));
        token.frame = requestAnimationFrame(poll);
      };
      poll();
    } catch (_) {
      if (level !== token) return;
      const status = await readStatus();
      if (status !== "granted") return onStatus(status);
      // Access is on but the mic will not start.
      $("hearChip").hidden = true;
      $("micError").hidden = false;
      announce("Couldn’t start the mic. Check System Settings.");
    }
    resize();
  }

  function stopLevel() {
    if (!level) return;
    if (level.frame) cancelAnimationFrame(level.frame);
    if (level.stream) level.stream.getTracks().forEach((t) => t.stop());
    if (level.ctx) level.ctx.close().catch(() => {});
    level = null;
  }

  function onMicChange() {
    const audioDeviceId = $("micSelect").value;
    settings = Object.assign({}, settings, { audioDeviceId });
    if (api.updateSettings) {
      api.updateSettings({ sensitivity: settings.sensitivity, audioDeviceId });
    }
    startLevel();
  }

  // ---- Wiring ----

  document.addEventListener("DOMContentLoaded", async () => {
    $("getStartedBtn").addEventListener("click", async () => show(panelForStatus(await readStatus())));
    $("continueBtn").addEventListener("click", onContinue);
    $("setVoiceBtn").addEventListener("click", () => {
      stopLevel();
      if (api.setNormalVoice) api.setNormalVoice();
    });
    $("micSelect").addEventListener("change", onMicChange);
    document.querySelectorAll("[data-back]").forEach((b) =>
      b.addEventListener("click", () => show(panel === "check" && sawAsk ? "ask" : "welcome")),
    );
    document.querySelectorAll("[data-later]").forEach((b) =>
      b.addEventListener("click", () => close({ startMonitoring: false })),
    );
    document.querySelectorAll("[data-open-settings]").forEach((b) =>
      b.addEventListener("click", () => api.openSystemSettings && api.openSystemSettings()),
    );
    document.querySelectorAll("[data-check-again]").forEach((b) =>
      b.addEventListener("click", async () => onStatus(await readStatus())),
    );

    // Return = primary, Escape = Set up later (Close when managed).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close({ startMonitoring: false });
      } else if (e.key === "Enter" && !e.target.closest("button, select, a, label")) {
        const primary = document.querySelector("[data-panel]:not([hidden]) .btn.primary");
        if (primary && !primary.disabled) {
          e.preventDefault();
          primary.click();
        }
      }
    });

    // main.js sends the status on every window focus and after a request.
    if (api.onMicrophoneStatusChanged) api.onMicrophoneStatusChanged(onStatus);
    if (api.onCloseWindow) {
      api.onCloseWindow(() => {
        stopLevel();
        window.close();
      });
    }
    window.addEventListener("beforeunload", stopLevel);

    const step = new URLSearchParams(location.search).get("step");
    show(resolveInitialPanel(step === "check" ? await readStatus() : null, step));
  });
}
