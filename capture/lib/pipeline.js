"use strict";

// After a recording: split the stereo file into you/them, transcribe each side,
// optionally label speakers, write the markdown (calls: committed to git; always-on
// chunks: written to ambient/, never committed), then delete the audio unless keeping it.
const fs = require("fs");
const os = require("os");
const path = require("path");
const wav = require("./wav");
const T = require("./transcript");
const repo = require("./repo");
const policy = require("./audio-policy");
const { assignSpeakers } = require("./speakers");

/**
 * transcribeSide(wavPath) → whisper JSON
 * diarizeSide(wavPath, segments) → cluster per segment (optional; skipped when absent)
 * ambient: true for an always-on chunk.
 * scratchDir: where the per-side audio (and whisper's JSON) live while transcribing;
 * the app passes a private folder it empties on launch (see purgeScratch).
 */
async function finishCall({
  wavPath,
  start,
  end,
  apps,
  settings,
  model,
  transcribeSide,
  diarizeSide,
  ambient = false,
  scratchDir = os.tmpdir(),
}) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const split = wav.splitCall(fs.readFileSync(wavPath));
  const sides = {};
  const silent = [];
  for (const who of ["you", "them"]) {
    if (split[who].peak < T.SILENT_PEAK) {
      silent.push(who);
      continue;
    }
    const tmp = path.join(
      scratchDir,
      `qpc-${ambient ? "ambient-" : ""}${process.pid}-${Date.now()}-${who}.wav`,
    );
    fs.writeFileSync(tmp, split[who].wav);
    try {
      const segs = T.refineStarts(
        T.parseWhisper(await transcribeSide(tmp)),
        split[who].samples,
        split.sampleRate,
      );
      if (diarizeSide && segs.length) {
        const labels = await diarizeSide(tmp, segs);
        segs.forEach((s, i) => (s.cluster = labels[i]));
      }
      sides[who] = segs;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  if (sides.you && sides.them) sides.you = T.dropEcho(sides.you, sides.them);
  const lines = assignSpeakers(T.mergeSides(sides));
  const keep = policy.afterTranscript(settings) === "keep";
  const title = ambient ? "Always-on" : T.callTitle(apps);
  const markdown = T.toMarkdown({
    start,
    end,
    apps,
    lines,
    model,
    audioKept: keep,
    silent,
    title,
  });
  const baseName = T.fileName(start, ambient ? ["always-on"] : apps);
  let name = baseName;
  // Two short calls in the same minute must not overwrite each other.
  for (
    let suffix = 2;
    fs.existsSync(path.join(settings.folder, ambient ? "ambient" : "", name));
    suffix++
  ) {
    name = baseName.replace(/\.md$/, `-${suffix}.md`);
  }
  const minutes = Math.max(1, Math.round((end - start) / 60000));
  const saved = ambient
    ? await repo.saveAmbient(settings.folder, name, markdown)
    : await repo.saveTranscript(
        settings.folder,
        name,
        markdown,
        `${title}, ${T.localIso(start).slice(0, 16).replace("T", " ")} (${minutes} min)`,
      );
  if (!keep) fs.rmSync(wavPath, { force: true });
  return {
    ...saved,
    name: ambient ? `ambient/${name}` : name,
    lines,
    silent,
    audioDeleted: !keep,
    markdown,
  };
}

/**
 * Delete leftover intermediates (per-side audio, whisper JSON) in the scratch folder.
 * finishCall removes its own, so anything here outlived a crash or force-quit.
 * Only call it while nothing is being transcribed.
 */
function purgeScratch(scratchDir) {
  if (!scratchDir || !fs.existsSync(scratchDir)) return [];
  const doomed = fs
    .readdirSync(scratchDir)
    .filter((n) => n.startsWith("qpc-"))
    .map((n) => path.join(scratchDir, n));
  for (const p of doomed) fs.rmSync(p, { force: true });
  return doomed;
}

module.exports = { finishCall, purgeScratch };
