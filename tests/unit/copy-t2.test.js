import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const path = require("node:path");
const {
  OWNER_FILES, loadExpectations, readUI, sourceText, normalize,
  assertRenderedCopy, copyViolations, bannedCopyViolations,
} = require("./copy-helpers");

const ROOT = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
require("../../onboarding-renderer.js");
const { statusAnnouncement, micNote } = globalThis.__onboardingHelpers;

// Authored visible text only: sentences, labels and titles. Channel names,
// URLs, CSS selectors and internal status ids are not UI copy.
function authored(file) {
  return sourceText(file, read(file)).split("\n").map(normalize)
    .filter((text) => /[A-Za-z]/.test(text) && / /.test(text) && !/^(x-apple|#|\[)|=>|\$\{/.test(text));
}

describe("T2 copy: setup window, permission dialogs, purpose strings", () => {
  it("ships every T2 CR row and removes obsolete literals", () => {
    expect(copyViolations("T2")).toEqual([]);
  });

  it("renders the reviewed access announcements", () => {
    assertRenderedCopy("CR-078", statusAnnouncement("granted"));
    assertRenderedCopy("CR-079", statusAnnouncement("denied"));
    assertRenderedCopy("CR-080", statusAnnouncement("restricted"));
    assertRenderedCopy("CR-081", statusAnnouncement("error"));
  });

  it("keeps T2 rows free of placeholders (no unrendered templates)", () => {
    const rows = loadExpectations().filter((row) => row.owner === "T2" && row.action !== "retire");
    expect(rows.length).toBe(40);
    expect(rows.filter((row) => row.expected === null)).toEqual([]);
  });

  it("has no banned vocabulary in authored setup, dialog or purpose text", () => {
    const messages = [
      ...authored("onboarding.html"),
      ...authored("onboarding-renderer.js"),
      ...authored("permission-manager.js"),
      ...authored("electron-builder.yml"),
      statusAnnouncement("granted"), statusAnnouncement("error"),
      micNote({ reason: "avoid-bluetooth" }, [{ label: "AirPods Pro" }]),
      micNote({ reason: "avoid-bluetooth" }, []),
    ];
    expect(messages.length).toBeGreaterThan(30);
    expect(bannedCopyViolations(messages)).toEqual([]);
  });

  it("spec §9.1 / AC-O5: the access-off screen never offers Allow Microphone and Restart only after a mic failure", () => {
    const html = normalize(sourceText("onboarding.html", read("onboarding.html")));
    expect(html).not.toContain("Allow Microphone");
    const off = read("onboarding.html").match(/data-panel="off"[^]*?<\/section>/)[0];
    expect(off).not.toContain("Restart");
    expect(off).toContain("Open System Settings");
    expect(off).toContain("Check again");
  });

  it("covers every T2 file the aggregate scans", () => {
    expect(Object.keys(readUI())).toEqual(expect.arrayContaining(OWNER_FILES.T2));
  });
});
