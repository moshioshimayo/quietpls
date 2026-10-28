"use strict";

// Read-only search over a transcripts folder (call files at the top level, ambient
// files under ambient/). Returns markdown chunks an agent can read directly.
const fs = require("fs");
const path = require("path");
const { parseMarkdown } = require("./transcript");

function transcriptFiles(dir) {
  const out = [];
  for (const sub of ["", "ambient"]) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d) || fs.lstatSync(d).isSymbolicLink()) continue;
    for (const n of fs.readdirSync(d))
      if (
        n.endsWith(".md") &&
        !n.startsWith(".") &&
        fs.lstatSync(path.join(d, n)).isFile()
      )
        out.push(path.join(sub, n));
  }
  return out;
}

const terms = (q) =>
  String(q || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/**
 * search(dir, { query, from, to, limit, context }) → [{ file, start, title, score, markdown }]
 * Every query word must appear in the transcript; matching lines are returned with
 * `context` lines around them. An empty query returns whole transcripts (newest first).
 * include(rel) → false leaves a file out (the MCP server hides expired always-on text).
 */
function search(
  dir,
  { query = "", from, to, limit = 5, context = 2, include = () => true } = {},
) {
  const words = terms(query);
  const fromT = from ? Date.parse(from) : -Infinity;
  const toT = to ? Date.parse(to) : Infinity;
  const hits = [];
  for (const rel of transcriptFiles(dir)) {
    if (!include(rel)) continue;
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    const { meta, lines } = parseMarkdown(text);
    const t = Date.parse(meta.start);
    if (!(t >= fromT && t <= toT)) continue;
    const hay = lines.map((l) => `${l.speaker || ""} ${l.text}`.toLowerCase());
    if (
      words.length &&
      !words.every(
        (w) =>
          hay.some((h) => h.includes(w)) ||
          String(meta.title || "")
            .toLowerCase()
            .includes(w),
      )
    )
      continue;
    const matched = words.length
      ? hay
          .map((h, i) => (words.some((w) => h.includes(w)) ? i : -1))
          .filter((i) => i >= 0)
      : lines.map((_, i) => i);
    const keep = new Set();
    for (const i of matched)
      for (
        let j = Math.max(0, i - context);
        j <= Math.min(lines.length - 1, i + context);
        j++
      )
        keep.add(j);
    const shown = [...keep].sort((a, b) => a - b);
    const body = [];
    let prev = -1;
    for (const i of shown) {
      if (prev >= 0 && i > prev + 1) body.push("…");
      const l = lines[i];
      body.push(
        `[${l.at}] [${l.who}]${l.speaker ? ` (${l.speaker})` : ""} ${l.text}`,
      );
      prev = i;
    }
    const head = `## ${meta.title || rel} — ${meta.start || ""}\nfile: ${rel} · duration ${meta.duration || "?"} · apps: ${(meta.apps || []).join(", ") || "none"}`;
    hits.push({
      file: rel,
      start: meta.start,
      title: meta.title,
      score: matched.length,
      markdown: `${head}\n\n${body.join("\n")}`,
    });
  }
  hits.sort(
    (a, b) =>
      (words.length ? b.score - a.score : 0) ||
      String(b.start).localeCompare(String(a.start)),
  );
  return hits.slice(0, Math.max(1, Math.min(50, limit)));
}

module.exports = { search, transcriptFiles };
