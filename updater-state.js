// Update-state machine for the tray menu action.
// States: idle -> checking -> (downloading -> ready | idle)
// ready is set ONLY by update-downloaded; any error resets to idle so the
// tray shows "Check for Updates…" and a manual retry works.

const LABELS = {
  idle: "Check for Updates…",
  checking: "Checking for Updates…",
  downloading: "Downloading Update…",
  ready: "Restart to Update",
};

function createUpdaterState() {
  let state = "idle";
  let version = null;

  return {
    get state() {
      return state;
    },
    get version() {
      return version;
    },
    get checking() {
      return state === "checking";
    },
    get available() {
      return state === "ready";
    },
    get label() {
      return state === "ready" && version
        ? `${LABELS.ready} (${version})…`
        : LABELS[state];
    },
    get enabled() {
      // Downloading/ready actions are routed internally; the menu item stays
      // clickable unless a check/download is in flight.
      return state === "idle" || state === "ready";
    },
    onChecking() {
      state = "checking";
    },
    onAvailable(v) {
      // Metadata discovered; with autoDownload the download starts now.
      // This is NOT ready — a failed download must fall back to retryable.
      if (state === "checking") {
        state = "downloading";
        version = v || version;
      }
    },
    onProgress() {
      if (state === "downloading") state = "downloading";
    },
    onDownloaded(v) {
      state = "ready";
      version = v || version;
    },
    onNotAvailable() {
      state = "idle";
      version = null;
    },
    onError() {
      // Failed/interrupted check or download: back to retryable idle
      state = "idle";
    },
  };
}

module.exports = { createUpdaterState };
