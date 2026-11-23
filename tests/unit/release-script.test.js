import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// Runs a temp copy of scripts/release.sh with stub npx/xcrun/security/spctl on
// PATH that log their argv, environment and stdin, so we can check the Apple
// app-specific password never reaches a command line (spec A4).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SENTINEL = "sentinel-app-pw-7f3a9c";
const SEP = "\x1f";

const STUB = `#!/bin/bash
name="$(basename "$0")"
{ printf '%s' "$name"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\n'; } >> "$STUB_LOG/argv"
case "$name" in
  xcrun)
    if [ "$1 $2" = "notarytool store-credentials" ]; then cat > "$STUB_LOG/stdin"; exit "\${FAIL_STORE:-0}"; fi
    if [ "$1 $2" = "notarytool submit" ]; then echo "  id: sub-123"; fi ;;
  security)
    if [ "$1" = "list-keychains" ] && [ "$3" != "-s" ]; then echo '    "/fake/login.keychain-db"'; fi ;;
  npx)
    env > "$STUB_LOG/npx-env"
    [ -n "\${TERM_BUILD:-}" ] && kill -TERM "$PPID"
    exit "\${FAIL_BUILD:-0}" ;;
esac
exit 0
`;

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "release-sh-"));
  for (const d of ["repo/scripts", "repo/dist", "bin", "log", "tmp"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "scripts/release.sh"), path.join(tmp, "repo/scripts/release.sh"));
  fs.writeFileSync(path.join(tmp, "repo/scripts/build-native.sh"), "exit 0\n");
  fs.writeFileSync(path.join(tmp, "repo/package.json"), '{"version":"0.0.0"}\n');
  fs.writeFileSync(path.join(tmp, "repo/dist/quietpls-0.0.0-arm64.dmg"), "");
  for (const n of ["npx", "xcrun", "security", "spctl"]) fs.writeFileSync(path.join(tmp, "bin", n), STUB, { mode: 0o755 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(extraEnv) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(APPLE_|NOTARY_PROFILE$|MAC_SIGNING_IDENTITY$|CSC_NAME$)/.test(k)) env[k] = v;
  }
  Object.assign(env, {
    PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`,
    TMPDIR: path.join(tmp, "tmp"),
    STUB_LOG: path.join(tmp, "log"),
    ...extraEnv,
  });
  const res = spawnSync("bash", [path.join(tmp, "repo/scripts/release.sh")], { env, encoding: "utf8" });
  const read = (f) => (fs.existsSync(path.join(tmp, "log", f)) ? fs.readFileSync(path.join(tmp, "log", f), "utf8") : "");
  const calls = read("argv").split("\n").filter(Boolean).map((l) => l.split(SEP));
  const npxEnv = Object.fromEntries(
    read("npx-env").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  );
  return { status: res.status, out: res.stdout + res.stderr, calls, npxEnv, stdin: read("stdin") };
}

const APPLE = { APPLE_ID: "dev@example.com", APPLE_APP_SPECIFIC_PASSWORD: SENTINEL, APPLE_TEAM_ID: "TEAM123" };
const find = (calls, ...prefix) => calls.filter((c) => prefix.every((p, i) => c[i] === p));
const keychainOf = (calls) => find(calls, "security", "create-keychain").at(-1)?.at(-1);

function expectCleanedUp(r) {
  const kc = keychainOf(r.calls);
  expect(kc).toMatch(/notary\.keychain-db$/);
  expect(find(r.calls, "security", "delete-keychain").map((c) => c[2])).toContain(kc);
  expect(fs.existsSync(path.dirname(kc))).toBe(false);
  expect(fs.readdirSync(path.join(tmp, "tmp"))).toEqual([]);
}

describe("scripts/release.sh notarization credentials", () => {
  it("never puts the Apple password on a command line and cleans up the throwaway keychain", () => {
    const r = run(APPLE);
    expect(r.status, r.out).toBe(0);

    for (const c of r.calls) expect(c.join(" ")).not.toContain(SENTINEL);
    expect(r.out).not.toContain(SENTINEL);

    const store = find(r.calls, "xcrun", "notarytool", "store-credentials");
    expect(store).toHaveLength(1);
    expect(r.stdin).toBe(SENTINEL);
    const kc = keychainOf(r.calls);
    expect(store[0]).toEqual(expect.arrayContaining(["quietpls-release", "--keychain", kc, "--validate"]));
    expect(find(r.calls, "security", "list-keychains", "-d", "user", "-s")).toEqual([
      ["security", "list-keychains", "-d", "user", "-s", "/fake/login.keychain-db"],
    ]);

    expect(r.npxEnv.APPLE_KEYCHAIN_PROFILE).toBe("quietpls-release");
    expect(r.npxEnv.APPLE_KEYCHAIN).toBe(kc);
    for (const k of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
      expect(r.npxEnv).not.toHaveProperty(k);
    }
    expect(Object.values(r.npxEnv).join("\n")).not.toContain(SENTINEL);
    expect(find(r.calls, "npx")[0]).toContain("--config.mac.notarize=true");

    for (const step of ["submit", "wait"]) {
      const c = find(r.calls, "xcrun", "notarytool", step);
      expect(c).toHaveLength(1);
      expect(c[0]).toEqual(expect.arrayContaining(["--keychain-profile", "quietpls-release", "--keychain", kc]));
    }
    expectCleanedUp(r);
  });

  it("cleans up when the build fails", () => {
    const r = run({ ...APPLE, FAIL_BUILD: "1" });
    expect(r.status).not.toBe(0);
    expect(find(r.calls, "xcrun", "notarytool", "submit")).toHaveLength(0);
    expectCleanedUp(r);
  });

  it("cleans up when storing/validating the credential fails", () => {
    const r = run({ ...APPLE, FAIL_STORE: "1" });
    expect(r.status).not.toBe(0);
    expect(find(r.calls, "npx")).toHaveLength(0);
    expectCleanedUp(r);
  });

  it("cleans up when terminated mid-build", () => {
    const r = run({ ...APPLE, TERM_BUILD: "1" });
    expect(r.status).toBe(143);
    expect(find(r.calls, "xcrun", "notarytool", "submit")).toHaveLength(0);
    expectCleanedUp(r);
  });

  it("uses an existing NOTARY_PROFILE for both electron-builder and the DMG loop", () => {
    const r = run({ ...APPLE, NOTARY_PROFILE: "my-profile", APPLE_KEYCHAIN: "/elsewhere" });
    expect(r.status, r.out).toBe(0);
    expect(find(r.calls, "security")).toHaveLength(0);
    expect(r.npxEnv.APPLE_KEYCHAIN_PROFILE).toBe("my-profile");
    expect(r.npxEnv).not.toHaveProperty("APPLE_KEYCHAIN");
    expect(r.npxEnv).not.toHaveProperty("APPLE_APP_SPECIFIC_PASSWORD");
    for (const c of r.calls) expect(c.join(" ")).not.toContain(SENTINEL);
    expect(find(r.calls, "xcrun", "notarytool", "submit")[0]).toEqual(
      expect.arrayContaining(["--keychain-profile", "my-profile"])
    );
  });

  it("skips notarization without credentials", () => {
    const r = run({});
    expect(r.status, r.out).toBe(0);
    expect(find(r.calls, "npx"), r.out).toHaveLength(1);
    expect(find(r.calls, "npx")[0]).not.toContain("--config.mac.notarize=true");
    expect(find(r.calls, "xcrun")).toHaveLength(0);
    expect(find(r.calls, "security")).toHaveLength(0);
  });
});
