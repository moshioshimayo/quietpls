# Capture source boundary checks

These development fixtures are not shipped in the app.

Permission-free checks, from the checkout:

```sh
~/.pi/agent/bin/memguard -- bash scripts/build-native.sh
~/.pi/agent/bin/memguard -- bash tests/native/sources.sh
```

`fixtures/*.json` runs the production resolver without audio devices. The revoke
fixture invokes the real append/discard/stop/WAV writer with synthetic frames,
raises SIGUSR1, delivers more frames after discard, and checks every right-channel
sample is zero while the left channel survives. Fixture output stays in
`.pi/scratch/s2/native-fixtures`.

The live release gate must run **inside Cua Space `local:m16`**, with the native
source and this tests directory copied into a guest checkout. It needs Swift,
Python 3, `say`, an output device, a microphone input, and the guest's Microphone
and System Audio Recording grants. Do not grant permissions on the host.

```sh
QUIETPLS_NATIVE_TEST_SPACE=local:m16 bash tests/native/source-tap.sh
```

Run under memguard when installed in the guest. This gate compiles its own native
helper and synthetic app players; Node/Electron are unnecessary. It records only
the synthetic players plus the guest microphone. It checks approved child-helper
440 Hz audio, excludes Never 1000 Hz and bundle-less 1600 Hz audio in each 250 ms
window from sample zero, tests delayed starts and process restarts, no-anchor
mic-only, operational refusals and runtime stops, revocation, and a global-tap
positive control. Player bundles, source identity tables, event logs, WAVs and
per-window output stay under `.pi/scratch/s2/native-tap` (ignore this directory).
An interrupted run terminates only the players/recorder it created.

The revocation positive control requires actual microphone signal in the guest.
A silent/missing input cannot establish this control. Source tables before and
after restart retain object IDs/PIDs/start times for reuse inspection. Optional
word verification uses `whisper-cli` and `QUIETPLS_NATIVE_WHISPER_MODEL` pointing
to an installed local model; otherwise that part is explicitly UNVERIFIED.
Exit 77 is UNVERIFIED, never a passing gate. No release pass may be inferred from
a compile, permission-free fixtures, or the VM environment guard alone.
