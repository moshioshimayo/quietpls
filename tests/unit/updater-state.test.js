import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { createUpdaterState } = require("../../updater-state");

describe("updater-state (tray action state machine)", () => {
  it("starts retryable in idle with Check-for-Updates label", () => {
    const s = createUpdaterState();
    expect(s.state).toBe("idle");
    expect(s.label).toBe("Check for Updates…");
    expect(s.enabled).toBe(true);
    expect(s.available).toBe(false);
  });

  it("goes checking -> downloading when an update is discovered (NOT ready)", () => {
    const s = createUpdaterState();
    s.onChecking();
    expect(s.state).toBe("checking");
    expect(s.enabled).toBe(false);
    s.onAvailable("2.0.1");
    // Old bug: update-available alone flipped to available/Restart-to-Update.
    expect(s.available).toBe(false);
    expect(s.state).toBe("downloading");
    expect(s.label).toBe("Downloading Update…");
  });

  it("reaches ready (Restart to Update) only after update-downloaded", () => {
    const s = createUpdaterState();
    s.onChecking();
    s.onAvailable("2.0.1");
    s.onProgress();
    expect(s.state).toBe("downloading");
    s.onDownloaded("2.0.1");
    expect(s.state).toBe("ready");
    expect(s.available).toBe(true);
    expect(s.label).toBe("Restart to Update (2.0.1)…");
    expect(s.enabled).toBe(true);
  });

  it("a failed/interrupted download resets to retryable idle (regression: old behavior kept Restart to Update)", () => {
    const s = createUpdaterState();
    s.onChecking();
    s.onAvailable("2.0.1");
    // download starts, then fails
    s.onError();
    // The old code only cleared `checking` on error, leaving available=true and
    // the tray routing a dead quitAndInstall with no retry.
    expect(s.state).toBe("idle");
    expect(s.available).toBe(false);
    expect(s.label).toBe("Check for Updates…");
    expect(s.enabled).toBe(true);
  });

  it("a failed check (no update discovered yet) also resets to idle", () => {
    const s = createUpdaterState();
    s.onChecking();
    s.onError();
    expect(s.state).toBe("idle");
    expect(s.enabled).toBe(true);
  });

  it("update-not-available clears any stale version", () => {
    const s = createUpdaterState();
    s.onChecking();
    s.onAvailable("2.0.1");
    s.onDownloaded("2.0.1");
    // next hourly check after the user already updated elsewhere
    s.onNotAvailable();
    expect(s.state).toBe("idle");
    expect(s.version).toBeNull();
  });

  it("ready survives idle chatter and stays actionable until acted on", () => {
    const s = createUpdaterState();
    s.onChecking();
    s.onAvailable("2.0.1");
    s.onDownloaded("2.0.1");
    expect(s.available).toBe(true);
    expect(s.version).toBe("2.0.1");
  });
});
