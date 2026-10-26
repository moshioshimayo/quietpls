import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  createMeetingDetector,
  parseMicUsers,
} = require("../../meeting-detector");

const OWN_PID = 100;
const ZOOM_LINE = "500\tus.zoom.xos";

let execFileStub;

/**
 * Helper: mock the mic-users helper printing these "<pid>\t<bundle>" lines.
 */
function mockMicUsers(lines) {
  execFileStub = vi.fn((_cmd, _args, _opts, callback) => {
    callback(null, lines.join("\n"));
  });
}

/**
 * Helper: create a mock execFile that calls back with an error.
 */
function mockHelperError(err) {
  execFileStub = vi.fn((_cmd, _args, _opts, callback) => {
    callback(err);
  });
}

/**
 * Helper: create a detector with the current execFileStub injected.
 * Returns a new detector — call AFTER setting up execFileStub.
 */
function makeDetector(opts = {}) {
  return createMeetingDetector({
    pollIntervalMs: 10000,
    graceMs: 0,
    timeoutMs: 3000,
    getOwnPids: () => [OWN_PID],
    ...opts,
    _execFile: (...args) => execFileStub(...args),
  });
}

describe("meeting-detector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    execFileStub = vi.fn((_cmd, _args, _opts, callback) => {
      callback(null, "");
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Mic-use detection
  // ----------------------------------------------------------------
  describe("mic-use detection", () => {
    it("should detect another app using the mic", async () => {
      mockMicUsers([ZOOM_LINE]);
      const detector = makeDetector();
      const onChange = vi.fn();
      detector.onDetectionChange(onChange);
      detector.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(detector.isDetected()).toBe(true);
      expect(detector.getDetectedApps()).toEqual(["us.zoom.xos"]);
      expect(onChange).toHaveBeenCalledWith({
        detected: true,
        apps: ["us.zoom.xos"],
      });

      detector.destroy();
    });

    it("should ignore quietpls's own mic use", async () => {
      mockMicUsers([`${OWN_PID}\tcom.quietpls.app`]);
      const detector = makeDetector();
      const onChange = vi.fn();
      detector.onDetectionChange(onChange);
      detector.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(detector.isDetected()).toBe(false);
      expect(onChange).not.toHaveBeenCalled();

      detector.destroy();
    });

    it("should ignore Siri / dictation listening (CoreSpeech) but not FaceTime", async () => {
      mockMicUsers(["547\tcom.apple.CoreSpeech"]);
      const detector = makeDetector();
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(detector.isDetected()).toBe(false);

      mockMicUsers(["547\tcom.apple.CoreSpeech", "600\tcom.apple.FaceTime"]);
      await vi.advanceTimersByTimeAsync(10000);
      expect(detector.getDetectedApps()).toEqual(["com.apple.FaceTime"]);

      detector.destroy();
    });

    it("should still detect a call while quietpls is also capturing", async () => {
      mockMicUsers([`${OWN_PID}\tcom.quietpls.app`, ZOOM_LINE]);
      const detector = makeDetector();
      detector.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(detector.getDetectedApps()).toEqual(["us.zoom.xos"]);

      detector.destroy();
    });

    it("should return empty when nothing is using the mic", async () => {
      mockMicUsers([]);
      const detector = makeDetector();
      const onChange = vi.fn();
      detector.onDetectionChange(onChange);
      detector.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(detector.isDetected()).toBe(false);
      expect(detector.getDetectedApps()).toEqual([]);
      expect(onChange).not.toHaveBeenCalled();

      detector.destroy();
    });

    it("should stop polling when the helper cannot run (e.g. macOS < 14)", async () => {
      const missing = new Error("spawn ENOENT");
      missing.code = "ENOENT";
      mockHelperError(missing);
      const detector = makeDetector();
      detector.start();

      await vi.advanceTimersByTimeAsync(30000);

      expect(execFileStub).toHaveBeenCalledTimes(1);
      expect(detector.isDetected()).toBe(false);

      detector.destroy();
    });
  });

  // ----------------------------------------------------------------
  // Helper output parsing
  // ----------------------------------------------------------------
  describe("parseMicUsers", () => {
    it("should parse pid and bundle id, tolerating blanks and a missing bundle", () => {
      expect(parseMicUsers("500\tus.zoom.xos\n\n77\t\n88\n")).toEqual([
        { pid: 500, bundleId: "us.zoom.xos" },
        { pid: 77, bundleId: "" },
        { pid: 88, bundleId: "" },
      ]);
    });

    it("should name an app without a bundle id by its pid, deduplicating bundles", async () => {
      mockMicUsers([
        "77\t",
        "500\tcom.google.Chrome",
        "501\tcom.google.Chrome",
      ]);
      const detector = makeDetector();
      detector.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(detector.getDetectedApps().sort()).toEqual([
        "com.google.Chrome",
        "pid 77",
      ]);

      detector.destroy();
    });
  });

  // ----------------------------------------------------------------
  // Callback firing on state change
  // ----------------------------------------------------------------
  describe("onDetectionChange callback", () => {
    it("should fire on state change (none -> detected, detected -> none)", async () => {
      const onChange = vi.fn();
      mockMicUsers([]);
      const detector = makeDetector();
      detector.onDetectionChange(onChange);

      // Poll 1: no meeting apps
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).not.toHaveBeenCalled();

      // Poll 2: Zoom detected
      mockMicUsers([ZOOM_LINE]);
      await vi.advanceTimersByTimeAsync(10000);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({
        detected: true,
        apps: ["us.zoom.xos"],
      });

      // Poll 3: Zoom gone (graceMs=0 so fires after setTimeout(0))
      mockMicUsers([]);
      await vi.advanceTimersByTimeAsync(10000);
      // Advance to let the setTimeout(0) grace period expire
      await vi.advanceTimersByTimeAsync(1);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith({ detected: false, apps: [] });

      detector.destroy();
    });
  });

  // ----------------------------------------------------------------
  // Timeout handling
  // ----------------------------------------------------------------
  describe("timeout handling", () => {
    it("should handle 3s timeout on the helper without crashing", async () => {
      const timeoutError = new Error("Command timed out");
      timeoutError.killed = true;
      mockHelperError(timeoutError);

      const detector = makeDetector();
      const onChange = vi.fn();
      detector.onDetectionChange(onChange);
      detector.start();

      // Should not throw
      await vi.advanceTimersByTimeAsync(0);

      expect(detector.isDetected()).toBe(false);
      expect(onChange).not.toHaveBeenCalled();

      // Should continue polling on next interval
      mockMicUsers([ZOOM_LINE]);
      await vi.advanceTimersByTimeAsync(10000);
      expect(detector.isDetected()).toBe(true);

      detector.destroy();
    });
  });

  // ----------------------------------------------------------------
  // start()/stop() lifecycle
  // ----------------------------------------------------------------
  describe("start()/stop() lifecycle", () => {
    it("should poll on start and stop polling on stop", async () => {
      mockMicUsers([]);
      const detector = makeDetector();
      detector.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(execFileStub).toHaveBeenCalledTimes(1);

      // Advance to trigger next poll
      await vi.advanceTimersByTimeAsync(10000);
      expect(execFileStub).toHaveBeenCalledTimes(2);

      // Stop polling
      detector.stop();

      // Advance further — no more polls
      await vi.advanceTimersByTimeAsync(30000);
      expect(execFileStub).toHaveBeenCalledTimes(2);

      detector.destroy();
    });

    it("should end an ongoing detection on stop (toggle turned off mid-call)", async () => {
      const onChange = vi.fn();
      mockMicUsers([ZOOM_LINE]);
      const detector = makeDetector({ graceMs: 30000 });
      detector.onDetectionChange(onChange);
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenLastCalledWith({
        detected: true,
        apps: ["us.zoom.xos"],
      });

      detector.stop();
      expect(detector.isDetected()).toBe(false);
      expect(onChange).toHaveBeenLastCalledWith({ detected: false, apps: [] });

      // Re-enabling during the same call reports it afresh
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenCalledTimes(3);
      expect(onChange).toHaveBeenLastCalledWith({
        detected: true,
        apps: ["us.zoom.xos"],
      });

      detector.destroy();
    });

    it("should cancel a pending grace period on stop (no late event)", async () => {
      const onChange = vi.fn();
      mockMicUsers([ZOOM_LINE]);
      const detector = makeDetector({ graceMs: 30000 });
      detector.onDetectionChange(onChange);
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      mockMicUsers([]);
      await vi.advanceTimersByTimeAsync(10000); // grace starts

      detector.stop();
      // Ends now, not when the grace timer would have fired; nothing fires later
      expect(onChange).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60000);
      expect(onChange).toHaveBeenCalledTimes(2);

      detector.destroy();
    });

    it("should drop the result of a poll that was in flight when stopped", async () => {
      let finish;
      execFileStub = vi.fn((_cmd, _args, _opts, callback) => {
        finish = () => callback(null, ZOOM_LINE);
      });
      const onChange = vi.fn();
      const detector = makeDetector();
      detector.onDetectionChange(onChange);
      detector.start();
      detector.stop();
      finish();
      await vi.advanceTimersByTimeAsync(0);

      expect(detector.isDetected()).toBe(false);
      expect(onChange).not.toHaveBeenCalled();

      detector.destroy();
    });

    it("should resume polling after stop then start", async () => {
      mockMicUsers([]);
      const detector = makeDetector();
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(execFileStub).toHaveBeenCalledTimes(1);

      detector.stop();
      await vi.advanceTimersByTimeAsync(30000);
      expect(execFileStub).toHaveBeenCalledTimes(1);

      // Restart
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(execFileStub).toHaveBeenCalledTimes(2);

      detector.destroy();
    });
  });

  // ----------------------------------------------------------------
  // destroy()
  // ----------------------------------------------------------------
  describe("destroy()", () => {
    it("should stop polling, clear all timers and listeners", async () => {
      const onChange = vi.fn();
      mockMicUsers([ZOOM_LINE]);
      const detector = makeDetector({ graceMs: 30000 });
      detector.onDetectionChange(onChange);

      // Detect Zoom
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Remove Zoom — grace period starts
      mockMicUsers([]);
      await vi.advanceTimersByTimeAsync(10000);

      // Destroy before grace period expires
      detector.destroy();

      // Advance past grace period — callback should NOT fire again
      await vi.advanceTimersByTimeAsync(60000);
      expect(onChange).toHaveBeenCalledTimes(1); // still just the initial detection
    });
  });

  // ----------------------------------------------------------------
  // Grace period
  // ----------------------------------------------------------------
  describe("grace period", () => {
    it("should persist detection for graceMs after last meeting app closes", async () => {
      const onChange = vi.fn();
      mockMicUsers([ZOOM_LINE]);
      const detector = makeDetector({ graceMs: 30000 });
      detector.onDetectionChange(onChange);

      // Detect Zoom
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(detector.isDetected()).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Zoom closes
      mockMicUsers([]);
      await vi.advanceTimersByTimeAsync(10000);

      // Still detected during grace period
      expect(detector.isDetected()).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(1); // no change callback yet

      // Advance halfway through grace period
      await vi.advanceTimersByTimeAsync(15000);
      expect(detector.isDetected()).toBe(true);

      // Advance past grace period
      await vi.advanceTimersByTimeAsync(20000);
      expect(detector.isDetected()).toBe(false);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith({ detected: false, apps: [] });

      detector.destroy();
    });

    it("should cancel grace period if meeting app returns before it expires", async () => {
      const onChange = vi.fn();
      mockMicUsers([ZOOM_LINE]);
      const detector = makeDetector({ graceMs: 30000 });
      detector.onDetectionChange(onChange);

      // Detect Zoom
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Zoom closes — grace period starts
      mockMicUsers([]);
      await vi.advanceTimersByTimeAsync(10000);

      // Zoom comes back within grace period
      mockMicUsers([ZOOM_LINE]);
      await vi.advanceTimersByTimeAsync(10000);

      // Should still be detected, grace cancelled
      expect(detector.isDetected()).toBe(true);

      // Advance well past original grace period — should NOT fire detected=false
      await vi.advanceTimersByTimeAsync(60000);
      // Only the initial detection callback should have fired
      expect(onChange).toHaveBeenCalledTimes(1);

      detector.destroy();
    });
  });
});
