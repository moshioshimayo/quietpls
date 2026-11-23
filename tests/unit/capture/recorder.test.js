import { describe, it, expect } from 'vitest';
import fs from 'fs';
import vm from 'vm';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

function launch(options) {
  let actual;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (sig) => { (child.signals ||= []).push(sig); };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../../../capture/lib/recorder.js', import.meta.url), 'utf8'), {
    require: (id) => id === 'child_process' ? { spawn: (...args) => { actual = args; return child; } }
      : id === 'readline' ? { createInterface: () => new EventEmitter() }
      : id === 'path' ? { join: (...s) => s.join('/') } : undefined,
    module: mod, __dirname: '/capture/lib',
  });
  const recorder = mod.exports.startCapture({ output: '/out.wav', helper: '/capture', onMessage() {}, onExit() {}, ...options });
  return { child, actual, recorder };
}
describe('recorder privacy transport', () => {
  it('maps approved and Never bundle ids, never call PIDs', () => {
    const { actual } = launch({ approvedOnly: true, approveBundleIds: ['com.microsoft.teams2'], neverBundleIds: ['us.zoom.xos'], excludePids: [12] });
    expect(actual[1]).toEqual(['--out', '/out.wav', '--exclude-pid', '12', '--approved-only', '--approve-bundle', 'com.microsoft.teams2', '--never-bundle', 'us.zoom.xos']);
  });
  it('preserves the exact always-on args', () => {
    expect(launch({ excludePids: [12, 34] }).actual[1]).toEqual(['--out', '/out.wav', '--exclude-pid', '12', '--exclude-pid', '34']);
  });
  it('revokes once with SIGUSR1 and never signals an exited helper', () => {
    const { recorder, child } = launch({});
    recorder.revoke(); recorder.revoke();
    expect(child.signals).toEqual(['SIGUSR1']);
    child.emit('close', 0);
    recorder.revoke();
    expect(child.signals).toEqual(['SIGUSR1']);
  });
});
