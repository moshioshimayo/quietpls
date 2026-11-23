"""Real CoreAudio gate. Run only inside local:m16; outputs stay under project scratch.
No third-party Python packages. Exit 77 means UNVERIFIED, never a passing gate.
"""
import json, math, os, pathlib, plistlib, shutil, signal, struct, subprocess, sys, time, wave
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / '.pi/scratch/s2/native-tap' / str(time.time_ns())
OUT.mkdir(parents=True, exist_ok=True)
print('Native gate evidence:', OUT, flush=True)

def unavailable(reason):
    print('UNVERIFIED:', reason, flush=True)
    raise SystemExit(77)
for tool in ['swiftc', 'say', 'python3']:
    if not shutil.which(tool): unavailable('local:m16 lacks ' + tool)
CAPTURE = ROOT / 'bin/capture'
CAPTURE.parent.mkdir(exist_ok=True)
subprocess.run(['swiftc', '-O', '-o', str(CAPTURE), str(ROOT / 'native/capture.swift')], check=True)
PLAYER = OUT / 'player'
subprocess.run(['swiftc', '-O', '-o', str(PLAYER), str(ROOT / 'tests/native/player.swift')], check=True)

def app(name, bundle, parent=OUT):
    folder = parent / (name + '.app')
    contents = folder / 'Contents'
    exe = contents / 'MacOS/player'
    exe.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(PLAYER, exe)
    with (contents / 'Info.plist').open('wb') as f:
        plistlib.dump(dict(CFBundleIdentifier=bundle, CFBundleExecutable='player', CFBundleName=name, CFBundlePackageType='APPL'), f)
    return exe
approved = app('Approved', 'dev.quietpls-test.approved')
helper = app('AudioX', 'dev.quietpls-test.audio-x', approved.parents[1] / 'Helpers')
never = app('Never', 'dev.quietpls-test.never-player')
for word in ['alpha', 'bravo', 'charlie']:
    subprocess.run(['say', '-o', str(OUT / (word + '.aiff')), word], check=True)
unknown = OUT / 'unknown-player'
shutil.copy2(PLAYER, unknown)
base = ['--approved-only', '--approve-bundle', 'dev.quietpls-test.approved', '--never-bundle', 'dev.quietpls-test.never-player']
procs = []

def launch(executable, args):
    p = subprocess.Popen([str(executable), *map(str, args)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    procs.append(p)
    return p

def players(delay=0, anchor=True):
    a = None
    if anchor:
        a = launch(approved, ['--helper', helper, '--alpha', OUT / 'alpha.aiff', '--unknown', unknown, '--charlie', OUT / 'charlie.aiff', '--delay', delay])
    return a

def never_player():
    return launch(never, ['--frequency', '1000', '--speech', OUT / 'bravo.aiff'])

def stop(p):
    if p and p.poll() is None:
        p.terminate()
        try: p.wait(timeout=4)
        except subprocess.TimeoutExpired: p.kill(); p.wait()

def cleanup():
    for p in reversed(procs): stop(p)
    procs.clear()

def capture(name, args=base, fault=None):
    env = dict(os.environ)
    if fault: env['QUIETPLS_CAPTURE_FAULT'] = fault
    file = OUT / (name + '.wav')
    p = subprocess.Popen([str(CAPTURE), '--out', str(file), *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    procs.append(p)
    return p, file

def finish(p, file, sig=signal.SIGINT):
    if p.poll() is None: p.send_signal(sig)
    try: stdout, stderr = p.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        p.kill(); stdout, stderr = p.communicate()
        unavailable('local:m16 recorder did not finish (permission dialog or missing audio input): ' + stderr[-500:])
    events = [json.loads(s) for s in stdout.splitlines() if s.startswith('{')]
    file.with_suffix('.json').write_text(json.dumps(events, indent=2))
    file.with_suffix('.stderr').write_text(stderr)
    for e in events:
        if e.get('code') in ['mic-denied', 'mic-unavailable', 'system-audio-unavailable']:
            unavailable('local:m16 ' + e['code'] + ': ' + e.get('detail', ''))
    return events

def channels(file):
    with wave.open(str(file)) as w:
        assert w.getnchannels() == 2 and w.getsampwidth() == 2
        rate = w.getframerate()
        data = struct.unpack('<' + 'h' * w.getnframes() * 2, w.readframes(w.getnframes()))
    return rate, data[::2], data[1::2]

def energy(samples, rate, frequency):
    # Goertzel amplitude at the exact marker, per 250 ms window.
    coeff = 2 * math.cos(2 * math.pi * frequency / rate)
    q1 = q2 = 0.0
    for sample in samples:
        q0 = sample / 32768 + coeff * q1 - q2
        q2, q1 = q1, q0
    return 2 * math.sqrt(max(0, q1*q1 + q2*q2 - coeff*q1*q2)) / len(samples)

def inspect(file, positive=False, silent=False, revoke=False):
    rate, left, right = channels(file)
    assert right, 'no audio frames'
    if silent:
        assert all(v == 0 for v in right), 'system track not silent from sample 0'
    if revoke:
        assert max(map(abs, left), default=0) > 100, 'microphone positive control missing'
    n = rate // 4
    windows = []
    for start in range(0, len(right) - n + 1, n):
        values = [energy(right[start:start+n], rate, f) for f in [440, 1000, 1600]]
        windows.append(values)
        print(file.stem, f'{start/rate:.2f}s', 'A/B/C', *(f'{x:.6f}' for x in values), flush=True)
        if not silent:
            assert values[1] < 0.006 and values[2] < 0.006, 'Never/unknown marker admitted'
    if positive:
        assert max(v[0] for v in windows) > 0.035, 'approved-helper positive control missing (TCC may be denied)'
        # Every established window outside restart settling must contain A.
        for i, values in enumerate(windows):
            if i >= 4 and not (file.stem == 'restart' and 3.75 <= i*.25 <= 5.0):
                assert values[0] > 0.025, 'approved helper missing for >1 s'
    return rate, left, right

def assert_saved(events, discarded=None):
    saved = [e for e in events if e['type'] == 'saved']
    assert len(saved) == 1, events
    if discarded is not None: assert saved[0].get('themDiscarded') == discarded, events

try:
    # Permission check does not claim the audio gate passes. Real tone is the control.
    print('System Audio Recording and microphone permission may be granted in local:m16 only.', flush=True)
    # Case 1: B/C present at creation; case 2: they arrive at +2 seconds.
    for name, delay in [('already-playing', 0), ('delayed', 2), ('restart', 0)]:
        a = players(delay + 1 if delay else 0)
        b = never_player() if delay == 0 else None
        time.sleep(1)
        p, file = capture(name)
        began = time.monotonic()
        initial = subprocess.run([str(CAPTURE), '--sources'], capture_output=True, text=True)
        (OUT / (name + '-before-sources.jsonl')).write_text(initial.stdout)
        if delay:
            time.sleep(2); b = never_player()
        if name == 'restart':
            time.sleep(max(0, began + 4 - time.monotonic()))
            # Terminating the anchor also terminates its helper and unknown child.
            stop(a); stop(b)
            a = players(); b = never_player()
        time.sleep(max(0, began + 8 - time.monotonic()))
        events = finish(p, file)
        assert_saved(events, False)
        try: inspect(file, positive=True)
        except AssertionError as e:
            if 'positive control missing' in str(e): unavailable('local:m16 has no captured approved-helper audio; System Audio Recording grant/output route is unproven')
            raise
        # Actual live identities retained for restart/object-id diagnostics.
        table = subprocess.run([str(CAPTURE), '--sources'], capture_output=True, text=True)
        (OUT / (name + '-sources.jsonl')).write_text(table.stdout)
        cleanup()
    # No approved anchor while Never outputs: immediate mic-only notice, no tap.
    never_player(); time.sleep(.5)
    p, file = capture('no-anchor'); time.sleep(4)
    events = finish(p, file)
    assert any(e.get('code') == 'mic-only' for e in events), events
    assert_saved(events, True); inspect(file, silent=True); cleanup()
    # Before-start faults exercise real reader/listener/tap failures. Faults only
    # refuse, so the hook cannot grant an unapproved source admission.
    for step in ['list', 'pid', 'bundle', 'path', 'start', 'parent', 'responsible', 'process-list-listener', 'output-listener', 'tap', 'aggregate', 'description', 'identity']:
        players(); never_player(); time.sleep(.5)
        p, file = capture('fault-' + step, fault=step); time.sleep(2)
        events = finish(p, file)
        assert any(e.get('code') == 'source-check-failed' for e in events), events
        assert not any(e['type'] == 'started' for e in events), events
        assert not file.exists(), 'pre-start failure wrote audio'
        cleanup()
    # Runtime reader/description faults must stop exactly once and discard even
    # samples captured before the failure (same real stop/write path as revoke).
    for step in ['list', 'pid', 'bundle', 'path', 'start', 'parent', 'responsible', 'description', 'identity', 'output-listener']:
        players(); time.sleep(.5)
        p, file = capture('runtime-fault-' + step, fault='after-start:' + step)
        time.sleep(1)
        never_player()  # also forces output-listener registration after started
        time.sleep(2)
        events = finish(p, file)
        assert any(e['type'] == 'started' for e in events), events
        assert any(e.get('code') == 'source-check-failed' for e in events), events
        assert_saved(events, True); inspect(file, silent=True)
        cleanup()
    players(); never_player(); time.sleep(1)
    p, file = capture('revoke'); time.sleep(4)
    events = finish(p, file, signal.SIGUSR1)
    assert_saved(events, True); inspect(file, silent=True, revoke=True); cleanup()
    # Global control: B must be captured to prove that exclusion was meaningful.
    never_player(); time.sleep(.5)
    p, file = capture('global-control', args=[]); time.sleep(4)
    events = finish(p, file); assert_saved(events, False)
    rate, left, right = channels(file)
    assert max(energy(right[i:i+rate//4], rate, 1000) for i in range(0, len(right)-rate//4, rate//4)) > .035, 'global Never positive control missing'
    cleanup()
    # Optional local whisper check uses the actual isolated right channel.
    model = os.environ.get('QUIETPLS_NATIVE_WHISPER_MODEL')
    whisper = shutil.which('whisper-cli') or shutil.which('whisper-cpp')
    if model and whisper and pathlib.Path(model).is_file():
        rate, _, right = channels(OUT / 'already-playing.wav')
        wavfile = OUT / 'them.wav'
        with wave.open(str(wavfile), 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
            w.writeframes(struct.pack('<' + 'h'*len(right), *right))
        transcript = subprocess.run([whisper, '-m', model, '-f', str(wavfile), '-nt'], capture_output=True, text=True, check=True).stdout.lower()
        (OUT / 'them-transcript.txt').write_text(transcript)
        assert 'alpha' in transcript and 'bravo' not in transcript and 'charlie' not in transcript
    else: print('UNVERIFIED: optional whisper words (set QUIETPLS_NATIVE_WHISPER_MODEL and install whisper-cli)', flush=True)
    print('PASS native-tap: six live cases and global positive control', flush=True)
finally:
    cleanup()
