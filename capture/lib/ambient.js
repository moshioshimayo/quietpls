"use strict";

// Always-on mode: the same record → transcribe → save pipeline, with call detection
// bypassed. Recording is cut into chunks; each chunk's transcript goes to ambient/
// (never committed) and is deleted after `keepHours`. Audio is never kept.
const fs = require("fs");
const path = require("path");

const DEFAULTS = { keepHours: 24, chunkSeconds: 600 };

/** Settings the pipeline should use for an always-on chunk (audio is never kept). */
function chunkSettings(settings) {
  return { ...settings, keepAudio: false };
}

/** Delete ambient transcripts older than keepHours; returns the deleted paths. */
function sweepAmbient(dir, keepHours = DEFAULTS.keepHours, now = Date.now()) {
  const d = dir && path.join(dir, "ambient");
  if (!d || !fs.existsSync(d)) return [];
  const doomed = fs
    .readdirSync(d)
    .filter((n) => n.endsWith(".md"))
    .map((n) => path.join(d, n))
    .filter((p) => now - fs.statSync(p).mtimeMs > keepHours * 3600 * 1000);
  for (const p of doomed) fs.unlinkSync(p);
  return doomed;
}

module.exports = { DEFAULTS, chunkSettings, sweepAmbient };
