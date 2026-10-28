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

// The only names the app writes to ambient/: transcript.fileName(start, ["always-on"])
// plus the pipeline's same-minute "-2", "-3" suffix. The folder is the user's, so
// the sweep deletes nothing else (a note they put there is left alone).
const OWN_FILE = /^\d{4}-\d{2}-\d{2}-\d{4}-always-on(-\d+)?\.md$/;

/** Delete the app's ambient transcripts older than keepHours; returns the deleted paths. */
function sweepAmbient(dir, keepHours = DEFAULTS.keepHours, now = Date.now()) {
  const d = dir && path.join(dir, "ambient");
  if (!d || !fs.existsSync(d)) return [];
  const doomed = fs
    .readdirSync(d)
    .filter((n) => OWN_FILE.test(n))
    .map((n) => path.join(d, n))
    .filter((p) => now - fs.statSync(p).mtimeMs > keepHours * 3600 * 1000);
  for (const p of doomed) fs.unlinkSync(p);
  return doomed;
}

module.exports = { DEFAULTS, OWN_FILE, chunkSettings, sweepAmbient };
