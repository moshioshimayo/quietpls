import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const mainUrl = new URL("../../main.js", import.meta.url);
const mainRequire = createRequire(mainUrl);
// Execute the actual startup migration before Electron's window/IPC setup.
const startup = readFileSync(mainUrl, "utf8").split("\nfunction clampSensitivity")[0];

function launch(calibrations) {
  let saved = calibrations;
  const set = vi.fn((_key, value) => { saved = value; });
  const store = { get: () => saved, set };
  runInNewContext(startup, {
    process: { env: {} },
    require(id) {
      if (id === "electron") return { app: { isPackaged: false } };
      if (id === "electron-store") return function Store() { return store; };
      if (id === "electron-updater") return {};
      return mainRequire(id);
    },
  });
  return { saved, set };
}

describe("calibration startup migration", () => {
  it("keeps the v3 baseline and drops the v2 baseline on launch", () => {
    const current = { version: 3, baselineDb: -30, deviceId: "built-in" };
    const old = { version: 2, baselineDb: -25, deviceId: "usb" };
    const first = launch({ "built-in": current, usb: old });
    expect(first.saved).toEqual({ "built-in": current });
    expect(first.set).toHaveBeenCalledTimes(1);

    const second = launch(first.saved);
    expect(second.saved).toEqual({ "built-in": current });
    expect(second.set).not.toHaveBeenCalled();
  });
});
