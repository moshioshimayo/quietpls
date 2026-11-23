import { describe, expect, it } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const LL = require("../../level-logic");
const h = require("./helpers/worklet-harness");

// Real human read speech (LibriVox, public domain; tests/fixtures/README.md),
// nonstop with natural syllable, breath and sentence gaps.
const { sampleRate, samples: speech } = h.readWav(
  new URL("../fixtures/speech-human.wav", import.meta.url),
);
const speechRms = Math.sqrt(speech.reduce((s, v) => s + v * v, 0) / speech.length);

/** Production worklet frames for `ms` of nonstop talking at `levelDb` over a room. */
function talking(ms, levelDb, noiseDb) {
  const w = h.createWorklet(sampleRate);
  w.feed(h.noise(3000, noiseDb, sampleRate, 99)); // room before the call
  const g = Math.pow(10, levelDb / 20) / speechRms;
  const bed = h.noise(ms, noiseDb, sampleRate, 5);
  for (let i = 0; i < bed.length; i++) bed[i] += speech[i % speech.length] * g;
  return w.feed(bed);
}

/** Calibration's baseline: mean power of the voiced frames at the normal voice. */
function voicedMeanDb(frames) {
  const v = frames.filter((f) => f.voiced);
  const e = v.reduce((s, f) => s + Math.pow(10, f.dbfs / 10) * f.frameMs, 0);
  return 10 * Math.log10(e / v.reduce((s, f) => s + f.frameMs, 0));
}

function run(frames, baselineDb) {
  const t = LL.createDecisionTracker({ baselineDb });
  let audioMs = 0, firstMs = null, listeningFlips = 0, prevSilent = null, maxZone = "silent";
  const rank = { silent: 0, normal: 1, warning: 2, danger: 3 };
  for (const f of frames) {
    const d = t.update(f);
    audioMs += f.frameMs;
    const silent = d.zone === "silent";
    if (firstMs === null && !silent) firstMs = audioMs;
    if (firstMs !== null && prevSilent === false && silent) listeningFlips++;
    if (firstMs !== null) prevSilent = silent;
    if (rank[d.zone] > rank[maxZone]) maxZone = d.zone;
  }
  return { firstMs, listeningFlips, maxZone };
}

/** Audio ms until the tracker first shows `zone`. */
function firstMs(frames, baselineDb, zone) {
  const t = LL.createDecisionTracker({ baselineDb });
  let audioMs = 0;
  for (const f of frames) {
    audioMs += f.frameMs;
    if (t.update(f).zone === zone) return audioMs;
  }
  return null;
}

describe("first verdict with real speech (2.4.1: a far mic waited up to 15 s)", () => {
  it.each([
    // [speech dBFS, room dBFS]: close/normal mic, quieter, far built-in mic
    [-32, -62],
    [-42, -55],
    [-47, -55],
  ])("nonstop normal talking at %s dBFS over a %s dBFS room: verdict within 3 s, Normal only", (level, noiseDb) => {
    const frames = talking(60000, level, noiseDb);
    const baselineDb = voicedMeanDb(frames);
    const r = run(frames, baselineDb);
    console.log("FIRST VERDICT", JSON.stringify({ level, noiseDb, baselineDb: +baselineDb.toFixed(1), ...r }));
    expect(r.firstMs).not.toBeNull();
    expect(r.firstMs).toBeLessThanOrEqual(3000);
    expect(r.maxZone).toBe("normal"); // no false "Getting loud" / "Ease your voice"
    expect(r.listeningFlips).toBeLessThanOrEqual(4); // per minute of nonstop talking
  });

  it.each([
    [-32, -62],
    [-42, -55],
    [-47, -55],
  ])("talking 8 dB above normal at %s dBFS (room %s dBFS): Getting loud within 4 s", (level, noiseDb) => {
    // The source opens softly (~+4 dB for its first second), so the first
    // verdict can truthfully be Normal before Getting loud.
    const baselineDb = voicedMeanDb(talking(30000, level, noiseDb));
    const warnMs = firstMs(talking(60000, level + 8, noiseDb), baselineDb, "warning");
    console.log("FIRST WARNING", JSON.stringify({ level, noiseDb, warnMs }));
    expect(warnMs).not.toBeNull();
    expect(warnMs).toBeLessThanOrEqual(4000);
  });

  it("talking 12 dB above normal reaches Ease your voice within 5 s", () => {
    const baselineDb = voicedMeanDb(talking(30000, -32, -62));
    const alertMs = firstMs(talking(60000, -20, -62), baselineDb, "danger");
    console.log("FIRST ALERT", JSON.stringify({ level: -32, noiseDb: -62, alertMs }));
    expect(alertMs).not.toBeNull();
    expect(alertMs).toBeLessThanOrEqual(5000);
  });
});
