"""Permission-free resolver and real buffer-discard checks. No audio devices opened."""
import json, pathlib, subprocess, wave, struct
root = pathlib.Path(__file__).resolve().parents[2]
scratch = root / '.pi/scratch/s2/native-fixtures'
scratch.mkdir(parents=True, exist_ok=True)
for fixture in sorted((root / 'tests/native/fixtures').glob('*.json')):
    case = json.loads(fixture.read_text())
    proc = subprocess.run([str(root / 'bin/capture'), '--sources-fixture', str(fixture)], capture_output=True, text=True)
    output = [json.loads(line) for line in proc.stdout.splitlines()]
    assert output, (fixture.name, proc.stderr)
    actual = output[-1]
    for key, value in case['expect'].items():
        assert actual.get(key) == value, (fixture.name, key, actual, value)
    print('PASS', fixture.stem)
out = scratch / 'revoke.wav'
proc = subprocess.run([str(root / 'bin/capture'), '--revoke-fixture', str(out)], capture_output=True, text=True)
events = [json.loads(line) for line in proc.stdout.splitlines()]
saved = [e for e in events if e['type'] == 'saved']
assert proc.returncode == 0 and len(saved) == 1 and saved[0]['themDiscarded'] is True, (proc.stdout, proc.stderr)
with wave.open(str(out)) as w:
    assert w.getnchannels() == 2 and w.getnframes() >= 32000
    samples = struct.unpack('<' + 'h' * w.getnframes() * 2, w.readframes(w.getnframes()))
assert max(map(abs, samples[::2])) > 1000
assert all(s == 0 for s in samples[1::2]), 'right channel retained revoked audio'
print('PASS revoke: left intact, right zero from sample 0, one confirmed saved')
# Tap buffers behind another input stream (an output device that also has inputs): keep the tap's
# stream only; an unreadable layout stops once with an error instead of silently saving zeros.
def buffers(mode):
    out = scratch / f'buffers-{mode}.wav'
    proc = subprocess.run([str(root / 'bin/capture'), '--buffers-fixture', mode, '--out', str(out)], capture_output=True, text=True)
    events = [json.loads(line) for line in proc.stdout.splitlines()]
    saved = [e for e in events if e['type'] == 'saved']
    assert proc.returncode == 0 and len(saved) == 1, (mode, proc.stdout, proc.stderr)
    return events, saved[0]
events, saved = buffers('good')
assert 0.25 < saved['themPeak'] < 0.35 and saved['themDiscarded'] is False, saved
assert not [e for e in events if e['type'] == 'error'], events
print('PASS buffers: tap stream selected from a 2-buffer list (themPeak %.2f)' % saved['themPeak'])
events, saved = buffers('bad')
errors = [e for e in events if e['type'] == 'error']
assert len(errors) == 1 and errors[0]['code'] == 'source-check-failed', events
assert events.index(errors[0]) < events.index(saved) and saved['themDiscarded'] is True and saved['themPeak'] == 0, events
print('PASS buffers: unreadable tap layout -> one source-check-failed, them discarded')
