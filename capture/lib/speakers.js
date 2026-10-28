"use strict";

// Speaker names on top of the you/them channels. The diarize sidecar gives each
// segment a cluster number per side; this turns clusters into names and lets the
// user rename them later (renaming two clusters to one name merges them).
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

/**
 * lines: merged [{ who, cluster? }]. them clusters → "Speaker 1", "Speaker 2"… in order
 * of first appearance. On the mic side the busiest cluster is you (no name); anyone
 * else the mic heard becomes "In room 1", "In room 2"…
 */
function assignSpeakers(lines) {
  const counts = new Map();
  for (const l of lines)
    if (l.who === "you" && l.cluster !== undefined)
      counts.set(l.cluster, (counts.get(l.cluster) || 0) + 1);
  const me = [...counts].sort((a, b) => b[1] - a[1])[0];
  const names = { you: new Map(), them: new Map() };
  return lines.map(({ cluster, ...l }) => {
    if (cluster === undefined) return l;
    if (l.who === "you" && me && cluster === me[0]) return l;
    const side = names[l.who];
    if (!side.has(cluster))
      side.set(
        cluster,
        l.who === "them"
          ? `Speaker ${side.size + 1}`
          : `In room ${side.size + 1}`,
      );
    return { ...l, speaker: side.get(cluster) };
  });
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rename a speaker everywhere in one transcript's markdown. */
function renameSpeaker(markdown, from, to) {
  const name = String(to)
    .replace(/[()\n"]/g, "")
    .trim();
  if (!name) throw new Error("A speaker name can't be empty.");
  let out = markdown.replace(
    new RegExp(
      `^(\\[\\d\\d:\\d\\d:\\d\\d\\] \\[(?:you|them)\\]) \\(${esc(from)}\\) `,
      "gm",
    ),
    (_match, prefix) => `${prefix} (${name}) `,
  );
  out = out.replace(/^speakers: (\[.*\])$/m, (_, list) => {
    const names = [
      ...new Set(JSON.parse(list).map((s) => (s === from ? name : s))),
    ];
    return `speakers: [${names.map((s) => JSON.stringify(s)).join(", ")}]`;
  });
  return out;
}

// MARK: sidecar

const MODEL = {
  file: "wespeaker_en_voxceleb_resnet34_LM.onnx",
  size: "26 MB",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
};
// In the packaged app the script is unpacked next to app.asar (electron-builder asarUnpack).
const SCRIPT = path
  .join(__dirname, "..", "diarize", "diarize.py")
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const UV_CANDIDATES = [
  path.join(process.env.HOME || "", ".local", "bin", "uv"),
  "/opt/homebrew/bin/uv",
  "/usr/local/bin/uv",
];

function findUv() {
  return UV_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

/** Cluster labels for one side's segments: [{ at, end }] → [0, 0, 1, …]. */
function diarizeSide({ uv, model, wavPath, segments }) {
  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "--offline",
      "-q",
      "--python",
      "3.12",
      "--with",
      "sherpa-onnx==2.0.1",
      "--with",
      "numpy==2.5.4",
      "python",
      SCRIPT,
      "--model",
      model,
      "--wav",
      wavPath,
    ];
    const child = execFile(
      uv,
      args,
      { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err)
          return reject(
            new Error(
              `speaker labels failed: ${String(stderr).trim().split("\n").pop() || err.message}`,
            ),
          );
        try {
          resolve(JSON.parse(stdout).labels);
        } catch (e) {
          reject(e);
        }
      },
    );
    child.stdin.end(
      JSON.stringify(segments.map((s) => ({ at: s.at, end: s.end || s.at }))),
    );
  });
}

async function downloadModel(dir) {
  const uv = findUv();
  if (!uv) throw new Error("Install uv first (brew install uv).");
  // Explicit setup download only; transcription later runs uv in offline mode.
  await new Promise((resolve, reject) =>
    execFile(
      uv,
      [
        "run",
        "-q",
        "--python",
        "3.12",
        "--with",
        "sherpa-onnx==2.0.1",
        "--with",
        "numpy==2.5.4",
        "python",
        "-c",
        "import numpy, sherpa_onnx",
      ],
      { timeout: 10 * 60 * 1000 },
      (e) => (e ? reject(e) : resolve()),
    ),
  );
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(MODEL.url);
  if (!res.ok) throw new Error(`Speaker model download failed (${res.status})`);
  const file = path.join(dir, MODEL.file);
  fs.writeFileSync(file + ".part", Buffer.from(await res.arrayBuffer()));
  fs.renameSync(file + ".part", file);
  return file;
}

module.exports = {
  assignSpeakers,
  renameSpeaker,
  MODEL,
  findUv,
  diarizeSide,
  downloadModel,
};
