import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock factories — we build fresh mocks for each test so nothing leaks.
// The CJS setup.js patches `require('electron')`, but PermissionManager needs
// specific electron APIs (systemPreferences, dialog, ipcMain, shell).
// We override the setup.js mock on each test via the shared reference.
// ---------------------------------------------------------------------------

let mockMediaAccessStatus;
let mockAskForMediaAccess;
let mockShowMessageBoxSync;
let mockShowMessageBox;
let mockOpenExternal;
let mockIpcHandlers;
let mockIpcOnHandlers;

function resetMocks() {
  mockMediaAccessStatus = 'granted';
  mockAskForMediaAccess = vi.fn().mockResolvedValue(true);
  mockShowMessageBoxSync = vi.fn().mockReturnValue(1); // 1 = "OK" (second button)
  mockShowMessageBox = vi.fn().mockResolvedValue({ response: 0 });
  mockOpenExternal = vi.fn();
  mockIpcHandlers = {};
  mockIpcOnHandlers = {};

  // Patch the electron mock that setup.js exposes via Module.prototype.require
  const electron = require('electron');
  electron.systemPreferences = {
    getMediaAccessStatus: vi.fn((_type) => mockMediaAccessStatus),
    askForMediaAccess: mockAskForMediaAccess,
  };
  electron.dialog = {
    showMessageBoxSync: mockShowMessageBoxSync,
    showMessageBox: mockShowMessageBox,
  };
  electron.shell = {
    openExternal: mockOpenExternal,
  };
  electron.ipcMain = {
    handle: vi.fn((channel, handler) => {
      mockIpcHandlers[channel] = handler;
    }),
    on: vi.fn((channel, handler) => {
      mockIpcOnHandlers[channel] = handler;
    }),
  };
}

function freshPermissionManager() {
  // Clear require cache so each test gets a fresh module evaluation
  const modPath = require.resolve('../../permission-manager.js');
  delete require.cache[modPath];
  return require('../../permission-manager.js');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionManager', () => {
  let PermissionManager;

  beforeEach(() => {
    resetMocks();
    PermissionManager = freshPermissionManager();
  });

  // ---- getStatus ----

  describe('getStatus', () => {
    it('returns "granted" when microphone is granted', () => {
      mockMediaAccessStatus = 'granted';
      const pm = new PermissionManager();
      expect(pm.getStatus()).toBe('granted');
    });

    it('returns "denied" when microphone is denied', () => {
      mockMediaAccessStatus = 'denied';
      const pm = new PermissionManager();
      expect(pm.getStatus()).toBe('denied');
    });

    it('returns "restricted" when microphone is restricted', () => {
      mockMediaAccessStatus = 'restricted';
      const pm = new PermissionManager();
      expect(pm.getStatus()).toBe('restricted');
    });

    it('returns "not-determined" when microphone is not-determined', () => {
      mockMediaAccessStatus = 'not-determined';
      const pm = new PermissionManager();
      expect(pm.getStatus()).toBe('not-determined');
    });
  });

  // ---- checkAndRequestPermission ----

  describe('checkAndRequestPermission', () => {
    it('returns true immediately when already granted', async () => {
      mockMediaAccessStatus = 'granted';
      const pm = new PermissionManager();
      const result = await pm.checkAndRequestPermission();
      expect(result).toBe(true);
      expect(mockAskForMediaAccess).not.toHaveBeenCalled();
    });

    it('requests access when not-determined and returns true if user grants', async () => {
      mockMediaAccessStatus = 'not-determined';
      mockAskForMediaAccess.mockResolvedValue(true);
      const pm = new PermissionManager();
      const result = await pm.checkAndRequestPermission();
      expect(result).toBe(true);
      expect(mockAskForMediaAccess).toHaveBeenCalledWith('microphone');
    });

    it('requests access when not-determined and returns false if user denies', async () => {
      mockMediaAccessStatus = 'not-determined';
      mockAskForMediaAccess.mockResolvedValue(false);
      const pm = new PermissionManager();
      const result = await pm.checkAndRequestPermission();
      expect(result).toBe(false);
    });

    it('shows dialog when denied and returns false', async () => {
      mockMediaAccessStatus = 'denied';
      const pm = new PermissionManager();
      const result = await pm.checkAndRequestPermission();
      expect(result).toBe(false);
      expect(mockShowMessageBoxSync).toHaveBeenCalled();
      expect(mockAskForMediaAccess).not.toHaveBeenCalled();
    });

    it('shows dialog when restricted and returns false', async () => {
      mockMediaAccessStatus = 'restricted';
      const pm = new PermissionManager();
      const result = await pm.checkAndRequestPermission();
      expect(result).toBe(false);
      expect(mockShowMessageBoxSync).toHaveBeenCalled();
    });

    it('opens System Settings when user clicks "Open System Settings" on denied', async () => {
      mockMediaAccessStatus = 'denied';
      mockShowMessageBoxSync.mockReturnValue(0); // 0 = "Open System Settings"
      const pm = new PermissionManager();
      await pm.checkAndRequestPermission();
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      );
    });

    it('does not open System Settings when user clicks OK on denied', async () => {
      mockMediaAccessStatus = 'denied';
      mockShowMessageBoxSync.mockReturnValue(1); // 1 = "OK"
      const pm = new PermissionManager();
      await pm.checkAndRequestPermission();
      expect(mockOpenExternal).not.toHaveBeenCalled();
    });
  });

  // ---- registerIPC ----

  describe('registerIPC', () => {
    it('registers get-microphone-status handler', () => {
      const pm = new PermissionManager();
      pm.registerIPC(() => null);
      const electron = require('electron');
      expect(electron.ipcMain.handle).toHaveBeenCalledWith(
        'get-microphone-status',
        expect.any(Function)
      );
    });

    it('registers microphone-track-ended handler', () => {
      const pm = new PermissionManager();
      pm.registerIPC(() => null);
      const electron = require('electron');
      expect(electron.ipcMain.on).toHaveBeenCalledWith(
        'microphone-track-ended',
        expect.any(Function)
      );
    });

    it('get-microphone-status handler returns current status', () => {
      mockMediaAccessStatus = 'denied';
      const pm = new PermissionManager();
      pm.registerIPC(() => null);
      const result = mockIpcHandlers['get-microphone-status']();
      expect(result).toBe('denied');
    });

    it('does not register handlers twice', () => {
      const pm = new PermissionManager();
      pm.registerIPC(() => null);
      pm.registerIPC(() => null);
      const electron = require('electron');
      expect(electron.ipcMain.handle).toHaveBeenCalledTimes(1);
    });
  });

  // ---- mid-session revocation ----

  describe('mid-session revocation', () => {
    it('sends microphone-permission-revoked to renderer when track ends', () => {
      mockMediaAccessStatus = 'denied';
      const mockSend = vi.fn();
      const mockWin = {
        isDestroyed: () => false,
        webContents: { send: mockSend },
      };
      const pm = new PermissionManager();
      pm.registerIPC(() => mockWin);

      // Simulate the renderer sending microphone-track-ended
      mockIpcOnHandlers['microphone-track-ended']();

      expect(mockSend).toHaveBeenCalledWith('microphone-permission-revoked', { status: 'denied' });
    });

    it('shows a warning dialog on mid-session revocation', () => {
      mockMediaAccessStatus = 'denied';
      const mockWin = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
      };
      const pm = new PermissionManager();
      pm.registerIPC(() => mockWin);

      mockIpcOnHandlers['microphone-track-ended']();

      expect(mockShowMessageBox).toHaveBeenCalledWith(
        mockWin,
        expect.objectContaining({
          type: 'warning',
          title: 'Microphone Access Lost',
        })
      );
    });

    it('falls back to sync dialog when no window is available', () => {
      mockMediaAccessStatus = 'denied';
      const pm = new PermissionManager();
      pm.registerIPC(() => null);

      mockIpcOnHandlers['microphone-track-ended']();

      expect(mockShowMessageBoxSync).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          title: 'Microphone Access Lost',
        })
      );
    });

    it('handles destroyed window gracefully', () => {
      mockMediaAccessStatus = 'denied';
      const mockWin = {
        isDestroyed: () => true,
        webContents: { send: vi.fn() },
      };
      const pm = new PermissionManager();
      pm.registerIPC(() => mockWin);

      mockIpcOnHandlers['microphone-track-ended']();

      // Should NOT send to destroyed window
      expect(mockWin.webContents.send).not.toHaveBeenCalled();
      // Should fall back to sync dialog
      expect(mockShowMessageBoxSync).toHaveBeenCalled();
    });

    it('includes device-disconnection message when permission is still granted', () => {
      mockMediaAccessStatus = 'granted';
      const mockWin = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
      };
      const pm = new PermissionManager();
      pm.registerIPC(() => mockWin);

      mockIpcOnHandlers['microphone-track-ended']();

      expect(mockShowMessageBox).toHaveBeenCalledWith(
        mockWin,
        expect.objectContaining({
          detail: expect.stringContaining('disconnected'),
        })
      );
    });
  });
});
