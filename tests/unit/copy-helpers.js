const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const expectationsPath = path.join(ROOT, "tests/copy-expectations.json");
// Ownership follows plan §3. Scan the whole shipped UI for literals: restructuring
// a surface must not make a correctly moved string disappear from the check.
const OWNER_FILES = {
  T1: ["index.html", "renderer.js", "main.js", "updater-state.js", "level-logic.js", "input-transports.js", "capture-controller.js"],
  T2: ["onboarding.html", "onboarding-renderer.js", "permission-manager.js", "calibration-manager.js", "mic-policy.js", "electron-builder.yml"],
  T3: ["settings.html", "settings-renderer.js", "settings-logic.js", "settings-history-logic.js", "session-insights.js", "session-tracker.js", "session-ipc.js", "capture/settings-section.js"],
  T4: ["capture/renderer/main.html", "capture/renderer/main.js", "capture/renderer/banner.html", "capture/renderer/banner.js", "capture/renderer/indicator.html", "capture/renderer/indicator.js", "capture/renderer/ambient-consent.html", "capture/renderer/ambient-consent.js", "capture/renderer/common.js", "capture/mode.js", "capture/lib/transcript.js", "capture/lib/pipeline.js", "capture/lib/repo.js", "capture/lib/whisper.js", "capture/lib/speakers.js"],
};
const UI_FILES = [...new Set(Object.values(OWNER_FILES).flat())];
const BANNED = [
  /\bcalibrat(?:ing|ion)\b/i, /\binput gain\b/i, /\bdBFS\b/i,
  /\btray\b/i, /\bgrade\b/i, /\bdanger\b/i, /\bfailed\b/i,
  /\bgood voice\b/i, /\bbad voice\b/i, /you have no idea/i,
  /sound your best/i, /never records/i, /nothing is recorded/i,
  /nothing was saved/i, /about 5 seconds/i, /!/, /\bplease\b/i, /\boops\b/i,
];

function normalize(value) {
  return String(value).replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, (entity) =>
    ({ "&amp;":"&", "&lt;":"<", "&gt;":">", "&quot;":'"', "&apos;":"'", "&#39;":"'", "&#x27;":"'" })[entity])
    .replace(/\s+/g, " ").trim();
}

function loadExpectations() {
  return JSON.parse(fs.readFileSync(expectationsPath, "utf8"));
}

function readUI(root = ROOT) {
  return Object.fromEntries(UI_FILES.filter((file) => fs.existsSync(path.join(root, file)))
    .map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
}

// A template row needs an assertion against the actual rendered output. Call this
// with representative values, including values from error branches. It deliberately
// refuses missing values so a null expected literal never silently skips coverage.
function renderExpected(row, values = {}) {
  const template = row.expected ?? row.template;
  if (template == null) throw new Error(`${row.id}: retired row has no rendered text`);
  return template.replace(/\{([^{}]+)\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`${row.id}: missing placeholder ${key}`);
    return String(values[key]);
  });
}

function assertRenderedCopy(id, actual, values = {}, rows = loadExpectations()) {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`Unknown copy row ${id}`);
  const expected = normalize(renderExpected(row, values));
  if (normalize(actual) !== expected) throw new Error(`${id}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(normalize(actual))}`);
}

function textVariants(row) {
  return row.variants || [row.expected ?? row.template].filter((value) => value != null);
}

function sourceText(file, source) {
  if (file.endsWith(".html")) {
    return source.replace(/<!--[^]*?-->/g, "").replace(/<style\b[^]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ");
  }
  if (file.endsWith(".yml")) return source.split("\n").filter((line) => /NS(?:Microphone|AudioCapture)UsageDescription:/.test(line)).join("\n");
  // Extract quoted JS text without counting comments as shipped copy. Keep
  // template expressions in the corpus: dynamic rows are asserted after render.
  const quoted = /\/\/[^\n]*|\/\*[^]*?\*\/|"(?:\\[^]|[^"\\])*"|'(?:\\[^]|[^'\\])*'|`(?:\\[^]|[^`\\])*`/g;
  return [...source.matchAll(quoted)].filter(([value]) => !value.startsWith("/"))
    .map(([value]) => value.slice(1, -1).replace(/\\(['"`\\])/g, "$1").replace(/\\n/g, " "))
    .join("\n");
}

function copyViolations(owner, { rows = loadExpectations(), sources = readUI() } = {}) {
  if (owner != null && !OWNER_FILES[owner]) throw new Error(`Unknown copy owner ${owner}`);
  // Preserve HTML attributes as well as visible text (accessible names/tooltips).
  const corpus = normalize(Object.entries(sources).map(([file, source]) => {
    if (!file.endsWith(".html")) return sourceText(file, source);
    const attributes = [...source.matchAll(/(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map(([, value]) => value);
    return [sourceText(file, source), ...attributes].join(" ");
  }).join("\n"));
  // Another row may still use a replaced short literal, including as part of a
  // longer message. Dynamic templates protect their retained static fragments.
  const kept = rows.filter((row) => row.action !== "retire").flatMap(textVariants).map(normalize);
  const violations = [];
  for (const row of rows.filter((row) => owner == null || row.owner === owner)) {
    for (const expected of textVariants(row).filter((value) => !/\{[^{}]+\}/.test(value))) {
      if (!corpus.includes(normalize(expected))) violations.push(`${row.id}: missing ${JSON.stringify(expected)}`);
    }
    if (row.action !== "retain") {
      for (const old of row.oldLiterals || [row.old]) {
        if (old && !kept.some((literal) => literal.includes(normalize(old))) && corpus.includes(normalize(old))) {
          violations.push(`${row.id}: old text survives: ${JSON.stringify(old)}`);
        }
      }
    }
  }
  return violations;
}

// Run bans on authored visible messages supplied by the surface test, never raw JS:
// internal ids, native diagnostics, commands and filenames are explicitly exempt.
// The test obtains these messages from its renderer/menu model (or rendered DOM).
function bannedCopyViolations(messages) {
  return messages.flatMap((message) => BANNED.filter((pattern) => pattern.test(normalize(message)))
    .map((pattern) => `${JSON.stringify(message)} matches ${pattern}`));
}

module.exports = { OWNER_FILES, UI_FILES, BANNED, normalize, loadExpectations, readUI,
  textVariants, sourceText, renderExpected, assertRenderedCopy, copyViolations, bannedCopyViolations };
