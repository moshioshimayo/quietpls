import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  createCaptureController,
  resolveDevice,
} = require("../../capture-controller");

// ---- Fakes: media devices, tracks, AudioContext, worklet node, timers ----

class FakeTarget {
  constructor() {
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  emit(type) {
    (this.listeners[type] || []).slice().forEach((f) => f({ type }));
  }
}

const BUILTIN = {
  kind: "audioinput",
  deviceId: "builtin-id",
  groupId: "g-builtin",
  label: "MacBook Pro Microphone",
};
const HEADSET = {
  kind: "audioinput",
  deviceId: "headset-id",
  groupId: "g-headset",
  label: "USB Headset",
};
const defaultEntry = (d) => ({
  kind: "audioinput",
  deviceId: "default",
  groupId: d.groupId,
  label: "Default - " + d.label,
});

function makeEnv() {
  const env = {
    inputs: [BUILTIN, HEADSET],
    systemDefault: BUILTIN,
    gumCalls: [],
    gumError: null,
    addModuleError: null,
    tracks: [],
    contexts: [],
    nodes: [],
  };
  env.devices = () => [defaultEntry(env.systemDefault), ...env.inputs];

  const md = new FakeTarget();
  md.getUserMedia = async (constraints) => {
    env.gumCalls.push(constraints);
    if (env.gumError) throw env.gumError;
    const exact =
      constraints.audio.deviceId && constraints.audio.deviceId.exact;
    let dev;
    if (exact) {
      dev = env.inputs.find((d) => d.deviceId === exact);
      if (!dev)
        throw Object.assign(new Error("gone"), {
          name: "OverconstrainedError",
        });
    } else {
      dev = env.systemDefault;
    }
    const track = new FakeTarget();
    Object.assign(track, {
      readyState: "live",
      label: exact ? dev.label : "Default - " + dev.label,
      stopped: false,
      stop() {
        this.stopped = true;
        this.readyState = "ended";
      },
      getSettings: () => ({
        deviceId: exact ? dev.deviceId : "default",
        groupId: dev.groupId,
      }),
    });
    env.tracks.push(track);
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  };
  md.enumerateDevices = async () => env.devices();
  env.mediaDevices = md;

  env.createAudioContext = () => {
    const ctx = new FakeTarget();
    Object.assign(ctx, {
      state: "running",
      destination: { name: "destination" },
      audioWorklet: {
        addModule: async () => {
          if (env.addModuleError) throw env.addModuleError;
        },
      },
      connections: [],
      createMediaStreamSource() {
        return {
          connect: (n) => ctx.connections.push(n),
          disconnect() {},
        };
      },
      createAnalyser() {
        return {
          kind: "analyser",
          connect: (n) => ctx.connections.push(n),
          disconnect() {},
        };
      },
      close: async () => {
        ctx.state = "closed";
      },
      resume: async () => {
        ctx.state = "running";
      },
    });
    env.contexts.push(ctx);
    return ctx;
  };
  env.createWorkletNode = () => {
    const node = new FakeTarget();
    node.port = { onmessage: null };
    node.connect = () => {};
    node.disconnect = () => {};
    env.nodes.push(node);
    return node;
  };

  // Manual clock + timers
  env.clock = 0;
  env.timers = [];
  env.timerApi = {
    setTimeout: (fn, ms) => {
      const t = { at: env.clock + ms, fn, every: 0 };
      env.timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      env.timers = env.timers.filter((x) => x !== t);
    },
    setInterval: (fn, ms) => {
      const t = { at: env.clock + ms, fn, every: ms };
      env.timers.push(t);
      return t;
    },
    clearInterval: (t) => {
      env.timers = env.timers.filter((x) => x !== t);
    },
  };
  return env;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

async function advance(env, ms) {
  const end = env.clock + ms;
  for (;;) {
    const due = env.timers
      .filter((t) => t.at <= end)
      .sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    env.clock = due.at;
    if (due.every) due.at += due.every;
    else env.timers = env.timers.filter((t) => t !== due);
    due.fn();
    await flush();
  }
  env.clock = end;
}

function makeController(env, extra) {
  const frames = [];
  const statuses = [];
  const ctrl = createCaptureController({
    mediaDevices: env.mediaDevices,
    createAudioContext: env.createAudioContext,
    createWorkletNode: env.createWorkletNode,
    workletUrl: "volume-processor.js",
    withAnalyser: true,
    timers: env.timerApi,
    now: () => env.clock,
    staleMs: 2000,
    retryDelaysMs: [500, 1000, 2000],
    onFrame: (m, d) => frames.push({ m, d }),
    onStatus: (s) => statuses.push(s),
    ...extra,
  });
  return { ctrl, frames, statuses };
}

const lastNode = (env) => env.nodes[env.nodes.length - 1];
const post = (env, data = { dbfs: -30, speech: true, frameMs: 20 }) =>
  lastNode(env).port.onmessage({ data });

describe("capture controller — actual device identity (F4)", () => {
  let env;
  beforeEach(() => {
    env = makeEnv();
  });

  it("resolves an implicit-default capture to the real device", async () => {
    const { ctrl } = makeController(env);
    await ctrl.start("");
    expect(ctrl.getStatus()).toMatchObject({
      state: "running",
      device: { deviceId: "builtin-id", label: "MacBook Pro Microphone" },
    });
  });

  it("falls back to the default mic and says so when the selected mic is missing", async () => {
    env.inputs = [BUILTIN];
    const { ctrl } = makeController(env);
    await ctrl.start("headset-id");
    const s = ctrl.getStatus();
    expect(s).toMatchObject({
      state: "running",
      fallback: true,
      reason: "fallback",
    });
    expect(s.device.deviceId).toBe("builtin-id"); // calibration must key on this, not "headset-id"
  });

  it("switching the mic in Settings reacquires and releases the old one", async () => {
    const { ctrl } = makeController(env);
    await ctrl.start("");
    const firstTrack = env.tracks[0];
    const firstCtx = env.contexts[0];
    await ctrl.setDevice("headset-id");
    await flush();
    expect(env.gumCalls).toHaveLength(2);
    expect(env.gumCalls[1].audio.deviceId).toEqual({ exact: "headset-id" });
    expect(firstTrack.stopped).toBe(true);
    expect(firstCtx.state).toBe("closed");
    expect(ctrl.getStatus().device.deviceId).toBe("headset-id");
  });

  it("reacquires when the system default mic changes", async () => {
    const { ctrl } = makeController(env);
    await ctrl.start("");
    env.systemDefault = HEADSET;
    await ctrl._onDeviceChange();
    await flush();
    expect(env.gumCalls).toHaveLength(2);
    expect(ctrl.getStatus().device.deviceId).toBe("headset-id");
  });

  it("returns to the selected mic when it is plugged back in", async () => {
    env.inputs = [BUILTIN];
    const { ctrl } = makeController(env);
    await ctrl.start("headset-id");
    env.inputs = [BUILTIN, HEADSET];
    await ctrl._onDeviceChange();
    await flush();
    expect(ctrl.getStatus()).toMatchObject({
      fallback: false,
      device: { deviceId: "headset-id" },
    });
  });

  it("requests raw capture and never connects to the speakers", async () => {
    const { ctrl } = makeController(env);
    await ctrl.start("");
    expect(env.gumCalls[0].audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(env.contexts[0].connections).not.toContain(
      env.contexts[0].destination,
    );
    expect(ctrl.getAnalyser()).toBeTruthy();
  });
});

describe("capture controller — health and recovery (F7)", () => {
  let env;
  beforeEach(() => {
    env = makeEnv();
  });

  it("track ended → reconnecting, no frames forwarded, then recovers", async () => {
    const { ctrl, frames, statuses } = makeController(env);
    await ctrl.start("");
    post(env);
    expect(frames).toHaveLength(1);
    const oldNode = lastNode(env);

    env.tracks[0].emit("ended");
    expect(ctrl.getStatus().state).toBe("reconnecting");
    expect(oldNode.port.onmessage).toBeNull(); // stale node can no longer feed frames

    await advance(env, 500);
    expect(ctrl.getStatus().state).toBe("running");
    post(env);
    expect(frames).toHaveLength(2);
    expect(statuses.map((s) => s.state)).toEqual([
      "starting",
      "running",
      "reconnecting",
      "running",
    ]);
  });

  it("gives up after bounded retries and reports unavailable", async () => {
    const { ctrl } = makeController(env);
    await ctrl.start("");
    env.gumError = Object.assign(new Error("busy"), {
      name: "NotReadableError",
    });
    env.tracks[0].emit("ended");
    await advance(env, 500 + 1000 + 2000 + 100);
    expect(ctrl.getStatus()).toMatchObject({ state: "unavailable" });
    expect(env.gumCalls.length).toBe(4); // first + 3 retries
    await advance(env, 60000);
    expect(env.gumCalls.length).toBe(4); // no unbounded retrying
  });

  it("a device change while unavailable tries again", async () => {
    const { ctrl } = makeController(env);
    await ctrl.start("");
    env.gumError = Object.assign(new Error("busy"), {
      name: "NotReadableError",
    });
    env.tracks[0].emit("ended");
    await advance(env, 5000);
    expect(ctrl.getStatus().state).toBe("unavailable");
    env.gumError = null;
    await ctrl._onDeviceChange();
    await flush();
    expect(ctrl.getStatus().state).toBe("running");
  });

  it("a stalled worklet (no messages) triggers the watchdog", async () => {
    const { ctrl } = makeController(env);
    await ctrl.start("");
    post(env);
    await advance(env, 1500);
    expect(ctrl.getStatus().state).toBe("running");
    await advance(env, 1500); // > 2 s since last message: watchdog fires
    expect(ctrl.getStatus()).toMatchObject({
      state: "reconnecting",
      reason: "stale",
    });
    await advance(env, 500); // first retry
    expect(env.gumCalls).toHaveLength(2);
    expect(ctrl.getStatus().state).toBe("running");
  });

  it("a mic that reopens but never delivers frames still runs out of retries", async () => {
    // Review finding: acquisition used to reset the budget, so this looped forever.
    const { ctrl } = makeController(env);
    await ctrl.start("");
    await advance(env, 60000);
    expect(ctrl.getStatus().state).toBe("unavailable");
    expect(env.gumCalls).toHaveLength(4); // first + 3 retries, then stop
    expect(env.tracks.filter((t) => !t.stopped)).toHaveLength(0);
  });

  it("the retry budget refills only after 2 s of healthy frames", async () => {
    const { ctrl } = makeController(env);
    await ctrl.start("");
    env.tracks[0].emit("ended");
    await advance(env, 500);
    expect(ctrl.getStatus()).toMatchObject({ state: "running", attempt: 1 });
    for (let t = 0; t <= 1500; t += 250) {
      post(env);
      await advance(env, 250);
    }
    expect(ctrl.getStatus().attempt).toBe(1); // not yet: under 2 s
    for (let t = 0; t < 1000; t += 250) {
      post(env);
      await advance(env, 250);
    }
    expect(ctrl.getStatus().attempt).toBe(0);
  });

  it("no-input messages do not count as a healthy stream", async () => {
    const { ctrl, frames } = makeController(env);
    await ctrl.start("");
    for (let t = 0; t < 4000; t += 250) {
      if (lastNode(env).port.onmessage)
        post(env, { noInput: true, frameMs: 20 });
      await advance(env, 250);
    }
    expect(frames).toHaveLength(0);
    expect(env.gumCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("worklet processorerror → reconnecting", async () => {
    const { ctrl } = makeController(env);
    await ctrl.start("");
    lastNode(env).emit("processorerror");
    expect(ctrl.getStatus()).toMatchObject({
      state: "reconnecting",
      reason: "processor-error",
    });
  });

  it("track mute pauses frames until unmute", async () => {
    const { ctrl, frames } = makeController(env);
    await ctrl.start("");
    env.tracks[0].emit("mute");
    expect(ctrl.getStatus().state).toBe("interrupted");
    post(env);
    expect(frames).toHaveLength(0);
    env.tracks[0].emit("unmute");
    post(env);
    expect(frames).toHaveLength(1);
  });

  it("a partial start failure releases the mic and the context", async () => {
    env.addModuleError = new Error("worklet failed to load");
    const { ctrl } = makeController(env);
    await ctrl.start("");
    await flush();
    expect(env.tracks[0].stopped).toBe(true);
    expect(env.contexts[0].state).toBe("closed");
    expect(ctrl.getStatus().state).toBe("reconnecting");
  });

  it("permission denied → unavailable, throws, no retries", async () => {
    env.gumError = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    const { ctrl } = makeController(env);
    await expect(ctrl.start("")).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    expect(ctrl.getStatus()).toMatchObject({
      state: "unavailable",
      reason: "permission",
    });
    await advance(env, 10000);
    expect(env.gumCalls).toHaveLength(1);
  });

  it("stop() releases everything and cancels pending retries", async () => {
    const { ctrl } = makeController(env);
    await ctrl.start("");
    env.tracks[0].emit("ended");
    ctrl.stop();
    await advance(env, 10000);
    expect(ctrl.getStatus().state).toBe("idle");
    expect(env.gumCalls).toHaveLength(1);
    expect(env.tracks[0].stopped).toBe(true);
    expect(env.mediaDevices.listeners.devicechange).toHaveLength(0);
  });
});

describe("resolveDevice", () => {
  it("matches by groupId and label for implicit default", () => {
    const devices = [defaultEntry(HEADSET), BUILTIN, HEADSET];
    expect(
      resolveDevice(
        { deviceId: "default", groupId: "g-headset" },
        "Default - USB Headset",
        devices,
      ),
    ).toEqual({
      deviceId: "headset-id",
      label: "USB Headset",
      groupId: "g-headset",
    });
  });

  it("keeps explicit device ids", () => {
    expect(
      resolveDevice(
        { deviceId: "builtin-id", groupId: "g-builtin" },
        "MacBook Pro Microphone",
        [],
      ).deviceId,
    ).toBe("builtin-id");
  });
});
