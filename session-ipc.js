'use strict';

const path = require('path');
const { fileURLToPath } = require('url');
const { ipcMain } = require('electron');
const { createSessionStore } = require('./session-store');

const NOT_ALLOWED = { success: false, error: 'Not allowed' };

// Only the app's own top-level pages may read or change call history.
function fromPackagedPage(event, appDir) {
  const frame = event && event.senderFrame;
  if (!frame || frame.parent) return false;
  try {
    const file = fileURLToPath(frame.url);
    return ['index.html', 'settings.html'].some((page) => file === path.join(appDir, page));
  } catch {
    return false;
  }
}

/**
 * Register session-related IPC handlers (US-012).
 *
 * Call once after app.whenReady(). The store instance is created lazily
 * using the provided storePath (defaults to electron userData).
 *
 * @param {string} [storePath] — override storage directory (useful for tests)
 * @param {string} [appDir] — directory holding the app's pages (tests override)
 * @returns {{ store: Object }} the underlying store for direct access if needed
 */
function registerSessionIpc(storePath, appDir = __dirname) {
  const store = createSessionStore(storePath);
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) =>
      fromPackagedPage(event, appDir) ? fn(event, ...args) : NOT_ALLOWED,
    );

  handle('get-sessions', (_event, options) => {
    try {
      return { success: true, data: store.getSessions(options) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  handle('get-session', (_event, id) => {
    try {
      const session = store.getSession(id);
      if (!session) return { success: false, error: 'Session not found' };
      return { success: true, data: session };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  handle('save-session', (_event, sessionData) => {
    try {
      const saved = store.saveSession(sessionData);
      return { success: true, data: saved };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  handle('delete-session', (_event, id) => {
    try {
      const deleted = store.deleteSession(id);
      return { success: true, deleted };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  handle('get-session-stats', () => {
    try {
      return { success: true, data: store.getStats() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  return { store };
}

module.exports = { registerSessionIpc };
