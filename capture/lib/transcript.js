"use strict";

// Below this peak a side is treated as silent: whisper invents words ("Thank you.")
// on near-silence, so a silent side is not transcribed at all.
const SILENT_PEAK = 0.02;

// Whisper's markers for non-speech: [BLANK_AUDIO], (silence), [Music], *coughs* ...
const NON_SPEECH = /^\s*([[(*].*[\])*]|\.+)?\s*$/;

/** Whisper JSON (-oj) → [{ at: seconds, text }], dropping non-speech markers. */
function parseWhisper(json) {
  const items = (json && json.transcription) || [];
  return items
    .map((s) => ({
      at: (s.offsets ? s.offsets.from : 0) / 1000,
      end: (s.offsets ? s.offsets.to : 0) / 1000,
      text: String(s.text || "")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((s) => s.text && !NON_SPEECH.test(s.text));
}

/**
 * Whisper often starts a segment where the previous one ended, so a line said
 * after a long pause gets an early time. Move each start to the first 20 ms
 * window inside the segment that is louder than a tenth of the side's peak.
 */
function refineStarts(lines, samples, sampleRate) {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  const floor = max / 10;
  const win = Math.round(sampleRate * 0.02);
  return lines.map((l) => {
    const to = Math.min(
      samples.length,
      Math.ceil((l.end || l.at) * sampleRate),
    );
    for (let i = Math.floor(l.at * sampleRate); i + win <= to; i += win) {
      let loud = 0;
      for (let j = i; j < i + win; j++)
        loud = Math.max(loud, Math.abs(samples[j]));
      if (loud >= floor) return { ...l, at: i / sampleRate };
    }
    return l;
  });
}

// Any script's letters and digits (Chinese, Cyrillic, ...), not just ASCII.
const words = (t) =>
  new Set(t.toLowerCase().match(/[\p{L}\p{N}\p{M}']+/gu) || []);

/**
 * On laptop speakers the mic also hears the other side. Drop a "you" line only when
 * a "them" line within `window` seconds says nearly the same thing: every word of it
 * is in the "them" line (echo can lose words, not add them: "I do not approve" is
 * not an echo of "I approve") and the two share at least 80% of their words.
 * Keeping an echo is a duplicate line; dropping real speech loses it, so when in
 * doubt the line is kept. A line with nothing to compare is kept.
 */
function dropEcho(you, them, window = 3) {
  return you.filter((y) => {
    const yw = words(y.text);
    if (!yw.size) return true;
    return !them.some((t) => {
      if (Math.abs(t.at - y.at) > window) return false;
      const tw = words(t.text);
      for (const w of yw) if (!tw.has(w)) return false;
      return yw.size / tw.size >= 0.8; // yw ⊆ tw, so this is their Jaccard index
    });
  });
}

/** Interleave both sides by time: [{ at, who: "you"|"them", text }]. */
function mergeSides(sides) {
  const lines = [];
  for (const who of ["you", "them"])
    for (const s of sides[who] || []) lines.push({ ...s, who });
  return lines.sort((a, b) => a.at - b.at || (a.who === "you" ? -1 : 1));
}

function clock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/** Local ISO time with offset, e.g. 2026-10-27T22:15:03-07:00. */
function localIso(date) {
  const off = -date.getTimezoneOffset();
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const d = new Date(date.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${d}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

function callTitle(apps) {
  return apps.length ? `${apps.join(" + ")} call` : "Call";
}

/** One markdown file per call: YAML frontmatter + [you]/[them] lines with timestamps. */
function toMarkdown({
  start,
  end,
  apps,
  lines,
  model,
  audioKept,
  silent = [],
  title = callTitle(apps),
}) {
  const seconds = Math.round((end - start) / 1000);
  const speakers = [...new Set(lines.map((l) => l.speaker).filter(Boolean))];
  const fm = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `start: ${localIso(start)}`,
    `end: ${localIso(end)}`,
    `duration: ${JSON.stringify(clock(seconds))}`,
    `duration_seconds: ${seconds}`,
    `apps: [${apps.map((a) => JSON.stringify(a)).join(", ")}]`,
    "channels: { you: microphone, them: system audio }",
    `transcriber: ${JSON.stringify(`whisper.cpp ${model}`)}`,
    `audio: ${audioKept ? "kept" : "deleted"}`,
    ...(speakers.length
      ? [`speakers: [${speakers.map((s) => JSON.stringify(s)).join(", ")}]`]
      : []),
    "---",
    "",
  ];
  const day = start.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const body = [`# ${title} — ${day}`, ""];
  for (const who of silent)
    body.push(
      `_No sound was heard from ${who === "you" ? "your microphone" : "the other side (system audio)"}._`,
      "",
    );
  if (!lines.length) body.push("_No speech was recognized in this call._");
  for (const l of lines)
    body.push(
      `[${clock(l.at)}] [${l.who}]${l.speaker ? ` (${l.speaker})` : ""} ${l.text}`,
    );
  return fm.concat(body).join("\n") + "\n";
}

/** File name for a call, e.g. 2026-10-27-2215-zoom.md */
function fileName(start, apps) {
  const iso = localIso(start);
  const slug =
    (apps[0] || "call")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "call";
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}-${slug}.md`;
}

/** Read the frontmatter and lines of a transcript file (for the list and reader). */
function parseMarkdown(text) {
  const meta = {};
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      let v = line.slice(i + 1).trim();
      try {
        v = JSON.parse(v);
      } catch {
        /* bare value */
      }
      if (line.slice(0, i).trim() === "apps" && typeof v === "string")
        v = v
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
      meta[line.slice(0, i).trim()] = v;
    }
  }
  const body = m ? text.slice(m[0].length) : text;
  const lines = [];
  const notes = [];
  for (const line of body.split("\n")) {
    // [00:01:05] [them] (Speaker 2) text — the (speaker) part is optional
    const l =
      /^\[(\d\d:\d\d:\d\d)\] \[(you|them)\] (?:\(([^)]+)\) )?(.*)$/.exec(line);
    // Only names listed in `speakers:` count, so a line like "(laughs) ok" stays text.
    const known =
      l && l[3] && Array.isArray(meta.speakers) && meta.speakers.includes(l[3]);
    if (l)
      lines.push({
        at: l[1],
        who: l[2],
        ...(known
          ? { speaker: l[3], text: l[4] }
          : { text: l[3] ? `(${l[3]}) ${l[4]}` : l[4] }),
      });
    else if (/^_.*_$/.test(line.trim())) notes.push(line.trim().slice(1, -1));
  }
  return { meta, lines, notes };
}

module.exports = {
  SILENT_PEAK,
  parseWhisper,
  refineStarts,
  dropEcho,
  mergeSides,
  toMarkdown,
  fileName,
  parseMarkdown,
  clock,
  localIso,
  callTitle,
};
