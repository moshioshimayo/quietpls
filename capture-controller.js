"use strict";

/**
 * capture-controller.js — owns the microphone capture for quietpls 2.1.
 *
 * One object holds the stream, the device actually captured (from the track's
 * settings, not the configured id), the AudioContext, the worklet/analyser
 * nodes and the health of all of them. It:
 *   - reacquires when the selected mic changes, the selected mic returns after
 *     a fallback, or the system default mic changes;
 *   - notices track ended/mute, context suspension/closure, worklet errors,
 *     missing input and a stalled message stream (watchdog);
 *   - retries with bounded backoff, then reports "unavailable";
 *   - cleans up everything after a failed or partial start.
 * Frames are forwarded only while state is "running", so session time never
 * includes a gap.
 *
 * Which mic is opened comes from mic-policy.js: an explicit pick as is, else
 * the system default unless it is Bluetooth (2.1.1). A device id is always
 * chosen before getUserMedia, so a Bluetooth default is never opened even
 * briefly.
 *
 * States: idle | starting | running | interrupted | reconnecting | unavailable
 *
 * Dual export: CommonJS + window.CaptureController.
 */

const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const DEFAULT_STALE_MS = 2000;
// Continuous healthy frames needed before a reopened mic counts as recovered.
const HEALTHY_RESET_MS = 2000;
// Re-reads of the mic transports while the system default is unresolved.
const RECHECK_MS = 1000;
const MAX_RECHECKS = 5;
const VIRTUAL_IDS = ["default", "communications", ""];
const CaptureMicPolicy =
  typeof module !== "undefined" && module.exports
    ? require("./mic-policy")
    : window.MicPolicy;

function isPermissionError(err) {
  return (
    !!err &&
    (err.name === "NotAllowedError" ||
      err.name === "PermissionDeniedError" ||
      err.name === "SecurityError")
  );
}

function isMissingDeviceError(err) {
  return (
    !!err &&
    (err.name === "NotFoundError" || err.name === "OverconstrainedError")
  );
}

/**
 * Resolve the real device behind a captured track. Chromium reports
 * deviceId "default" for an implicit-default capture; the physical device is
 * the non-virtual input with the same groupId.
 */
function resolveDevice(trackSettings, trackLabel, devices) {
  const settings = trackSettings || {};
  const inputs = (devices || []).filter((d) => d.kind === "audioinput");
  let deviceId = settings.deviceId || "";
  let label = trackLabel || "";
  const groupId = settings.groupId || "";

  if (VIRTUAL_IDS.includes(deviceId)) {
    const plainLabel = label.replace(/^(Default|Communications) - /, "");
    const candidates = inputs.filter(
      (d) =>
        !VIRTUAL_IDS.includes(d.deviceId) &&
        (!groupId || d.groupId === groupId),
    );
    const match =
      candidates.find((d) => d.label === plainLabel) || candidates[0];
    if (match) {
      deviceId = match.deviceId;
      label = match.label || plainLabel;
    } else {
      label = plainLabel;
    }
  }
  return { deviceId: deviceId || "default", label, groupId };
}

function createCaptureController(options) {
  const o = options || {};
  const mediaDevices = o.mediaDevices;
  const timers = o.timers || {
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
    setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a),
  };
  const now = o.now || (() => Date.now());
  const staleMs = o.staleMs || DEFAULT_STALE_MS;
  const retryDelaysMs = o.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS;
  const onFrame = o.onFrame || (() => {});
  const onStatus = o.onStatus || (() => {});
  const log = o.log || (() => {});
  const getTransports = o.getTransports || (async () => null);
  const constraintsBase = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  let preferredId = "";
  let state = "idle";
  let reason = null;
  let device = null;
  let fallback = false;
  let attempts = 0;
  let generation = 0;
  let current = null; // { stream, track, ctx, source, node, analyser, unsubs }
  let retryTimer = null;
  let watchdog = null;
  let lastMessageAt = 0;
  let healthySince = null; // first valid frame of the current healthy run
  let deviceListener = null;
  let choice = null; // mic-policy decision behind the current device
  let recheckTimer = null; // re-read transports while the default is unresolved
  let rechecks = 0;

  function status() {
    return {
      state,
      reason,
      device,
      fallback,
      attempt: attempts,
      preferredId,
      policy: choice ? choice.reason : null,
    };
  }

  function setState(next, why) {
    const changed = next !== state || (why || null) !== reason;
    state = next;
    reason = why || null;
    if (changed) onStatus(status());
  }

  function listen(target, type, fn, unsubs) {
    if (!target) return;
    if (typeof target.addEventListener === "function") {
      target.addEventListener(type, fn);
      unsubs.push(() => target.removeEventListener(type, fn));
    } else {
      target["on" + type] = fn;
      unsubs.push(() => {
        target["on" + type] = null;
      });
    }
  }

  function stopTracks(stream) {
    if (!stream) return;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (_) {
      /* already stopped */
    }
  }

  function teardown() {
    if (watchdog) {
      timers.clearInterval(watchdog);
      watchdog = null;
    }
    const c = current;
    current = null;
    if (!c) return;
    c.unsubs.forEach((u) => u());
    if (c.node && c.node.port) c.node.port.onmessage = null;
    [c.source, c.node, c.analyser].forEach((n) => {
      try {
        if (n) n.disconnect();
      } catch (_) {
        /* not connected */
      }
    });
    stopTracks(c.stream);
    if (c.ctx && c.ctx.state !== "closed") {
      Promise.resolve()
        .then(() => c.ctx.close())
        .catch(() => {});
    }
  }

  function clearRetry() {
    if (retryTimer) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(why) {
    clearRetry();
    if (attempts >= retryDelaysMs.length) {
      setState("unavailable", why);
      return;
    }
    const delay = retryDelaysMs[attempts];
    attempts++;
    setState("reconnecting", why);
    const gen = generation;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (gen === generation && state === "reconnecting") acquire();
    }, delay);
  }

  function lost(why) {
    if (state === "idle") return;
    log("[capture] lost: " + why);
    generation++;
    teardown();
    scheduleRetry(why);
  }

  async function getStream(deviceId) {
    const audio = { ...constraintsBase };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return mediaDevices.getUserMedia({ audio });
  }

  async function transports() {
    try {
      return await getTransports();
    } catch (_) {
      return null;
    }
  }

  async function enumerate() {
    try {
      return await mediaDevices.enumerateDevices();
    } catch (_) {
      return [];
    }
  }

  function handleMessage(event) {
    const msg = event && event.data;
    if (!msg || msg.noInput) return; // no input: let the watchdog decide
    lastMessageAt = now();
    if (state !== "running") return;
    // Opening a device is not recovery: the retry budget only refills after
    // frames have flowed for a while, so a mic that opens but stays dead
    // still runs out of retries and ends up "unavailable".
    if (healthySince === null) healthySince = now();
    else if (attempts > 0 && now() - healthySince >= HEALTHY_RESET_MS)
      attempts = 0;
    onFrame(msg, device);
  }

  async function acquire() {
    const gen = ++generation;
    clearRetry();
    teardown();
    if (state !== "reconnecting") setState("starting");
    let stream = null;
    let ctx = null;
    const unsubs = [];
    try {
      const devices = await enumerate();
      const known = await transports();
      if (gen !== generation) return false;
      let next = CaptureMicPolicy.chooseInput(preferredId, devices, known);
      try {
        stream = await getStream(next.deviceId);
      } catch (err) {
        if (next.reason === "explicit" && isMissingDeviceError(err)) {
          next = CaptureMicPolicy.chooseInput(
            "",
            devices.filter((d) => d.deviceId !== preferredId),
            known,
          );
          stream = await getStream(next.deviceId);
        } else {
          throw err;
        }
      }
      const usedFallback = !!preferredId && next.reason !== "explicit";
      if (gen !== generation) {
        stopTracks(stream);
        return false;
      }
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState === "ended")
        throw new Error("No live audio track");

      ctx = o.createAudioContext();
      await ctx.audioWorklet.addModule(o.workletUrl);
      if (gen !== generation) throw new Error("superseded");
      const source = ctx.createMediaStreamSource(stream);
      const node = o.createWorkletNode(ctx);
      const analyser = o.withAnalyser ? ctx.createAnalyser() : null;
      if (analyser) {
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.8;
      }
      // Not connected to the destination: nothing is ever played back.
      source.connect(node);
      if (analyser) source.connect(analyser);
      current = { stream, track, ctx, source, node, analyser, unsubs };

      node.port.onmessage = handleMessage;
      listen(track, "ended", () => lost("track-ended"), unsubs);
      listen(
        track,
        "mute",
        () => {
          if (state === "running") setState("interrupted", "muted");
        },
        unsubs,
      );
      listen(
        track,
        "unmute",
        () => {
          if (state === "interrupted") setState("running");
        },
        unsubs,
      );
      listen(node, "processorerror", () => lost("processor-error"), unsubs);
      listen(
        ctx,
        "statechange",
        () => {
          if (!current || current.ctx !== ctx) return;
          if (ctx.state === "closed") lost("context-closed");
          else if (
            ctx.state === "running" &&
            state === "interrupted" &&
            reason === "context-suspended"
          )
            setState("running");
          else if (ctx.state !== "running" && state === "running") {
            setState("interrupted", "context-suspended");
            Promise.resolve()
              .then(() => ctx.resume())
              .catch(() => {});
          }
        },
        unsubs,
      );

      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      const resolved = resolveDevice(
        typeof track.getSettings === "function" ? track.getSettings() : {},
        track.label,
        await enumerate(),
      );
      if (gen !== generation) return false;

      device = { ...resolved, bluetooth: next.bluetooth };
      choice = next;
      scheduleRecheck(next.unresolved);
      fallback = usedFallback;
      healthySince = null;
      lastMessageAt = now();
      watchdog = timers.setInterval(
        () => {
          if (
            (state === "running" || state === "interrupted") &&
            now() - lastMessageAt > staleMs
          )
            lost("stale");
        },
        Math.max(250, Math.floor(staleMs / 2)),
      );
      setState("running", usedFallback ? "fallback" : null);
      return true;
    } catch (err) {
      // Partial start: release whatever was acquired before the failure.
      if (current && current.stream === stream) {
        teardown();
      } else {
        unsubs.forEach((u) => u());
        stopTracks(stream);
        if (ctx && ctx.state !== "closed") {
          Promise.resolve()
            .then(() => ctx.close())
            .catch(() => {});
        }
      }
      if (gen !== generation) return false;
      log("[capture] start failed: " + (err && (err.name || err.message)));
      if (isPermissionError(err)) {
        clearRetry();
        setState("unavailable", "permission");
        const e = new Error(err.message || "Microphone permission denied");
        e.name = err.name;
        throw e;
      }
      scheduleRetry((err && err.name) || "start-failed");
      return false;
    }
  }

  /** The transport snapshot didn't match the current default (it changed
   * while we read): look again shortly, a bounded number of times. */
  function scheduleRecheck(unresolved) {
    if (!unresolved) {
      rechecks = 0;
      return;
    }
    if (recheckTimer || rechecks >= MAX_RECHECKS) return;
    rechecks++;
    recheckTimer = timers.setTimeout(() => {
      recheckTimer = null;
      if (state === "running" || state === "interrupted") onDeviceChange();
    }, RECHECK_MS);
  }

  function clearRecheck() {
    if (recheckTimer) timers.clearTimeout(recheckTimer);
    recheckTimer = null;
    rechecks = 0;
  }

  async function onDeviceChange() {
    if (state === "idle" || state === "starting") return;
    if (state === "reconnecting" || state === "unavailable") {
      if (reason === "permission") return;
      attempts = 0;
      acquire().catch(() => {});
      return;
    }
    const devices = await enumerate();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    if (state === "idle" || !device) return;
    const present = (id) => inputs.some((d) => d.deviceId === id);
    let why = null;
    if (!present(device.deviceId) && inputs.length > 0) why = "device-gone";
    else if (preferredId && fallback && present(preferredId))
      why = "preferred-returned";
    else if (!preferredId || fallback) {
      // Re-run the policy: a Bluetooth headset becoming the default keeps
      // the current mic; a built-in mic appearing replaces a Bluetooth one.
      const next = CaptureMicPolicy.chooseInput(
        "",
        devices,
        await transports(),
      );
      if (state === "idle" || !device) return;
      if (next.deviceId && next.deviceId !== device.deviceId)
        why = "default-changed";
      else scheduleRecheck(next.unresolved);
    }
    if (why) {
      log("[capture] device change: " + why);
      attempts = 0;
      acquire().catch(() => {});
    }
  }

  async function start(deviceId) {
    preferredId = deviceId || "";
    attempts = 0;
    if (
      !deviceListener &&
      mediaDevices &&
      typeof mediaDevices.addEventListener === "function"
    ) {
      deviceListener = () => {
        onDeviceChange();
      };
      mediaDevices.addEventListener("devicechange", deviceListener);
    }
    return acquire();
  }

  /** Change the selected mic. Reacquires immediately when capture is active. */
  async function setDevice(deviceId) {
    const next = deviceId || "";
    if (next === preferredId && state === "running" && !fallback) return true;
    preferredId = next;
    if (state === "idle") return true;
    attempts = 0;
    return acquire();
  }

  /** Manual retry (e.g. from the UI when unavailable). */
  async function retry() {
    if (state === "idle") return false;
    attempts = 0;
    return acquire();
  }

  function stop() {
    generation++;
    clearRetry();
    clearRecheck();
    teardown();
    if (
      deviceListener &&
      mediaDevices &&
      typeof mediaDevices.removeEventListener === "function"
    ) {
      mediaDevices.removeEventListener("devicechange", deviceListener);
    }
    deviceListener = null;
    device = null;
    choice = null;
    fallback = false;
    attempts = 0;
    setState("idle");
  }

  return {
    start,
    stop,
    setDevice,
    retry,
    getStatus: status,
    getAnalyser: () => (current ? current.analyser : null),
    /** For tests: run the device-change check now. */
    _onDeviceChange: onDeviceChange,
  };
}

const _captureExports = {
  createCaptureController,
  resolveDevice,
  DEFAULT_RETRY_DELAYS_MS,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = _captureExports;
} else if (typeof window !== "undefined") {
  window.CaptureController = _captureExports;
}
