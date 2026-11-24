"use strict";

const $ = (sel) => document.querySelector(sel);

function clock(total) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function tilde(p, home) {
  return p && home && p.startsWith(home) ? "~" + p.slice(home.length) : p || "";
}

// Long paths keep their start and last two folders: "~/…/Meetings/Transcripts".
// With max, a result still longer than max keeps only the last folder: "…/Transcripts".
function shortPath(p, home, max = Infinity) {
  const parts = tilde(p, home).split("/");
  const short = parts.length > 4 ? [parts[0], "…", ...parts.slice(-2)].join("/") : parts.join("/");
  return short.length > max && parts.length > 2 ? "…/" + parts[parts.length - 1] : short;
}

// Escapes written as \x22/\x27 so copy checks can read this file's strings.
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\x22": "&quot;", "\x27": "&#39;" };
function esc(s) {
  return String(s ?? "").replace(/[&<>\x22\x27]/g, (c) => ENTITIES[c]);
}

// Unknown apps arrive as a bundle id or "process 123": headlines say "an app" (K5);
// the raw name stays in secondary text (the Never link names exactly what it blocks).
const friendly = (app) =>
  /^process \d+$|^[\w-]+(\.[\w-]+){2,}$/.test(app) ? "an app" : app;

// Several unknown apps keep their count ("2 apps"): every app recorded is one shown.
function appList(apps) {
  const unknown = new Set(apps.filter((a) => friendly(a) === "an app")).size;
  const names = [...new Set(apps.map((a) => (friendly(a) === "an app" && unknown > 1 ? `${unknown} apps` : friendly(a))))];
  return names.length ? names.join(" + ") : "an app";
}
