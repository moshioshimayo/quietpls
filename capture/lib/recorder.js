"use strict";

// Shell-independent transport for the native stereo capture helper.
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

function startCapture({
  output,
  excludePids = [],
  onMessage,
  onStderr = () => {},
  onExit,
  helper = path.join(__dirname, "..", "..", "bin", "capture"),
}) {
  const child = spawn(
    helper,
    [
      "--out",
      output,
      ...excludePids.flatMap((p) => ["--exclude-pid", String(p)]),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    onMessage(msg);
  });
  child.stderr.on("data", (d) => onStderr(String(d)));
  let finished = false;
  function finish(code) {
    if (!finished) {
      finished = true;
      onExit(code);
    }
  }
  child.on("error", (e) => {
    onMessage({ type: "error", code: "launch-failed", detail: e.message });
    finish(2);
  });
  child.on("close", finish);
  return child;
}

module.exports = { startCapture };
