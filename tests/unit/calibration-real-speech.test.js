import { describe, expect, it } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const Cal = require("../../calibration-manager");
const h = require("./helpers/worklet-harness");

// Real human read speech (LibriVox, public domain; tests/fixtures/README.md),
// nonstop with natural syllable, breath and sentence gaps.
const { sampleRate, samples: speech } = h.readWav(
  new URL("../fixtures/speech-human.wav", import.meta.url),
);
const speechRms = Math.sqrt(speech.reduce((s, v) => s + v * v, 0) / speech.length);

/** Production worklet → calibration; result plus the audio time it took. */
function calibrate(signal, { noiseDb = -62 } = {}) {
  const w = h.createWorklet(sampleRate);
  w.feed(h.noise(3000, noiseDb, sampleRate, 99)); // room before Start
  const bed = h.noise(signal.length / sampleRate * 1000, noiseDb, sampleRate, 5);
  for (let i = 0; i < bed.length; i++) bed[i] += signal[i];
  const cal = Cal.createCalibrationManager();
  cal.start();
  let audioMs = 0;
  let progressAt5s = null;
  for (const f of w.feed(bed)) {
    audioMs += f.frameMs;
    const r = cal.addFrame(f);
    if (audioMs >= 5000 && progressAt5s === null) progressAt5s = cal.getProgress();
    if (r) return { ...r, audioMs, progressAt5s };
  }
  return { status: null, audioMs, progressAt5s };
}

/** `ms` of nonstop talking at `levelDb` RMS (the fixture loops). */
function talking(ms, levelDb) {
  const n = Math.round((sampleRate * ms) / 1000);
  const g = Math.pow(10, levelDb / 20) / speechRms;
  return Float32Array.from({ length: n }, (_, i) => speech[i % speech.length] * g);
}

describe("calibration with real human speech (2.4.1 bug: nonstop talking failed)", () => {
  it.each([
    // [speech dBFS, room dBFS, max audio ms]: close/normal mic, quieter, far built-in mic
    [-32, -62, 15000],
    [-42, -62, 15000],
    [-42, -55, 18000],
    [-47, -55, 30000], // 8af41f7: no-speech, "heard 5 of 10" after 40 s
  ])("nonstop talking at %s dBFS over a %s dBFS room finishes within %s ms", (level, noiseDb, bound) => {
    const r = calibrate(talking(40000, level), { noiseDb });
    console.log("REAL SPEECH", JSON.stringify({ level, noiseDb, status: r.status, audioMs: Math.round(r.audioMs), progressAt5s: r.progressAt5s }));
    expect(r.status).toBe("ok");
    expect(r.audioMs).toBeLessThanOrEqual(bound);
    expect(r.baselineDb).toBeGreaterThan(level - 6);
    expect(r.baselineDb).toBeLessThan(level + 6);
  });

  it("progress tracks talking the way the speaker hears it", () => {
    // After 5 s of nonstop talking the bar shows at least 3 of 10 seconds.
    expect(calibrate(talking(20000, -32)).progressAt5s).toBeGreaterThanOrEqual(0.3);
  });

  it("silence, pink noise and sustained music are still refused", () => {
    const silence = new Float32Array(41 * sampleRate);
    expect(calibrate(silence).status).toBe("no-speech");
    for (const db of [-50, -40, -30]) {
      // Pink noise switched on during calibration (the floor lags ~3 s behind).
      expect(calibrate(h.pink(41000, db, sampleRate)).status).toBe("no-speech");
    }
    // Sustained chords (organ/pad-like music), changing every 2 s.
    const chords = [[262, 330, 392], [220, 262, 330], [175, 220, 262], [196, 247, 294]];
    const music = Float32Array.from({ length: 41 * sampleRate }, (_, i) => {
      const t = i / sampleRate;
      const chord = chords[Math.floor(t / 2) % chords.length];
      let v = 0;
      for (const f of chord) for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * f * k * t) / k;
      return v * 0.02;
    });
    expect(calibrate(music).status).not.toBe("ok");
  });
});
