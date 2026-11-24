const fs = require("node:fs");
const path = require("node:path");
const { loadExpectations, OWNER_FILES, textVariants, copyViolations,
  bannedCopyViolations } = require("./copy-helpers");

const rows = loadExpectations();

describe("reviewed copy contract", () => {
  it("reconciles all 433 CR rows to an owner and a literal, template or retirement", () => {
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length:433 }, (_, i) => `CR-${String(i + 1).padStart(3, "0")}`));
    for (const row of rows) {
      expect(Object.keys(OWNER_FILES)).toContain(row.owner);
      expect(["retain", "change", "retire"]).toContain(row.action);
      expect(typeof row.old).toBe("string");
      if (row.action === "retire") {
        expect(row.expected).toBeNull();
        expect(row.reason).toBeTruthy();
      } else if (row.expected === null) {
        expect(row.template).toBeTruthy();
        expect(row.placeholders).toEqual([...new Set(textVariants(row).flatMap((variant) => [...variant.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1])))].sort());
      } else {
        expect(typeof row.expected).toBe("string");
        expect(row.expected).not.toMatch(/\{[^{}]+\}/);
      }
    }
  });

  it("keeps authored target copy free of banned vocabulary", () => {
    const authored = rows.filter((row) => !row.diagnostic && row.action !== "retire")
      .flatMap(textVariants).map((text) => text.replace(/\{[^{}]+\}/g, ""));
    expect(bannedCopyViolations(authored)).toEqual([]);
  });
});

// T0 establishes the contract before T1–T4 rewrite their surfaces. These four
// checks are explicitly deferred until the corresponding team's test arrives;
// integration automatically enables them. Placeholder/rendered and vocabulary
// assertions are the owning copy-tN test's responsibility via copy-helpers.
for (const owner of Object.keys(OWNER_FILES)) {
  const integrated = fs.existsSync(path.join(__dirname, `copy-${owner.toLowerCase()}.test.js`));
  it.skipIf(!integrated)(`${owner}: shipped UI contains target copy and removes obsolete literals`, () => {
    expect(copyViolations(owner)).toEqual([]);
  });
}
