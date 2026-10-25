import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

describe("config.js", () => {
  describe("defaultThresholds", () => {
    it("should export correct default thresholds", () => {
      const { defaultThresholds } = require("../../config");
      expect(defaultThresholds).toEqual({
        quietThreshold: 30,
        normalThreshold: 50,
        warningThreshold: 78,
      });
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
