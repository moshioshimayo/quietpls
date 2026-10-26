"use strict";

/**
 * input-transports.js — main process: CoreAudio transport type of each audio
 * input (built-in, USB, Bluetooth, ...) and which one is the system default,
 * read from `system_profiler SPAudioDataType -json` (~0.2 s, no native code).
 * Chromium's device labels don't say "Bluetooth", so mic-policy.js needs this.
 *
 * Result: { inputs: [{ name, transport, isDefault }] }, or null when unknown.
 */

const { execFile } = require("child_process");

const SYSTEM_PROFILER = "/usr/sbin/system_profiler";

/** Parse `system_profiler SPAudioDataType -json` output. */
function parseAudioProfile(json) {
  let data;
  try {
    data = typeof json === "string" ? JSON.parse(json) : json;
  } catch (_) {
    return null;
  }
  const groups = data && data.SPAudioDataType;
  if (!Array.isArray(groups)) return null;
  const inputs = [];
  for (const group of groups) {
    for (const item of (group && group._items) || []) {
      if (!item || !(Number(item.coreaudio_device_input) > 0)) continue;
      inputs.push({
        name: String(item._name || ""),
        transport: String(item.coreaudio_device_transport || "").replace(
          /^coreaudio_device_type_/,
          "",
        ),
        isDefault: item.coreaudio_default_audio_input_device === "spaudio_yes",
      });
    }
  }
  return { inputs };
}

function createInputTransports(options) {
  const o = options || {};
  const run =
    o.run ||
    (() =>
      new Promise((resolve) => {
        execFile(
          SYSTEM_PROFILER,
          ["SPAudioDataType", "-json"],
          { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout) => resolve(err ? null : stdout),
        );
      }));
  /** A fresh read every time: never cached, never shared with a read that
   * started earlier, so a default that just changed is never misattributed. */
  function get() {
    return Promise.resolve()
      .then(run)
      .then((out) => (out ? parseAudioProfile(out) : null))
      .catch(() => null);
  }

  return { get };
}

module.exports = { parseAudioProfile, createInputTransports };
