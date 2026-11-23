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
