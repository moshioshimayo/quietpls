'use strict';

const { systemPreferences, dialog, ipcMain, shell } = require('electron');

const PRIVACY_MICROPHONE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

/**
 * Microphone access (2.5, B2/B4).
 *
 *   getStatus()  'granted' | 'denied' | 'restricted' | 'not-determined'
 *   request()    the only path that can show the macOS prompt, and only while
 *                access is undetermined; resolves to the status afterwards
 *
 * main.js broadcasts 'microphone-status-changed' (status) to every window on
 * browser-window-focus and after request(), so returning from System Settings
 * resumes without a restart.
 */
class PermissionManager {
  constructor() {
    this._ipcRegistered = false;
  }

  getStatus() {
    return systemPreferences.getMediaAccessStatus('microphone');
  }

  async request() {
    if (this.getStatus() === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone');
    }
    return this.getStatus();
  }

  /**
   * Fallback when no quietpls window can show the access-off state.
   * @param {'denied'|'restricted'} status
   */
  showAccessOffDialog(status) {
    const detail = status === 'restricted'
      ? 'Your organization manages microphone access. Contact your administrator if you can’t enable quietpls in System Settings → Privacy & Security → Microphone.'
      : 'Turn on quietpls in System Settings → Privacy & Security → Microphone, then start monitoring again.';
    const result = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Microphone Access Is Off',
      message: 'Allow microphone access to monitor your voice level.',
      detail,
      buttons: ['Open System Settings', 'OK'],
    });
    if (result === 0) shell.openExternal(PRIVACY_MICROPHONE);
  }

  /**
   * Register IPC handlers. Call once after app is ready.
   * @param {Function} getMainWindow - returns the current main BrowserWindow (or null)
   */
  registerIPC(getMainWindow) {
    if (this._ipcRegistered) return;
    this._ipcRegistered = true;

    ipcMain.handle('get-microphone-status', () => this.getStatus());

    // Renderer notifies main process when a media stream track ends mid-session
    // (indicates permission was revoked or device was lost)
    ipcMain.on('microphone-track-ended', () => {
      this._handleMidSessionRevocation(getMainWindow);
    });

  }

  /**
   * Handle mid-session microphone permission revocation.
   * Called when the renderer detects that its audio track ended unexpectedly.
   * @param {Function} getMainWindow
   */
  _handleMidSessionRevocation(getMainWindow) {
    const status = this.getStatus();

    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;

    // Notify renderer to stop monitoring gracefully
    if (win && !win.isDestroyed()) {
      win.webContents.send('microphone-permission-revoked', { status });
    }

    const dialogOptions = {
      type: 'warning',
      title: 'Voice Monitoring Stopped',
      message: 'quietpls can’t use the microphone.',
      detail: status === 'granted'
        ? 'Check the mic connection, then try again.'
        : 'Turn on quietpls in System Settings → Privacy & Security → Microphone, then start monitoring again.',
      buttons: ['OK']
    };

    if (win && !win.isDestroyed()) {
      dialog.showMessageBox(win, dialogOptions);
    } else {
      dialog.showMessageBoxSync(dialogOptions);
    }
  }
}

module.exports = PermissionManager;
