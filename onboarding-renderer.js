// Onboarding window renderer — US-019 Welcome + Mic Permission (Steps 1-2)
// Vanilla JS, loaded via <script> tag in onboarding.html

// ---- State ----
let currentStep = 1;
const TOTAL_STEPS = 3;
let micPermissionGranted = false;
let transitioning = false;

// ---- Demo audio state ----
let demoAudioCtx = null;
let demoStream = null;
let demoAnalyser = null;
let demoAnimFrameId = null;

// The demo only confirms the mic hears you; it never rates the voice.
const HEARING_MIN_VOLUME = 20; // computeRmsVolume scale, ~1% RMS
const HEARING_HOLD_MS = 800; // keep "Hearing you" through short gaps

// ---- Pure helpers (exported for testing via globalThis) ----

/**
 * Determine which step the user should land on based on permission state.
 * @param {'granted'|'denied'|'restricted'|'not-determined'|'unknown'} permState
 * @returns {number} step number (1, 2, or 3)
 */
function resolveInitialStep(permState) {
  if (permState === "granted") return 3;
  return 1;
}

/**
 * Decide button visibility/state for a given step.
 * @param {number} step
 * @param {boolean} hasMicPermission
 * @returns {{ back: 'hidden'|'visible', skip: 'hidden'|'visible', allowMic: boolean, nextDisabled: boolean }}
 */
function resolveStepButtons(step, hasMicPermission) {
  return {
    back: step > 1 ? "visible" : "hidden",
    skip: step < TOTAL_STEPS ? "visible" : "hidden",
    allowMic: step === 2 && !hasMicPermission,
    nextDisabled: step === 2 && !hasMicPermission,
  };
}

/**
 * Map a permission result to a UI-friendly status object.
 * @param {'granted'|'denied'|'restricted'|'not-determined'|'error'} state
 * @returns {{ message: string, cssClass: string, showDeniedHelp: boolean }}
 */
function permissionStateToUI(state) {
  switch (state) {
    case "granted":
      return {
        message: "Microphone access granted!",
        cssClass: "success",
        showDeniedHelp: false,
      };
    case "denied":
      return {
        message: "Microphone access was denied.",
        cssClass: "error",
        showDeniedHelp: true,
      };
    case "restricted":
      return {
        message: "Microphone access is restricted by system policy.",
        cssClass: "error",
        showDeniedHelp: true,
      };
    case "not-determined":
      return {
        message: "",
        cssClass: "",
        showDeniedHelp: false,
      };
    default:
      return {
        message: "Could not determine microphone status.",
        cssClass: "error",
        showDeniedHelp: false,
      };
  }
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
 * Whether the demo should say "Hearing you": a voice-level signal now, or
 * one within the last HEARING_HOLD_MS.
 * @param {number} volume - computeRmsVolume output 0-100
 * @param {number} now - ms timestamp
 * @param {number|null} lastHeardAt - ms timestamp of the last loud enough frame
 * @returns {{ hearing: boolean, lastHeardAt: number|null }}
 */
function updateHearing(volume, now, lastHeardAt) {
  const heardAt = volume >= HEARING_MIN_VOLUME ? now : lastHeardAt;
  return {
    hearing: heardAt !== null && now - heardAt <= HEARING_HOLD_MS,
    lastHeardAt: heardAt,
  };
}

// Expose pure helpers for unit testing
if (typeof globalThis !== "undefined") {
  globalThis.__onboardingHelpers = {
    resolveInitialStep,
    resolveStepButtons,
    permissionStateToUI,
    computeRmsVolume,
    updateHearing,
  };
}

// ---- DOM wiring (only runs in browser with a document) ----

if (typeof document === "undefined") {
  // Running in Node (e.g. vitest) — skip all DOM code
  if (typeof module !== "undefined") module.exports = {};
} else {
  document.addEventListener("DOMContentLoaded", async () => {
    await checkExistingPermissions();
    setupEventHandlers();
    updateStepDisplay();

    // If mic already granted, we landed on step 3 — start the demo
    if (currentStep === 3) {
      setTimeout(function () {
        startDemoAudio();
      }, 400);
    }
  });

  /**
   * Raw-capture constraints for the mic quietpls would monitor with (2.1.1):
   * never a Bluetooth default, which would make the user's headphones tinny.
   */
  async function micAudioConstraints() {
    const base = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    const MP = window.MicPolicy;
    if (!MP) return base;
    const api = window.electronAPI;
    const choice = await MP.resolveChoice(
      navigator.mediaDevices,
      api && api.getInputTransports ? () => api.getInputTransports() : null,
      "",
    );
    return MP.audioConstraints(choice, base);
  }

  async function checkExistingPermissions() {
    try {
      if (window.electronAPI && window.electronAPI.getMicrophoneStatus) {
        const status = await window.electronAPI.getMicrophoneStatus();
        if (status === "granted") {
          micPermissionGranted = true;
          currentStep = resolveInitialStep(status);
        }
        return;
      }
      // Fallback: try Permissions API / getUserMedia
      try {
        const result = await navigator.permissions.query({
          name: "microphone",
        });
        if (result.state === "granted") {
          micPermissionGranted = true;
          currentStep = 3;
        }
      } catch (_e) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: await micAudioConstraints(),
          });
          stream.getTracks().forEach((t) => t.stop());
          micPermissionGranted = true;
          currentStep = 3;
        } catch (_err) {
          // No permission yet
        }
      }
    } catch (_e) {
      // Ignore — start at step 1
    }
  }

  function setupEventHandlers() {
    const getStartedBtn = document.getElementById("getStartedBtn");
    const allowMicBtn = document.getElementById("allowMicBtn");
    const openSettingsBtn = document.getElementById("openSettingsBtn");
    const backBtn = document.getElementById("backBtn");
    const skipBtn = document.getElementById("skipBtn");
    const startMonitoringBtn = document.getElementById("startMonitoringBtn");

    if (getStartedBtn) {
      getStartedBtn.addEventListener("click", () => goToStep(2));
    }

    if (allowMicBtn) {
      allowMicBtn.addEventListener("click", handlePermissionRequest);
      // If already granted, update the button
      if (micPermissionGranted) {
        markMicGranted(allowMicBtn);
      }
    }

    if (openSettingsBtn) {
      openSettingsBtn.addEventListener("click", () => {
        if (window.electronAPI && window.electronAPI.openSystemSettings) {
          window.electronAPI.openSystemSettings();
        }
      });
    }

    if (backBtn) {
      backBtn.addEventListener("click", () => {
        if (currentStep > 1) goToStep(currentStep - 1);
      });
    }

    if (skipBtn) {
      skipBtn.addEventListener("click", () => completeOnboarding());
    }

    if (startMonitoringBtn) {
      startMonitoringBtn.addEventListener("click", () =>
        completeOnboarding(true),
      );
    }
  }

  async function handlePermissionRequest() {
    const allowMicBtn = document.getElementById("allowMicBtn");
    const permissionStatus = document.getElementById("permissionStatus");
    const deniedHelp = document.getElementById("deniedHelp");

    if (!allowMicBtn) return;
    allowMicBtn.disabled = true;

    if (permissionStatus) {
      permissionStatus.textContent = "Requesting microphone access...";
      permissionStatus.className = "permission-status";
    }

    try {
      // Try electronAPI first (uses native macOS permission prompt)
      if (window.electronAPI && window.electronAPI.requestMicrophoneAccess) {
        const granted = await window.electronAPI.requestMicrophoneAccess();
        if (granted) {
          micPermissionGranted = true;
          markMicGranted(allowMicBtn);
          applyPermissionUI("granted");
          // Auto-advance after a brief delay
          setTimeout(() => goToStep(3), 600);
          return;
        }
        // Not granted — check status for specific state
        const status = window.electronAPI.getMicrophoneStatus
          ? await window.electronAPI.getMicrophoneStatus()
          : "denied";
        applyPermissionUI(status);
        allowMicBtn.disabled = false;
        return;
      }

      // Fallback: getUserMedia
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: await micAudioConstraints(),
      });
      stream.getTracks().forEach((t) => t.stop());
      micPermissionGranted = true;
      markMicGranted(allowMicBtn);
      applyPermissionUI("granted");
      setTimeout(() => goToStep(3), 600);
    } catch (_error) {
      applyPermissionUI("denied");
      allowMicBtn.disabled = false;
    }
  }

  function applyPermissionUI(state) {
    const permissionStatus = document.getElementById("permissionStatus");
    const deniedHelp = document.getElementById("deniedHelp");
    const ui = permissionStateToUI(state);

    if (permissionStatus) {
      permissionStatus.textContent = ui.message;
      permissionStatus.className = "permission-status " + ui.cssClass;
    }

    if (deniedHelp) {
      deniedHelp.style.display = ui.showDeniedHelp ? "block" : "none";
    }

    updateStepDisplay();
  }

  function markMicGranted(btn) {
    btn.classList.add("success");
    btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
    </svg>
    Microphone Enabled
  `;
    btn.disabled = true;
  }

  function goToStep(step) {
    if (transitioning || step === currentStep || step < 1 || step > TOTAL_STEPS)
      return;
    transitioning = true;

    const currentEl = document.getElementById("step" + currentStep);
    const nextEl = document.getElementById("step" + step);

    if (currentEl) {
      currentEl.classList.remove("active");
      currentEl.classList.add("exiting");
      // Ensure exiting class is always removed — use both animationend and a safety timeout
      var cleaned = false;
      function cleanup() {
        if (cleaned) return;
        cleaned = true;
        currentEl.classList.remove("exiting");
      }
      currentEl.addEventListener("animationend", cleanup, { once: true });
      // Safety: force cleanup if animationend doesn't fire within 400ms
      setTimeout(cleanup, 400);
    }

    // Small delay so exit animation starts before enter
    setTimeout(() => {
      currentStep = step;
      if (nextEl) {
        nextEl.classList.add("active");
      }
      updateStepDisplay();
      transitioning = false;
    }, 200);
  }

  function updateStepDisplay() {
    // Sync step content visibility — only the current step should be active
    for (var s = 1; s <= TOTAL_STEPS; s++) {
      var stepEl = document.getElementById("step" + s);
      if (stepEl) {
        if (s === currentStep) {
          stepEl.classList.add("active");
          stepEl.classList.remove("exiting");
        } else {
          stepEl.classList.remove("active", "exiting");
        }
      }
    }

    // Update dot indicators
    document.querySelectorAll(".dot").forEach((dot) => {
      const dotStep = parseInt(dot.dataset.step, 10);
      dot.classList.toggle("active", dotStep === currentStep);
      dot.classList.toggle("completed", dotStep < currentStep);
    });

    // Update nav buttons
    const backBtn = document.getElementById("backBtn");
    const skipBtn = document.getElementById("skipBtn");

    const btnState = resolveStepButtons(currentStep, micPermissionGranted);

    if (backBtn) {
      backBtn.style.visibility = btnState.back;
    }

    if (skipBtn) {
      skipBtn.style.visibility = btnState.skip;
    }
  }

  function completeOnboarding(shouldStartMonitoring = false) {
    if (window.electronAPI && window.electronAPI.onboardingComplete) {
      window.electronAPI.onboardingComplete({
        startMonitoring: shouldStartMonitoring,
      });
    }
  }

  // ---- Step 3: Interactive Voice Demo ----

  /**
   * Start the demo audio pipeline: getUserMedia -> AnalyserNode -> FFT vis + RMS zone detection.
   */
  async function startDemoAudio() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: await micAudioConstraints(),
      });

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      demoAudioCtx = audioCtx;
      demoStream = stream;
      demoAnalyser = analyser;

      // Start FFT visualizer on the canvas
      const canvas = document.getElementById("demoFftCanvas");
      if (canvas && window.FFTVisualizer) {
        window.FFTVisualizer.startVisualization(analyser, canvas);
      }

      // Poll the level only to say whether the mic hears you.
      const timeDomainData = new Uint8Array(analyser.fftSize);
      let lastHeardAt = null;
      let shown = null;
      function pollVolume() {
        if (!demoAnalyser) return; // cleaned up
        analyser.getByteTimeDomainData(timeDomainData);
        const h = updateHearing(
          computeRmsVolume(timeDomainData),
          performance.now(),
          lastHeardAt,
        );
        lastHeardAt = h.lastHeardAt;
        if (h.hearing !== shown) {
          shown = h.hearing;
          updateDemoUI(h.hearing);
        }
        demoAnimFrameId = requestAnimationFrame(pollVolume);
      }
      pollVolume();
    } catch (_err) {
      const label = document.getElementById("demoHearingLabel");
      if (label) label.textContent = "Could not access the microphone";
    }
  }

  function updateDemoUI(hearing) {
    const box = document.getElementById("demoHearing");
    const mark = document.getElementById("demoHearingMark");
    const label = document.getElementById("demoHearingLabel");
    if (box) box.classList.toggle("is-hearing", hearing);
    if (mark) mark.textContent = hearing ? "\u2713" : "\u00b7";
    if (label) {
      label.textContent = hearing ? "Hearing you" : "Waiting for your voice\u2026";
    }
    if (window.FFTVisualizer) {
      window.FFTVisualizer.setVolumeZone(hearing ? "normal" : "quiet");
    }
  }

  /**
   * Stop the demo audio pipeline and clean up all resources.
   */
  function stopDemoAudio() {
    if (demoAnimFrameId) {
      cancelAnimationFrame(demoAnimFrameId);
      demoAnimFrameId = null;
    }

    if (window.FFTVisualizer) {
      window.FFTVisualizer.stopVisualization();
    }

    if (demoStream) {
      demoStream.getTracks().forEach(function (t) {
        t.stop();
      });
      demoStream = null;
    }

    if (demoAudioCtx) {
      demoAudioCtx.close().catch(function () {});
      demoAudioCtx = null;
    }

    demoAnalyser = null;
  }

  // Hook into goToStep to start/stop demo audio when entering/leaving step 3
  const _originalGoToStep = goToStep;
  goToStep = function (step) {
    // If leaving step 3, clean up audio
    if (currentStep === 3 && step !== 3) {
      stopDemoAudio();
    }

    _originalGoToStep(step);

    // If entering step 3, start demo audio after a brief delay for animation
    if (step === 3) {
      setTimeout(function () {
        startDemoAudio();
      }, 200);
    }
  };

  // Also clean up audio on onboarding complete
  const _originalCompleteOnboarding = completeOnboarding;
  completeOnboarding = function (shouldStartMonitoring) {
    stopDemoAudio();
    _originalCompleteOnboarding(shouldStartMonitoring);
  };

  // Listen for close command from main process
  if (
    typeof window !== "undefined" &&
    window.electronAPI &&
    window.electronAPI.onCloseWindow
  ) {
    window.electronAPI.onCloseWindow(() => {
      stopDemoAudio();
      window.close();
    });
  }
} // end of document guard
