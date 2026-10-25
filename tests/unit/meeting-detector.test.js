import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createMeetingDetector } = require('../../meeting-detector');

let execFileStub;

/**
 * Helper: create a mock execFile that calls back with given ps output lines.
 */
function mockPsOutput(lines) {
  execFileStub = vi.fn((_cmd, _args, _opts, callback) => {
    callback(null, lines.join('\n'));
  });
}

/**
 * Helper: create a mock execFile that calls back with an error.
 */
function mockPsError(err) {
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
    ...opts,
    _execFile: (...args) => execFileStub(...args),
  });
}

describe('meeting-detector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileStub = vi.fn((_cmd, _args, _opts, callback) => {
      callback(null, '');
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Process detection
  // ----------------------------------------------------------------
  describe('process detection', () => {
    it('should detect Zoom (zoom.us in ps output)', async () => {
      mockPsOutput(['zoom.us', 'loginwindow', 'Finder']);
      const detector = makeDetector();
      const onChange = vi.fn();
      detector.onDetectionChange(onChange);
      detector.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(detector.isDetected()).toBe(true);
      expect(detector.getDetectedApps()).toEqual(['Zoom']);
      expect(onChange).toHaveBeenCalledWith({ detected: true, apps: ['Zoom'] });

      detector.destroy();
    });

    it('should detect multiple apps simultaneously (zoom.us + Slack)', async () => {
      mockPsOutput(['zoom.us', 'Slack', 'Finder']);
      const detector = makeDetector();
      const onChange = vi.fn();
      detector.onDetectionChange(onChange);
      detector.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(detector.isDetected()).toBe(true);
      const apps = detector.getDetectedApps();
      expect(apps).toContain('Zoom');
      expect(apps).toContain('Slack');
      expect(apps.length).toBe(2);

      detector.destroy();
    });

    it('should return empty when no meeting apps are running', async () => {
      mockPsOutput(['loginwindow', 'Finder', 'WindowServer']);
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
  });

  // ----------------------------------------------------------------
  // Deduplication
  // ----------------------------------------------------------------
  describe('deduplication', () => {
    it('should deduplicate zoom.us + CptHost into one "Zoom" entry', async () => {
      mockPsOutput(['zoom.us', 'CptHost', 'Finder']);
      const detector = makeDetector();
      detector.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(detector.getDetectedApps()).toEqual(['Zoom']);

      detector.destroy();
    });
  });

  // ----------------------------------------------------------------
  // Callback firing on state change
  // ----------------------------------------------------------------
  describe('onDetectionChange callback', () => {
    it('should fire on state change (none -> detected, detected -> none)', async () => {
      const onChange = vi.fn();
      mockPsOutput(['Finder']);
      const detector = makeDetector();
      detector.onDetectionChange(onChange);

      // Poll 1: no meeting apps
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).not.toHaveBeenCalled();

      // Poll 2: Zoom detected
      mockPsOutput(['zoom.us']);
      await vi.advanceTimersByTimeAsync(10000);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({ detected: true, apps: ['Zoom'] });

      // Poll 3: Zoom gone (graceMs=0 so fires after setTimeout(0))
      mockPsOutput(['Finder']);
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
  describe('timeout handling', () => {
    it('should handle 3s timeout on ps command without crashing', async () => {
      const timeoutError = new Error('Command timed out');
      timeoutError.killed = true;
      mockPsError(timeoutError);

      const detector = makeDetector();
      const onChange = vi.fn();
      detector.onDetectionChange(onChange);
      detector.start();

      // Should not throw
      await vi.advanceTimersByTimeAsync(0);

      expect(detector.isDetected()).toBe(false);
      expect(onChange).not.toHaveBeenCalled();

      // Should continue polling on next interval
      mockPsOutput(['zoom.us']);
      await vi.advanceTimersByTimeAsync(10000);
      expect(detector.isDetected()).toBe(true);

      detector.destroy();
    });
  });

  // ----------------------------------------------------------------
  // start()/stop() lifecycle
  // ----------------------------------------------------------------
  describe('start()/stop() lifecycle', () => {
    it('should poll on start and stop polling on stop', async () => {
      mockPsOutput(['Finder']);
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

    it('should resume polling after stop then start', async () => {
      mockPsOutput(['Finder']);
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
  describe('destroy()', () => {
    it('should stop polling, clear all timers and listeners', async () => {
      const onChange = vi.fn();
      mockPsOutput(['zoom.us']);
      const detector = makeDetector({ graceMs: 30000 });
      detector.onDetectionChange(onChange);

      // Detect Zoom
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Remove Zoom — grace period starts
      mockPsOutput(['Finder']);
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
  describe('grace period', () => {
    it('should persist detection for graceMs after last meeting app closes', async () => {
      const onChange = vi.fn();
      mockPsOutput(['zoom.us']);
      const detector = makeDetector({ graceMs: 30000 });
      detector.onDetectionChange(onChange);

      // Detect Zoom
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(detector.isDetected()).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Zoom closes
      mockPsOutput(['Finder']);
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

    it('should cancel grace period if meeting app returns before it expires', async () => {
      const onChange = vi.fn();
      mockPsOutput(['zoom.us']);
      const detector = makeDetector({ graceMs: 30000 });
      detector.onDetectionChange(onChange);

      // Detect Zoom
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Zoom closes — grace period starts
      mockPsOutput(['Finder']);
      await vi.advanceTimersByTimeAsync(10000);

      // Zoom comes back within grace period
      mockPsOutput(['zoom.us']);
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
