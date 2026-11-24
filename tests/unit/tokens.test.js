const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../../tokens.css"), "utf8");
const blocks = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map((match) =>
  Object.fromEntries([...match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, key, value]) => [key, value.trim()])),
);

function luminance(hex) {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected opaque RGB: ${hex}`);
  const rgb = hex.slice(1).match(/../g).map((part) => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("Direction D WCAG 2 contrast (spec §4.1 / A11Y-1)", () => {
  for (const [index, scheme] of ["light", "dark"].entries()) {
    const tokens = { ...blocks[0], ...blocks[index] };
    describe(scheme, () => {
      // All text colours are checked on both opaque panel and grouped-row surfaces.
      // Yellow fill is paired with a dark mark and a contrasting edge, never yellow text.
      for (const foreground of ["--text", "--text-2", "--accent", "--normal", "--rising", "--loud"]) {
        for (const background of ["--surface", "--surface-2"]) {
          it(`${foreground} on ${background} is at least 4.5:1`, () => {
            expect(contrast(tokens[foreground], tokens[background])).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
      for (const background of ["--accent-fill", "--loud-fill"]) {
        it(`white label on ${background} is at least 4.5:1`, () => {
          expect(contrast(tokens["--white"], tokens[background])).toBeGreaterThanOrEqual(4.5);
        });
      }
      it("yellow state mark is readable without relying on colour", () => {
        expect(contrast(tokens["--rising-fill"], "#1d1d1f")).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});
