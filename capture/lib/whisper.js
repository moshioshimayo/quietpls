"use strict";

// Local transcription with whisper.cpp (`brew install whisper-cpp`). Downloading
// a model on first use is the app's only network request.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const MODELS = [
  { id: "tiny.en", label: "Fastest", size: "75 MB" },
  { id: "base.en", label: "Fast", size: "142 MB" },
  { id: "small.en", label: "Better", size: "466 MB" },
  { id: "large-v3-turbo", label: "Best, any language", size: "1.6 GB" },
];
const DEFAULT_MODEL = "base.en";
const BIN_CANDIDATES = [
  "/opt/homebrew/bin/whisper-cli",
  "/usr/local/bin/whisper-cli",
];

function findBinary(env = process.env) {
  const dirs = String(env.PATH || "")
    .split(":")
    .filter(Boolean)
    .map((d) => path.join(d, "whisper-cli"));
  return [...BIN_CANDIDATES, ...dirs].find((p) => fs.existsSync(p)) || null;
}

const modelUrl = (id) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin`;
const modelPath = (dir, id) => path.join(dir, `ggml-${id}.bin`);

/** Download a model; the only network call the app makes. onProgress(0..1). */
async function downloadModel(dir, id, onProgress = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = modelPath(dir, id);
  const part = dest + ".part";
  const res = await fetch(modelUrl(id));
  if (!res.ok || !res.body)
    throw new Error(`Model download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(part);
  let got = 0;
  let last = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    if (total && got - last > total / 100) {
      last = got;
      onProgress(got / total);
    }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  fs.renameSync(part, dest);
  onProgress(1);
  return dest;
}

/** Transcribe one mono 16 kHz WAV; resolves to whisper's JSON. */
// whisper's JSON is written next to the input (the app's private scratch folder) and
// removed whether or not it parses.
function transcribe(bin, modelFile, wavPath) {
  const outBase = wavPath.replace(/\.wav$/, "");
  const lang = /\.en\.bin$/.test(modelFile) ? "en" : "auto";
  const args = [
    "-m",
    modelFile,
    "-f",
    wavPath,
    "-oj",
    "-of",
    outBase,
    "-l",
    lang,
    "-np",
    "-t",
    String(Math.min(8, os.cpus().length)),
  ];
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        const jsonPath = outBase + ".json";
        try {
          if (err)
            return reject(
              new Error(
                `whisper failed: ${String(stderr).trim().split("\n").pop() || err.message}`,
              ),
            );
          resolve(JSON.parse(fs.readFileSync(jsonPath, "utf8")));
        } catch (e) {
          reject(e);
        } finally {
          fs.rmSync(jsonPath, { force: true });
        }
      },
    );
  });
}

module.exports = {
  MODELS,
  DEFAULT_MODEL,
  findBinary,
  modelPath,
  downloadModel,
  transcribe,
};
