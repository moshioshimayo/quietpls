"use strict";

// Transcripts go to a local git repo the user picks. A repo with a remote is
// refused: one `git push` would publish every call, so we never write there.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function git(dir, args) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", dir, ...args],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr) }));
        else resolve(String(stdout));
      },
    );
  });
}

/** Parse `git remote -v` into [{ name, url }]. */
function parseRemotes(out) {
  const seen = new Map();
  for (const line of String(out).split("\n")) {
    const [name, url] = line.trim().split(/\s+/);
    if (name && url && !seen.has(name)) seen.set(name, url);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

/**
 * { ok, reason, remotes, isRepo } for a transcript folder.
 * reason: "not-chosen" | "missing" | "has-remote" | null
 */
async function checkFolder(dir) {
  if (!dir)
    return { ok: false, reason: "not-chosen", remotes: [], isRepo: false };
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    return { ok: false, reason: "missing", remotes: [], isRepo: false };
  let isRepo = true;
  try {
    await git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    isRepo = false;
  }
  const remotes = isRepo ? parseRemotes(await git(dir, ["remote", "-v"])) : [];
  if (remotes.length)
    return { ok: false, reason: "has-remote", remotes, isRepo };
  return { ok: true, reason: null, remotes, isRepo };
}

/** Make sure the folder is a git repo with no remote; init it if needed. */
async function prepareFolder(dir) {
  const check = await checkFolder(dir);
  if (!check.ok) return check;
  if (!check.isRepo) {
    await git(dir, ["init", "-q"]);
    return { ...check, isRepo: true, initialized: true };
  }
  return check;
}

async function identityArgs(dir) {
  const email = await git(dir, ["config", "user.email"]).catch(() => "");
  return email.trim()
    ? []
    : [
        "-c",
        "user.name=quietpls capture",
        "-c",
        "user.email=capture@localhost",
      ];
}

/** Write one transcript and commit just that file. Refuses repos with a remote. */
async function saveTranscript(dir, name, markdown, message) {
  const check = await prepareFolder(dir);
  if (!check.ok) {
    const err = new Error(
      check.reason === "has-remote"
        ? `The transcript folder's git repo has a remote (${check.remotes.map((r) => r.name).join(", ")}), so nothing was written there.`
        : "Choose a transcript folder first.",
    );
    err.code = check.reason;
    throw err;
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, markdown);
  await git(dir, ["add", "--", name]);
  await git(dir, [
    ...(await identityArgs(dir)),
    "commit",
    "-q",
    "--no-verify",
    "-m",
    message,
    "--",
    name,
  ]);
  const sha = (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
  return { file, sha };
}

/**
 * Always-on chunks go to <folder>/ambient/ and are kept out of git (.git/info/exclude):
 * git history would outlive the short retention window, so they are never committed.
 */
async function saveAmbient(dir, name, markdown) {
  const check = await prepareFolder(dir);
  if (!check.ok) {
    const err = new Error(
      check.reason === "has-remote"
        ? "The transcript folder's git repo has a remote, so nothing was written there."
        : "Choose a transcript folder first.",
    );
    err.code = check.reason;
    throw err;
  }
  if ((await git(dir, ["ls-files", "--", "ambient/"])).trim())
    throw new Error(
      "Ambient folder already has tracked files; choose another transcript folder.",
    );
  const prefix = (await git(dir, ["rev-parse", "--show-prefix"])).trim();
  const ignore = `/${prefix}ambient/`;
  // --git-path gives the repo's shared info/exclude, which git reads from every
  // linked worktree (a worktree's own admin dir has no effect).
  const exclude = path.resolve(
    dir,
    (await git(dir, ["rev-parse", "--git-path", "info/exclude"])).trim(),
  );
  const current = fs.existsSync(exclude)
    ? fs.readFileSync(exclude, "utf8")
    : "";
  if (!current.split("\n").includes(ignore)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(
      exclude,
      `${current && !current.endsWith("\n") ? "\n" : ""}${ignore}\n`,
    );
  }
  try {
    await git(dir, ["check-ignore", "-q", "--", `ambient/${name}`]);
  } catch {
    throw new Error(
      "Couldn't keep the ambient folder out of git; nothing was written.",
    );
  }
  fs.mkdirSync(path.join(dir, "ambient"), { recursive: true });
  const file = path.join(dir, "ambient", name);
  fs.writeFileSync(file, markdown);
  return { file, sha: null };
}

module.exports = {
  checkFolder,
  prepareFolder,
  saveTranscript,
  saveAmbient,
  parseRemotes,
};
