import { describe, it, expect, vi } from "vitest";
import S from "../../../capture/lib/state.js";
import D from "../../../capture/lib/detector.js";

const on = { enabled: true, neverApps: [] };
const run = (settings, events, start = S.initialState(settings)) =>
  events.reduce((s, e) => S.next(s, e, settings), start);

describe("detection → consent banner", () => {
  it("never asks while capture is off (the default)", () => {
    const off = { enabled: false, neverApps: [] };
    const s = run(off, [{ type: "call", apps: ["Zoom"] }]);
    expect(s.phase).toBe("off");
    expect(S.shouldAsk(s, off)).toBe(false);
  });

  it("asks when a call starts and capture is on", () => {
    expect(run(on, [{ type: "call", apps: ["Zoom"] }]).phase).toBe("asking");
  });

  it("does not record without a yes: skip leaves the call unrecorded and doesn't re-ask", () => {
    const s = run(on, [
      { type: "call", apps: ["Zoom"] },
      { type: "skip" },
      { type: "call", apps: ["Zoom", "Slack"] },
    ]);
    expect(s.phase).toBe("detected");
    expect(s.startedAt).toBe(null);
  });

  it("asks again on the next call after the previous one ended", () => {
    const s = run(on, [
      { type: "call", apps: ["Zoom"] },
      { type: "skip" },
      { type: "call", apps: [] },
      { type: "call", apps: ["Zoom"] },
    ]);
    expect(s.phase).toBe("asking");
  });

  it("asks again on the next call after a recorded call ended by itself", () => {
    // capture/mode.js order when the call app releases the mic: stop, then call-ended.
    let s = run(on, [
      { type: "call", apps: ["Zoom"] },
      { type: "accept", at: 1 },
      { type: "stopped" },
      { type: "call", apps: [] },
      { type: "saved", file: "a.md" },
      { type: "dismiss" },
    ]);
    expect(s.phase).toBe("idle");
    s = run(on, [{ type: "call", apps: ["Zoom"] }], s);
    expect(s.phase).toBe("asking");
  });

  it("'never for this app' suppresses the banner for that app only", () => {
    const never = { enabled: true, neverApps: ["Slack"] };
    expect(run(never, [{ type: "call", apps: ["Slack"] }]).phase).toBe(
      "detected",
    );
    expect(run(never, [{ type: "call", apps: ["Slack", "Zoom"] }]).phase).toBe(
      "asking",
    );
    expect(S.askableApps(["Slack", "Zoom"], never)).toEqual(["Zoom"]);
  });

  it("walks recording → transcribing → saved, and doesn't re-ask about the call it just saved", () => {
    let s = run(on, [
      { type: "call", apps: ["Zoom"] },
      { type: "accept", at: 1 },
    ]);
    expect(s.phase).toBe("recording");
    s = run(on, [{ type: "call", apps: ["Zoom", "Chrome"] }], s);
    expect(s.phase).toBe("recording");
    s = run(on, [{ type: "stopped" }, { type: "saved", file: "a.md" }], s);
    expect(s).toMatchObject({ phase: "saved", file: "a.md" });
    expect(run(on, [{ type: "dismiss" }], s).phase).toBe("detected");
  });

  it("turning capture off mid-call takes the banner down", () => {
    const s = run(on, [{ type: "call", apps: ["Zoom"] }]);
    expect(
      S.next(s, { type: "settings" }, { enabled: false, neverApps: [] }).phase,
    ).toBe("off");
  });
});

describe("mic-user detection", () => {
  it("names known apps, falls back to the process name, and ignores quietpls", () => {
    const names = { 12: "ffmpeg" };
    expect(
      D.callApps(
        [
          "us.zoom.xos",
          "pid 12",
          "pid 15",
          "com.example.Thing",
          "com.quietpls.app.helper",
        ],
        (pid) => names[pid] || "",
      ),
    ).toEqual(["Zoom", "com.example.Thing", "ffmpeg", "process 15"]);
  });

  it("uses quietpls's meeting detector: own pids and macOS speech services are not calls", async () => {
    vi.useFakeTimers();
    const changes = [];
    const det = D.createDetector({
      getOwnPids: () => [12],
      onChange: (c) => changes.push(c.apps),
      execFile: (_bin, _args, _opts, cb) =>
        cb(null, "11\tcom.apple.corespeechd\n12\t\n"),
    });
    det.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(changes).toEqual([]);
    det.stop();
    vi.useRealTimers();
  });

  it("reports a call, then waits out the grace period before saying it ended", async () => {
    vi.useFakeTimers();
    let out = "10\tus.zoom.xos\n";
    const changes = [];
    const det = D.createDetector({
      getOwnPids: () => [],
      onChange: (c) => changes.push(c.apps),
      pollMs: 1000,
      graceMs: 5000,
      execFile: (_bin, _args, _opts, cb) => cb(null, out),
    });
    det.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([["Zoom"]]);
    out = "";
    await vi.advanceTimersByTimeAsync(3000);
    expect(changes).toEqual([["Zoom"]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(changes).toEqual([["Zoom"], []]);
    det.stop();
    vi.useRealTimers();
  });
});
