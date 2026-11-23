import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import os from 'os';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const electron = require('electron');

// Session IPC answers only the app's own top-level pages (spec A1.4).
describe('session IPC sender check', () => {
  const appDir = path.join(os.tmpdir(), 'quietpls app.asar');
  let tmp, handlers, store, originalHandle;

  const topFrame = (url) => ({ url, parent: null });
  const ev = (frame) => ({ senderFrame: frame });
  const pageUrl = (name) => pathToFileURL(path.join(appDir, name)).href;
  const session = (id) => ({
    id,
    startTime: '2025-06-01T10:00:00.000Z',
    endTime: '2025-06-01T10:30:00.000Z',
    duration: 1800,
    volumeSamples: [40, 50],
    volumeVariance: 5,
    peakMoments: [],
    zoneTime: { silent: 0, quiet: 900, normal: 900, loud: 0 },
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ipc-test-'));
    handlers = {};
    originalHandle = electron.ipcMain.handle;
    electron.ipcMain.handle = (channel, fn) => {
      handlers[channel] = fn;
    };
    const { registerSessionIpc } = require('../../session-ipc');
    ({ store } = registerSessionIpc(tmp, appDir));
    store.saveSession(session('kept'));
  });

  afterEach(() => {
    electron.ipcMain.handle = originalHandle;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const untrusted = {
    'remote https page': ev(topFrame('https://example.invalid/')),
    'other local file': ev(topFrame(pathToFileURL(path.join(appDir, 'evil.html')).href)),
    'file outside the app': ev(topFrame(pathToFileURL(path.join(os.tmpdir(), 'settings.html')).href)),
    'child frame of settings': ev({ url: pageUrl('settings.html'), parent: topFrame(pageUrl('settings.html')) }),
    'malformed url': ev(topFrame('not a url')),
    'missing frame': ev(null),
    'missing event': undefined,
  };

  for (const [name, event] of Object.entries(untrusted)) {
    it(`refuses every channel from: ${name}`, () => {
      const denied = { success: false, error: 'Not allowed' };
      expect(handlers['get-sessions'](event)).toEqual(denied);
      expect(handlers['get-session'](event, 'kept')).toEqual(denied);
      expect(handlers['get-session-stats'](event)).toEqual(denied);
      expect(handlers['save-session'](event, session('planted'))).toEqual(denied);
      expect(handlers['delete-session'](event, 'kept')).toEqual(denied);
      // Store untouched: nothing deleted, nothing written.
      expect(store.getSessions().map((s) => s.id)).toEqual(['kept']);
    });
  }

  for (const page of ['index.html', 'settings.html']) {
    it(`serves the packaged ${page} top frame`, () => {
      const event = ev(topFrame(pageUrl(page) + '#history'));
      expect(handlers['get-sessions'](event).data.map((s) => s.id)).toEqual(['kept']);
      expect(handlers['get-session'](event, 'kept').data.id).toBe('kept');
      expect(handlers['get-session-stats'](event).success).toBe(true);
      expect(handlers['save-session'](event, session('new')).success).toBe(true);
      expect(handlers['delete-session'](event, 'kept')).toEqual({ success: true, deleted: true });
      expect(store.getSessions().map((s) => s.id)).toEqual(['new']);
    });
  }
});
