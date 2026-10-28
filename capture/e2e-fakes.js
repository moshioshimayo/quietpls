"use strict";

// Test doubles for the Playwright capture spec (QUIETPLS_E2E_TEST=1 and
// QUIETPLS_CAPTURE_FAKES=1, unpackaged only). No mic, no system audio, no whisper:
//   globalThis.__quietplsFakeMicUsers  mic-users output ("<pid>\t<bundle id>\n"), set by the test
//   startCapture                       writes a synthetic stereo WAV when stopped
//   transcribe                         returns one line per side
const fs = require("fs");
const wav = require("./lib/wav");

function tone(seconds, rate, amplitude) {
  const out = new Int16Array(seconds * rate);
  for (let i = 0; i < out.length; i++)
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / rate));
  return out;
}

function startCapture({ output, onMessage, onExit }) {
  let done = false;
  setTimeout(() => onMessage({ type: "started" }), 10);
  const levels = setInterval(
    () => onMessage({ type: "level", you: 0.4, them: 0.6 }),
    120,
  );
  return {
    pid: process.pid,
    kill() {
      if (done) return;
      done = true;
      clearInterval(levels);
      const rate = 16000;
      fs.writeFileSync(
        output,
        wav.encode([tone(3, rate, 8000), tone(3, rate, 8000)], rate),
      );
      onMessage({ type: "saved", path: output, seconds: 3 });
      setTimeout(() => onExit(0), 10);
    },
  };
}

async function transcribe(_bin, _model, wavPath) {
  const them = /-them\.wav$/.test(wavPath);
  return {
    transcription: [
      {
        offsets: { from: them ? 1000 : 0, to: them ? 2500 : 900 },
        text: them
          ? "Thanks for joining, can you share the budget?"
          : "Sure, hosting was forty thousand.",
      },
    ],
  };
}

module.exports = {
  startCapture,
  transcribe,
  findWhisper: () => "/usr/bin/true",
  checkMic: async () => "granted",
  detectorExecFile: (_bin, _args, _opts, cb) =>
    cb(null, globalThis.__quietplsFakeMicUsers || ""),
};
