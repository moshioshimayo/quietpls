// Runs the real volume-processor.js in a vm with only the AudioWorklet globals
// stubbed, and generates deterministic synthetic signals for it.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "volume-processor.js"),
  "utf8",
);

function createWorklet(sampleRate = 48000) {
  let Processor;
  const messages = [];
  vm.runInNewContext(SOURCE, {
    sampleRate,
    Math,
    Float32Array,
    Float64Array,
    Infinity,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => messages.push(m) };
      }
    },
    registerProcessor: (_name, cls) => {
      Processor = cls;
    },
  });
  const processor = new Processor();
  return {
    sampleRate,
    messages,
    /** Feed a Float32Array (any length) in 128-sample render quanta. */
    feed(samples) {
      const start = messages.length;
      for (let i = 0; i < samples.length; i += 128) {
        processor.process(
          [[samples.subarray(i, Math.min(i + 128, samples.length))]],
          [],
          {},
        );
      }
      return messages.slice(start);
    },
    /** Feed `blocks` render quanta with no input channels. */
    feedNoInput(blocks) {
      const start = messages.length;
      for (let i = 0; i < blocks; i++) processor.process([[]], [], {});
      return messages.slice(start);
    },
  };
}

// Deterministic PRNG (mulberry32) so noise is identical on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dbToAmp = (db) => Math.pow(10, db / 20);

/** White noise at the given RMS dBFS. */
function noise(ms, rmsDb, sampleRate = 48000, seed = 1) {
  const n = Math.round((sampleRate * ms) / 1000);
  const r = rng(seed);
  const amp = dbToAmp(rmsDb) * Math.sqrt(3); // uniform[-1,1] has RMS 1/√3
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (r() * 2 - 1) * amp;
  return out;
}

/**
 * Steady room tone with its energy in the speech band: 40 random sines in
 * 300 Hz–3 kHz with random phases (stationary, so never speech).
 */
function roomTone(ms, rmsDb, sampleRate = 48000, seed = 13) {
  const n = Math.round((sampleRate * ms) / 1000);
  const r = rng(seed);
  const parts = Array.from({ length: 40 }, () => ({
    f: 300 + r() * 2700,
    p: r() * 2 * Math.PI,
  }));
  const a = dbToAmp(rmsDb) / Math.sqrt(parts.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const s of parts)
      v += Math.sin((2 * Math.PI * s.f * i) / sampleRate + s.p);
    out[i] = a * v;
  }
  return out;
}

/** Sine at the given RMS dBFS. */
function tone(ms, freq, rmsDb, sampleRate = 48000) {
  const n = Math.round((sampleRate * ms) / 1000);
  const amp = dbToAmp(rmsDb) * Math.SQRT2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/**
 * Speech-like signal: 150 Hz voiced harmonics (to 3 kHz) in 220 ms syllables
 * with 80 ms gaps, over a -65 dBFS noise bed. `levelDb` is the RMS of the
 * voiced part (before gaps).
 */
function speechLike(ms, levelDb, sampleRate = 48000, seed = 7) {
  const n = Math.round((sampleRate * ms) / 1000);
  const bed = noise(ms, -65, sampleRate, seed);
  const harmonics = [];
  for (let f = 150; f <= 3000; f += 150) harmonics.push(f);
  // Equal-amplitude harmonics: RMS of the sum = a·√(H/2)
  const a = dbToAmp(levelDb) / Math.sqrt(harmonics.length / 2);
  const syl = Math.round(sampleRate * 0.22);
  const period = Math.round(sampleRate * 0.3);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i % period;
    let v = 0;
    if (p < syl) {
      const env = Math.sin((Math.PI * p) / syl) * Math.SQRT2; // RMS-preserving envelope
      for (const f of harmonics)
        v += Math.sin((2 * Math.PI * f * i) / sampleRate);
      v *= a * env;
    }
    out[i] = v + bed[i];
  }
  return out;
}

/** Short clicks (5 ms bursts of loud noise) every `everyMs` over a quiet bed. */
function clicks(ms, everyMs, peakDb, sampleRate = 48000) {
  const out = noise(ms, -65, sampleRate, 3);
  const burst = noise(5, peakDb, sampleRate, 11);
  const step = Math.round((sampleRate * everyMs) / 1000);
  for (let s = step; s + burst.length < out.length; s += step) {
    out.set(burst, s);
  }
  return out;
}

function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const speechFrames = (msgs) => msgs.filter((m) => m.speech);

module.exports = {
  createWorklet,
  noise,
  roomTone,
  tone,
  speechLike,
  clicks,
  concat,
  speechFrames,
  dbToAmp,
};
