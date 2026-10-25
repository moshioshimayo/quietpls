'use strict';

const { systemPreferences, dialog, ipcMain, shell } = require('electron');

/**
 * Centralized permission manager for microphone access.
 * Handles checking, requesting, and monitoring microphone permissions
 * across macOS versions.
 */
class PermissionManager {
  constructor() {
    this._status = null;
    this._mainWindow = null;
    this._ipcRegistered = false;
  }

  /**
   * Get the current microphone permission status.
   * @returns {'granted'|'denied'|'restricted'|'not-determined'}
   */
  getStatus() {
    this._status = systemPreferences.getMediaAccessStatus('microphone');
    return this._status;
  }

  /**
   * Check and request microphone permission on app launch.
   * Must be called before creating any windows.
   * @returns {Promise<boolean>} true if permission is granted
   */
  async checkAndRequestPermission() {
    const status = this.getStatus();

    if (status === 'granted') {
      return true;
    }

    if (status === 'not-determined') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      this._status = granted ? 'granted' : 'denied';
      return granted;
    }

    // denied or restricted
    this._showPermissionDeniedDialog(status);
    return false;
  }

  /**
   * Show a dialog directing the user to System Settings when permission
   * is denied or restricted.
   * @param {'denied'|'restricted'} status
   */
  _showPermissionDeniedDialog(status) {
    const detail = status === 'restricted'
      ? 'Microphone access is restricted by a system policy. Please contact your administrator, or check System Settings > Privacy & Security > Microphone.'
      : 'Please grant microphone access in System Settings > Privacy & Security > Microphone, then restart the app.';

    const result = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Microphone Access Required',
      message: 'quietpls needs microphone access to monitor your voice levels.',
      detail,
      buttons: ['Open System Settings', 'OK']
    });

    if (result === 0) {
      // Open the macOS Privacy & Security settings pane
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    }
  }

  /**
   * Register IPC handlers. Call once after app is ready.
   * @param {Function} getMainWindow - returns the current main BrowserWindow (or null)
   */
  registerIPC(getMainWindow) {
    if (this._ipcRegistered) return;
    this._ipcRegistered = true;

    // Renderer can query current permission status
    ipcMain.handle('get-microphone-status', () => {
      return this.getStatus();
    });

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
    // Refresh the cached status
    const status = this.getStatus();

    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;

    // Notify renderer to stop monitoring gracefully
    if (win && !win.isDestroyed()) {
      win.webContents.send('microphone-permission-revoked', { status });
    }

    // Show a dialog informing the user
    const dialogOptions = {
      type: 'warning',
      title: 'Microphone Access Lost',
      message: 'Microphone access was lost and monitoring has been stopped.',
      detail: status === 'granted'
        ? 'The audio device may have been disconnected. Please reconnect and try again.'
        : 'Please re-enable microphone access in System Settings > Privacy & Security > Microphone, then restart monitoring.',
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
