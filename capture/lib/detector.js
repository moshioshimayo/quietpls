"use strict";

// A call is "detected" while another process is capturing the mic (Zoom, Teams,
// Meet in a browser, FaceTime...). Detection itself is quietpls's meeting-detector.js
// (the bin/mic-users helper); this module only turns its app ids ("us.zoom.xos",
// "pid 123") into the names shown on the consent banner and used in file names.
const path = require("path");
const { createMeetingDetector } = require("../../meeting-detector");

// Not calls: quietpls itself (its pids are excluded too). macOS speech services
// are already filtered by meeting-detector.js.
const NOT_CALLS = /^com\.quietpls\.app/i;

const KNOWN_APPS = {
  "us.zoom.xos": "Zoom",
  "com.microsoft.teams2": "Microsoft Teams",
  "com.microsoft.teams": "Microsoft Teams",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.hnc.Discord": "Discord",
  "com.apple.FaceTime": "FaceTime",
  "com.cisco.webexmeetingsapp": "Webex",
  "com.google.Chrome": "Google Chrome",
  "com.apple.Safari": "Safari",
  "company.thebrowser.Browser": "Arc",
  "org.mozilla.firefox": "Firefox",
  "com.microsoft.edgemac": "Microsoft Edge",
  "net.whatsapp.WhatsApp": "WhatsApp",
  "com.apple.Terminal": "Terminal",
};

/** Friendly, sorted names for meeting-detector app ids ("bundle.id" or "pid N"). */
function callApps(ids, nameForPid = () => "") {
  const names = new Set();
  for (const id of ids) {
    if (NOT_CALLS.test(id)) continue;
    const pid = /^pid (\d+)$/.exec(id);
    names.add(
      KNOWN_APPS[id] ||
        (pid && (nameForPid(Number(pid[1])) || `process ${pid[1]}`)) ||
        id,
    );
  }
  return [...names].sort();
}

function processName(pid) {
  try {
    const out = require("child_process").execFileSync(
      "ps",
      ["-p", String(pid), "-o", "comm="],
      { encoding: "utf8" },
    );
    return path.basename(out.trim());
  } catch {
    return "";
  }
}

/**
 * Calls onChange({ apps }) with friendly names when the set of call apps changes.
 * A separate meeting-detector instance from the monitoring one, so turning capture
 * on or off never touches quietpls's own auto-start.
 */
function createDetector({
  onChange,
  getOwnPids,
  pollMs = 2000,
  graceMs = 8000,
  helperPath,
  execFile,
  nameForPid = processName,
}) {
  const d = createMeetingDetector({
    pollIntervalMs: pollMs,
    graceMs,
    getOwnPids,
    ...(helperPath && { helperPath }),
    ...(execFile && { _execFile: execFile }),
  });
  let current = [];
  d.onDetectionChange(({ apps }) => {
    const names = callApps(apps, nameForPid);
    if (names.join("\n") === current.join("\n")) return;
    current = names;
    onChange({ apps: names });
  });
  return {
    start: () => d.start(),
    stop: () => d.stop(),
    get apps() {
      return current;
    },
  };
}

module.exports = { createDetector, callApps };
