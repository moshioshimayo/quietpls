#!/usr/bin/env node
"use strict";
// Non-acoustic integration check, never plays audio or opens the mic.
// node capture/check-speakers.js <three-voice-mono.wav> <whisper-model.bin> <speaker-model.onnx>
// Test speech: Samantha/Daniel/Rishi alternate, saying planning/design/marketing lines.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const W = require("./lib/wav");
const whisper = require("./lib/whisper");
const speakers = require("./lib/speakers");
const { finishCall } = require("./lib/pipeline");

(async () => {
  const [source, model, speakerModel] = process.argv.slice(2);
  const { channels, sampleRate } = W.decode(fs.readFileSync(source));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qpc-speakers-"));
  const wavPath = path.join(root, "stereo.wav");
  const folder = path.join(root, "transcripts");
  fs.mkdirSync(folder);
  fs.writeFileSync(
    wavPath,
    W.encode([new Int16Array(channels[0].length), channels[0]], sampleRate),
  );
  const result = await finishCall({
    wavPath,
    start: new Date(),
    end: new Date(Date.now() + (channels[0].length / sampleRate) * 1000),
    apps: ["Simulated three-person call"],
    settings: { folder, keepAudio: false },
    model: path.basename(model),
    transcribeSide: (file) =>
      whisper.transcribe(whisper.findBinary(), model, file),
    diarizeSide: (file, segments) =>
      speakers.diarizeSide({
        uv: speakers.findUv(),
        model: speakerModel,
        wavPath: file,
        segments,
      }),
  });
  const lookup = (phrase) =>
    result.lines.find((l) => l.text.toLowerCase().includes(phrase))?.speaker;
  assert.equal(new Set(result.lines.map((l) => l.speaker)).size, 3);
  assert.equal(lookup("thanks everyone"), lookup("please go ahead"));
  assert.equal(lookup("numbers from the design"), lookup("contractors"));
  assert.equal(lookup("marketing side"), lookup("under budget"));
  assert.notEqual(lookup("thanks everyone"), lookup("contractors"));
  assert(!fs.existsSync(wavPath));
  console.log(
    `PASS three speakers, recurring voices grouped, text committed, audio deleted: ${result.file} @ ${result.sha}`,
  );
  console.log(result.markdown);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
