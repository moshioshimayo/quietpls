import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

describe("config.js", () => {
  describe("defaultSettings", () => {
    it("defaults to neutral sensitivity and the system default mic", () => {
      const { defaultSettings } = require("../../config");
      expect(defaultSettings).toEqual({ sensitivity: 0, audioDeviceId: "" });
    });

    it("no longer exports score thresholds dressed up as acoustic dB", () => {
      const config = require("../../config");
      expect(config.defaultThresholds).toBeUndefined();
    });
  });

  describe("store name constants", () => {
    it("should export SETTINGS_STORE as quietpls-settings", () => {
      const { SETTINGS_STORE } = require("../../config");
      expect(SETTINGS_STORE).toBe("quietpls-settings");
    });

    it("should not export cloud/auth config (removed in v2.0 OSS)", () => {
      const config = require("../../config");
      expect(config.websiteUrl).toBeUndefined();
      expect(config.supabaseConfig).toBeUndefined();
      expect(config.AUTH_STORE).toBeUndefined();
    });
  });
});
