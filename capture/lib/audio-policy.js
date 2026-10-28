"use strict";

// A call's audio is deleted as soon as its transcript is saved, unless the user
// chose to keep audio; kept audio is deleted after `keepDays`. Leftovers (e.g. a
// failed transcription) are swept after a day when audio isn't being kept.
const fs = require("fs");
const path = require("path");

const DAY = 24 * 60 * 60 * 1000;

/** What to do with a call's audio once its transcript is saved: "delete" | "keep". */
function afterTranscript(settings) {
  return settings.keepAudio && settings.keepDays > 0 ? "keep" : "delete";
}

/** Recordings past their retention window. */
function expired(files, settings, now = Date.now()) {
  const days = afterTranscript(settings) === "keep" ? settings.keepDays : 1;
  return files.filter((f) => now - f.mtimeMs > days * DAY).map((f) => f.path);
}

/** Delete expired recordings in dir; returns the deleted paths. */
function sweep(dir, settings, now = Date.now()) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((n) => n.endsWith(".wav"))
    .map((n) => path.join(dir, n))
    .map((p) => ({ path: p, mtimeMs: fs.statSync(p).mtimeMs }));
  const doomed = expired(files, settings, now);
  for (const p of doomed) fs.unlinkSync(p);
  return doomed;
}

module.exports = { afterTranscript, expired, sweep };
