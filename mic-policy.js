"use strict";

/**
 * mic-policy.js — which microphone quietpls opens (2.1.1).
 *
 * Opening a Bluetooth headset's mic makes macOS switch the headset from
 * A2DP (stereo, hi-fi) to HFP (mono, call quality), so everything the user
 * hears turns tinny. So, unless the user explicitly picked a mic:
 *   - the system default is followed when it is not Bluetooth;
 *   - a Bluetooth default is skipped for the built-in mic, then a wired/USB
 *     mic;
 *   - only when neither exists is the Bluetooth mic used ("bluetooth-only",
 *     the caller shows a one-time note).
 * An explicit pick is always respected, Bluetooth or not.
 *
 * Chromium labels carry "(Built-in)" and USB "(vid:pid)" but nothing for
 * Bluetooth, so Bluetooth comes from CoreAudio transport types read in the
 * main process (input-transports.js) and is matched to Chromium devices by
 * the "default" entry's groupId and by name.
 *
 * Dual export: CommonJS + window.MicPolicy.
 */
(function () {
  const VIRTUAL_IDS = ["default", "communications", ""];
  const BUILTIN_LABEL = /\(Built-in\)\s*$/i;
  const USB_LABEL = /\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i;
  const WIRED_TRANSPORTS = [
    "usb",
    "thunderbolt",
    "pci",
    "firewire",
    "hdmi",
    "displayport",
    "avb",
  ];

  function normalizeName(s) {
    return String(s || "")
      .replace(/^(Default|Communications) - /, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/[\u2018\u2019\u02BC]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function categoryOf(transport) {
    const t = String(transport || "").toLowerCase();
    if (t === "builtin") return "builtin";
    if (t.indexOf("bluetooth") === 0) return "bluetooth";
    if (WIRED_TRANSPORTS.indexOf(t) !== -1) return "wired";
    return "other";
  }

  /** CoreAudio inputs whose name matches a Chromium label (macOS may shorten
   * Bluetooth names, e.g. "John's AirPods" → "AirPods"). Exact first. */
  function matchByName(label, coreInputs) {
    const n = normalizeName(label);
    if (!n) return [];
    const exact = coreInputs.filter((c) => normalizeName(c.name) === n);
    if (exact.length) return exact;
    return coreInputs.filter((c) => normalizeName(c.name).endsWith(" " + n));
  }

  /**
   * Physical audio inputs with a category: builtin | wired | bluetooth | other.
   * The system default is flagged `unresolved` when the CoreAudio snapshot
   * can't be tied to it (e.g. a snapshot taken before AirPods became the
   * default still names the built-in mic as default): callers must not
   * trust it as non-Bluetooth and should read the transports again.
   * @param devices   enumerateDevices() result
   * @param transports { inputs: [{ name, transport, isDefault }] } or null
   *                   when the transport types are unknown
   */
  function classifyInputs(devices, transports) {
    const all = (devices || []).filter((d) => d && d.kind === "audioinput");
    const def = all.find((d) => d.deviceId === "default");
    const physical = all.filter((d) => !VIRTUAL_IDS.includes(d.deviceId));
    let defaultPhysical = null;
    if (def) {
      const sameGroup = physical.filter(
        (d) => def.groupId && d.groupId === def.groupId,
      );
      defaultPhysical =
        sameGroup.find(
          (d) => normalizeName(d.label) === normalizeName(def.label),
        ) ||
        sameGroup[0] ||
        physical.find(
          (d) => normalizeName(d.label) === normalizeName(def.label),
        ) ||
        null;
    }
    const coreInputs = (transports && transports.inputs) || [];
    const coreDefault = coreInputs.find((c) => c.isDefault) || null;
    // A Chromium default whose label matches no CoreAudio name may take the
    // snapshot default's transport only when that makes it Bluetooth (the
    // safe direction: a stale snapshot can then only avoid a mic, never
    // open one) and no other current device owns that name.
    const coreDefaultFree =
      !!coreDefault &&
      categoryOf(coreDefault.transport) === "bluetooth" &&
      !physical.some(
        (d) =>
          d !== defaultPhysical &&
          matchByName(d.label, [coreDefault]).length > 0,
      );

    return physical.map((d) => {
      let category = "other";
      let unresolved = false;
      if (BUILTIN_LABEL.test(d.label || "")) category = "builtin";
      else if (USB_LABEL.test(d.label || "")) category = "wired";
      else {
        const matches = matchByName(d.label, coreInputs);
        let core = matches.find((c) => c.isDefault) || matches[0] || null;
        if (!core && d === defaultPhysical && coreDefaultFree)
          core = coreDefault;
        if (core) category = categoryOf(core.transport);
        else if (transports && d === defaultPhysical) unresolved = true;
      }
      return {
        deviceId: d.deviceId,
        label: d.label || "",
        groupId: d.groupId || "",
        category,
        bluetooth: category === "bluetooth",
        isDefault: d === defaultPhysical,
        unresolved,
      };
    });
  }

  function pick(input, reason, unresolved) {
    return {
      deviceId: input.deviceId,
      label: input.label,
      bluetooth: input.bluetooth,
      reason,
      unresolved: !!unresolved,
    };
  }

  /**
   * Decide the device to open. Returns { deviceId, label, bluetooth, reason }
   * with reason one of:
   *   explicit        the user's Settings pick (may be Bluetooth)
   *   default         the system default (not Bluetooth), or unknown
   *   avoid-bluetooth the default is Bluetooth; using built-in/wired instead
   *   unresolved      the default's transport is unknown (stale snapshot);
   *                   using built-in/wired until it is read again
   *   bluetooth-only  no other mic: using the Bluetooth one
   * `unresolved: true` asks the caller to re-read the transports.
   * deviceId "" means "let the system choose" (nothing could be classified).
   */
  function chooseInput(preferredId, devices, transports) {
    const inputs = classifyInputs(devices, transports);
    if (preferredId) {
      const chosen = inputs.find((d) => d.deviceId === preferredId);
      if (chosen) return pick(chosen, "explicit");
    }
    const def = inputs.find((d) => d.isDefault);
    if (def && !def.bluetooth && !def.unresolved) return pick(def, "default");
    const alternative =
      inputs.find((d) => d.category === "builtin") ||
      inputs.find((d) => d.category === "wired");
    if (alternative) {
      if (!def) return pick(alternative, "default");
      return def.unresolved
        ? pick(alternative, "unresolved", true)
        : pick(alternative, "avoid-bluetooth");
    }
    if (def && def.unresolved) return pick(def, "default", true);
    if (def) return pick(def, "bluetooth-only");
    const anyNonBluetooth = inputs.find((d) => !d.bluetooth);
    if (anyNonBluetooth) return pick(anyNonBluetooth, "default");
    if (inputs[0]) return pick(inputs[0], "bluetooth-only");
    return {
      deviceId: "",
      label: "",
      bluetooth: false,
      reason: "default",
      unresolved: false,
    };
  }

  /** getUserMedia audio constraints for a choice, keeping `base` options. */
  function audioConstraints(choice, base) {
    const audio = Object.assign({}, base || {});
    if (choice && choice.deviceId) audio.deviceId = { exact: choice.deviceId };
    return audio;
  }

  /**
   * One-shot helper for the simple mic users (Settings mic test, onboarding):
   * enumerate, read transports, choose. Never throws.
   */
  async function resolveChoice(mediaDevices, getTransports, preferredId) {
    let devices = [];
    let transports = null;
    try {
      devices = await mediaDevices.enumerateDevices();
    } catch (_) {
      devices = [];
    }
    try {
      transports = getTransports ? await getTransports() : null;
    } catch (_) {
      transports = null;
    }
    return chooseInput(preferredId || "", devices, transports);
  }

  const api = {
    classifyInputs,
    chooseInput,
    audioConstraints,
    resolveChoice,
    normalizeName,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof window !== "undefined") {
    window.MicPolicy = api;
  }
})();
