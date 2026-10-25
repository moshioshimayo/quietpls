'use strict';

const { ipcMain } = require('electron');
const { createSessionStore } = require('./session-store');

/**
 * Register session-related IPC handlers (US-012).
 *
 * Call once after app.whenReady(). The store instance is created lazily
 * using the provided storePath (defaults to electron userData).
 *
 * @param {string} [storePath] — override storage directory (useful for tests)
 * @returns {{ store: Object }} the underlying store for direct access if needed
 */
function registerSessionIpc(storePath) {
  const store = createSessionStore(storePath);

  ipcMain.handle('get-sessions', (_event, options) => {
    try {
      return { success: true, data: store.getSessions(options) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-session', (_event, id) => {
    try {
      const session = store.getSession(id);
      if (!session) return { success: false, error: 'Session not found' };
      return { success: true, data: session };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('save-session', (_event, sessionData) => {
    try {
      const saved = store.saveSession(sessionData);
      return { success: true, data: saved };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('delete-session', (_event, id) => {
    try {
      const deleted = store.deleteSession(id);
      return { success: true, deleted };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-session-stats', () => {
    try {
      return { success: true, data: store.getStats() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  return { store };
}

module.exports = { registerSessionIpc };
