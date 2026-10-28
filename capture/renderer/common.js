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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function appList(apps) {
  return apps.length ? apps.join(" + ") : "an app";
}
