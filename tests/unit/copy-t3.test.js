import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fs from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { copyViolations, assertRenderedCopy, bannedCopyViolations, normalize } = require("./copy-helpers");
const SHL = require("../../settings-history-logic");
const LL = require("../../level-logic");
const SL = require("../../settings-logic");
const insights = require("../../session-insights");

// Run the shipped renderer's actual formatting functions, without launching an app.
function renderer() {
  const elements = new Map();
  const node = () => ({ textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {}, children: [], offsetHeight: 600,
    classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, addEventListener() {}, focus() {},
    append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
  });
  const document = { addEventListener() {}, querySelectorAll() { return []; },
    getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); },
    createElement: node,
  };
  const context = vm.createContext({ window: { LevelLogic: LL, SettingsLogic: SL, SettingsHistoryLogic: SHL, SessionInsights: insights, electronAPI: {} }, document, console, requestAnimationFrame: (fn) => fn(), Date });
  vm.runInContext(fs.readFileSync(new URL("../../settings-renderer.js", import.meta.url), "utf8"), context);
  return { context, elements, run: (source) => vm.runInContext(source, context) };
}
const text = (html) => normalize(html.replace(/<[^>]*>/g, " "));

describe("T3 copy contract", () => {
  it("ships the reviewed static copy without retired strings", () => {
    expect(copyViolations("T3")).toEqual([]);
  });

  it("renders sensitivity, device and overview templates from real functions", () => {
    const r = renderer();
    assertRenderedCopy("CR-162", r.run("describeSensitivity(2)"), { n: 2 });
    assertRenderedCopy("CR-163", r.run("describeSensitivity(-2)"), { n: 2 });
    r.run("config.sensitivity = 2; updateUI()");
    assertRenderedCopy("CR-116", r.elements.get("marginsDescription").textContent, { w: 4, d: 8 });
    assertRenderedCopy("CR-431", SL.filterAudioInputDevices([{ kind: "audioinput", deviceId: "abcdefgh123", label: "" }])[0].label, { "id prefix": "abcdefgh" });
    r.run("renderStats({totalSessions: 12, totalMinutes: 400})");
    const [count, duration] = r.elements.get("historyTotals").textContent.split(" · ");
    assertRenderedCopy("CR-145", count, { n: 12 });
    assertRenderedCopy("CR-146", duration, { duration: "6h 40m" });
    r.run('renderCaptureStatus({state:"running", device:{label:"Built-in"}, calibration:{calibratedAt:"2026-11-23T12:00:00Z"}})');
    assertRenderedCopy("CR-174", r.elements.get("calibrationStatus").textContent, { date: new Date("2026-11-23T12:00:00Z").toLocaleDateString() });
    r.run('updateLevelIndicator({relDb: 7, label: "Getting loud"})');
    assertRenderedCopy("CR-176", r.elements.get("liveLevelText").textContent, { "relative readout": LL.formatRelative(7), state: "Getting loud" });
  });

  it("renders legacy and modern history without scores", () => {
    const r = renderer();
    r.run('showHistoryState = () => {}; session = {id:"session", algorithmVersion:4, startTime:"2026-11-23T12:00:00Z", duration:120, speakingTime:100, zoneTime:{normal:70,warning:20,danger:10}}; showSessionDetail(session)');
    const summary = r.elements.get("sessionModalBody").children[1];
    assertRenderedCopy("CR-185", summary.children.at(-1).textContent, { duration: SHL.formatDuration(100) });
    const modern = r.run("createSessionCard(session)");
    expect(modern.children[0].innerHTML).toContain("Normal 70%");
    const leg = r.run('showSessionDetail({...session, algorithmVersion:undefined, zoneTime:{quiet:20,normal:40,loud:30,danger:10}})');
    const legacy = text(r.elements.get("sessionModalBody").children[1].innerHTML);
    for (const [id, actual, pct] of [["CR-181", "Quiet 20%",20], ["CR-182", "Normal 40%",40], ["CR-183", "Loud 30%",30], ["CR-184", "High 10%",10]]) {
      expect(legacy).toContain(actual);
      assertRenderedCopy(id, actual, { pct });
    }
    const legend = text(r.run("legend({normal:70,loud:20,danger:10})"));
    for (const [id, actual, pct] of [["CR-186","Normal 70%",70],["CR-187","Getting loud 20%",20],["CR-188","Ease your voice 10%",10]]) {
      expect(legend).toContain(actual);
      assertRenderedCopy(id, actual, { pct });
    }
    assertRenderedCopy("CR-195", SHL.formatDuration(3660), { h: 1, m: 1 });
  });

  it("renders insight templates and keeps authored messages free of banned words", () => {
    const data = { startTime: "2026-11-23T12:00:00Z", speakingTime: 100, zoneTime: { normal: 70, warning: 20, danger: 10 }, peakMoments: [{timestamp:"2026-11-23T12:02:05Z", value:12}] };
    const result = insights.generateInsights(data);
    assertRenderedCopy("CR-198", result[0], { pct: 10 });
    assertRenderedCopy("CR-200", result[1], { pct: 20 });
    assertRenderedCopy("CR-204", result[2], { minutes: 2, n: 12 });
    const messages = [...result, ...insights.generateInsights({}), ...insights.generateInsights({ speakingTime: 100, zoneTime:{normal:100},volumeSamples:Array(30).fill(0) })];
    const html = fs.readFileSync(new URL("../../settings.html", import.meta.url), "utf8");
    messages.push(text(html));
    expect(bannedCopyViolations(messages)).toEqual([]);
  });
});
