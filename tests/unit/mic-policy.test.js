import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  classifyInputs,
  chooseInput,
  audioConstraints,
  resolveChoice,
} = require("../../mic-policy");
const {
  parseAudioProfile,
  createInputTransports,
} = require("../../input-transports");

// What Chromium (Electron 40) enumerates on a MacBook with AirPods as the
// default input: built-in and USB labels carry a suffix, Bluetooth doesn't.
const dev = (deviceId, groupId, label) => ({
  kind: "audioinput",
  deviceId,
  groupId,
  label,
});
const MAC = dev("mac", "g-mac", "MacBook Pro Microphone (Built-in)");
const RODE = dev("rode", "g-rode", "RØDE NT-USB Mini (19f7:0015)");
const AIRPODS = dev("airpods", "g-airpods", "AirPods");
const IPHONE = dev("iphone", "g-iphone", "Alex’s iPhone Microphone");
const defaultOf = (d) => dev("default", d.groupId, "Default - " + d.label);

// system_profiler's view (names can be longer than Chromium's labels).
const transports = (defaultName, names) => ({
  inputs: names.map(([name, transport]) => ({
    name,
    transport,
    isDefault: name === defaultName,
  })),
});
const CORE = [
  ["MacBook Pro Microphone", "builtin"],
  ["RØDE NT-USB Mini", "usb"],
  ["Alex's AirPods", "bluetooth"],
  ["Alex’s iPhone Microphone", "unknown"],
];

describe("classifyInputs", () => {
  it("built-in and USB by label, Bluetooth by CoreAudio transport", () => {
    const out = classifyInputs(
      [defaultOf(AIRPODS), RODE, MAC, AIRPODS, IPHONE],
      transports("Alex's AirPods", CORE),
    );
    expect(out.map((d) => [d.deviceId, d.category, d.isDefault])).toEqual([
      ["rode", "wired", false],
      ["mac", "builtin", false],
      ["airpods", "bluetooth", true],
      ["iphone", "other", false],
    ]);
  });

  it("a non-default Bluetooth mic is found by its (shortened) name", () => {
    const out = classifyInputs(
      [defaultOf(MAC), MAC, AIRPODS],
      transports("MacBook Pro Microphone", CORE),
    );
    expect(out.find((d) => d.deviceId === "airpods").bluetooth).toBe(true);
  });

  it("unknown transports: nothing is called Bluetooth", () => {
    const out = classifyInputs([defaultOf(AIRPODS), MAC, AIRPODS], null);
    expect(out.some((d) => d.bluetooth)).toBe(false);
  });
});

describe("chooseInput — the 2.1.1 mic policy", () => {
  const withAirPodsDefault = [defaultOf(AIRPODS), RODE, MAC, AIRPODS];
  const t = transports("Alex's AirPods", CORE);

  it("default = AirPods → built-in mic", () => {
    expect(chooseInput("", withAirPodsDefault, t)).toEqual({
      deviceId: "mac",
      label: MAC.label,
      bluetooth: false,
      reason: "avoid-bluetooth",
      unresolved: false,
    });
  });

  it("default = AirPods, no built-in → wired/USB mic", () => {
    expect(
      chooseInput("", [defaultOf(AIRPODS), RODE, AIRPODS], t).deviceId,
    ).toBe("rode");
  });

  it("a non-Bluetooth default is followed as before", () => {
    const devices = [defaultOf(RODE), RODE, MAC, AIRPODS];
    expect(
      chooseInput("", devices, transports("RØDE NT-USB Mini", CORE)),
    ).toMatchObject({ deviceId: "rode", reason: "default" });
  });

  it("an explicit pick is respected, Bluetooth included", () => {
    expect(chooseInput("airpods", withAirPodsDefault, t)).toMatchObject({
      deviceId: "airpods",
      bluetooth: true,
      reason: "explicit",
    });
  });

  it("an explicit pick that is gone falls back to the policy", () => {
    expect(chooseInput("gone", withAirPodsDefault, t)).toMatchObject({
      deviceId: "mac",
      reason: "avoid-bluetooth",
    });
  });

  it("Bluetooth only (lid closed / Mac mini) → Bluetooth mic, bluetooth-only", () => {
    expect(
      chooseInput("", [defaultOf(AIRPODS), AIRPODS, IPHONE], t),
    ).toMatchObject({
      deviceId: "airpods",
      bluetooth: true,
      reason: "bluetooth-only",
    });
  });

  it("unknown transports keep following the default", () => {
    expect(chooseInput("", withAirPodsDefault, null)).toMatchObject({
      deviceId: "airpods",
      reason: "default",
    });
  });

  it("nothing enumerable → let the system choose", () => {
    expect(chooseInput("", [], t).deviceId).toBe("");
  });
});

describe("chooseInput — stale transport snapshot (review P1)", () => {
  // Read while the built-in mic was the default, before AirPods connected.
  const stale = transports("MacBook Pro Microphone", [
    ["MacBook Pro Microphone", "builtin"],
    ["RØDE NT-USB Mini", "usb"],
  ]);

  it("a snapshot default that belongs to another current device is not applied to the new default", () => {
    const out = classifyInputs([defaultOf(AIRPODS), MAC, AIRPODS], stale);
    expect(out.find((d) => d.deviceId === "airpods")).toMatchObject({
      isDefault: true,
      category: "other",
      unresolved: true,
    });
  });

  it("unresolved default → built-in mic, flagged for a re-read", () => {
    expect(
      chooseInput("", [defaultOf(AIRPODS), MAC, AIRPODS], stale),
    ).toMatchObject({
      deviceId: "mac",
      reason: "unresolved",
      unresolved: true,
    });
  });

  it("unresolved default, no built-in → wired mic", () => {
    expect(
      chooseInput("", [defaultOf(AIRPODS), RODE, AIRPODS], stale).deviceId,
    ).toBe("rode");
  });

  it("a Bluetooth mic named in an older snapshot is still Bluetooth", () => {
    const older = transports("MacBook Pro Microphone", CORE);
    expect(
      chooseInput("", [defaultOf(AIRPODS), MAC, AIRPODS], older),
    ).toMatchObject({ deviceId: "mac", reason: "avoid-bluetooth" });
  });

  it("a default whose CoreAudio name differs is still matched when no other device owns the snapshot default", () => {
    const odd = dev("bose", "g-bose", "Headset");
    const snap = transports("Bose QC Ultra", [
      ["MacBook Pro Microphone", "builtin"],
      ["Bose QC Ultra", "bluetooth"],
    ]);
    expect(chooseInput("", [defaultOf(odd), MAC, odd], snap)).toMatchObject({
      deviceId: "mac",
      reason: "avoid-bluetooth",
    });
  });

  it("reviewer repro: real readInputTransports + chooseInput after the default changed", async () => {
    let profile = "builtin-default";
    const reader = createInputTransports({
      run: async () =>
        JSON.stringify({
          SPAudioDataType: [
            {
              _items: [
                {
                  _name: "MacBook Pro Microphone",
                  coreaudio_device_input: 1,
                  coreaudio_device_transport: "coreaudio_device_type_builtin",
                  coreaudio_default_audio_input_device:
                    profile === "builtin-default" ? "spaudio_yes" : undefined,
                },
                ...(profile === "airpods-default"
                  ? [
                      {
                        _name: "Alex's AirPods",
                        coreaudio_device_input: 1,
                        coreaudio_device_transport:
                          "coreaudio_device_type_bluetooth",
                        coreaudio_default_audio_input_device: "spaudio_yes",
                      },
                    ]
                  : []),
              ],
            },
          ],
        }),
    });
    const before = await reader.get();
    profile = "airpods-default";
    const devices = [defaultOf(AIRPODS), MAC, AIRPODS];
    // A read from before the change: unresolved, never the AirPods.
    expect(chooseInput("", devices, before).deviceId).toBe("mac");
    // The next read is fresh (no cache): resolved, still the built-in mic.
    expect(chooseInput("", devices, await reader.get())).toMatchObject({
      deviceId: "mac",
      reason: "avoid-bluetooth",
      unresolved: false,
    });
  });
});

describe("audioConstraints / resolveChoice", () => {
  it("adds an exact device id and keeps the base options", () => {
    expect(
      audioConstraints({ deviceId: "mac" }, { echoCancellation: false }),
    ).toEqual({ echoCancellation: false, deviceId: { exact: "mac" } });
    expect(
      audioConstraints({ deviceId: "" }, { autoGainControl: false }),
    ).toEqual({ autoGainControl: false });
  });

  it("resolveChoice enumerates, reads transports and never throws", async () => {
    const md = {
      enumerateDevices: async () => [defaultOf(AIRPODS), MAC, AIRPODS],
    };
    const choice = await resolveChoice(
      md,
      async () => transports("Alex's AirPods", CORE),
      "",
    );
    expect(choice.deviceId).toBe("mac");
    const broken = await resolveChoice(
      {
        enumerateDevices: async () => {
          throw new Error("x");
        },
      },
      async () => {
        throw new Error("y");
      },
      "",
    );
    expect(broken.deviceId).toBe("");
  });
});

describe("input-transports (system_profiler)", () => {
  // Shape of `system_profiler SPAudioDataType -json` on macOS 26.
  const PROFILE = {
    SPAudioDataType: [
      {
        _name: "coreaudio_device",
        _items: [
          {
            _name: "DELL U2720Q",
            coreaudio_device_output: 2,
            coreaudio_device_transport: "coreaudio_device_type_displayport",
          },
          {
            _name: "MacBook Pro Microphone",
            coreaudio_device_input: 1,
            coreaudio_device_transport: "coreaudio_device_type_builtin",
          },
          {
            _name: "Alex's AirPods",
            coreaudio_default_audio_input_device: "spaudio_yes",
            coreaudio_device_input: 1,
            coreaudio_device_srate: 24000,
            coreaudio_device_transport: "coreaudio_device_type_bluetooth",
          },
          {
            _name: "Alex's AirPods",
            coreaudio_default_audio_output_device: "spaudio_yes",
            coreaudio_device_output: 2,
            coreaudio_device_transport: "coreaudio_device_type_bluetooth",
          },
        ],
      },
    ],
  };

  it("lists inputs with transport and the default flag", () => {
    expect(parseAudioProfile(JSON.stringify(PROFILE))).toEqual({
      inputs: [
        {
          name: "MacBook Pro Microphone",
          transport: "builtin",
          isDefault: false,
        },
        { name: "Alex's AirPods", transport: "bluetooth", isDefault: true },
      ],
    });
  });

  it("bad output → null (unknown), never throws", () => {
    expect(parseAudioProfile("not json")).toBeNull();
    expect(parseAudioProfile("{}")).toBeNull();
  });

  it("every read is fresh: no cache, no shared in-flight read", async () => {
    let runs = 0;
    const it2 = createInputTransports({
      run: async () => {
        runs++;
        return JSON.stringify(PROFILE);
      },
    });
    await Promise.all([it2.get(), it2.get()]);
    await it2.get();
    expect(runs).toBe(3);
  });

  it("a failed run yields null and is retried next time", async () => {
    let runs = 0;
    const it2 = createInputTransports({
      run: async () => (++runs === 1 ? null : JSON.stringify(PROFILE)),
    });
    expect(await it2.get()).toBeNull();
    expect((await it2.get()).inputs).toHaveLength(2);
  });
});
