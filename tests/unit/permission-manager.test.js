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

  // ---- request / recheck (B2, B4) ----

  describe('request', () => {
    it('never prompts when access is already decided', async () => {
      for (const status of ['granted', 'denied', 'restricted']) {
        mockMediaAccessStatus = status;
        const pm = new PermissionManager();
        expect(await pm.request()).toBe(status);
      }
      expect(mockAskForMediaAccess).not.toHaveBeenCalled();
      expect(mockShowMessageBoxSync).not.toHaveBeenCalled();
    });

    it('prompts only while undetermined and resolves to the new status', async () => {
      mockMediaAccessStatus = 'not-determined';
      mockAskForMediaAccess.mockImplementation(async () => {
        mockMediaAccessStatus = 'denied';
        return false;
      });
      const pm = new PermissionManager();
      expect(await pm.request()).toBe('denied');
      expect(mockAskForMediaAccess).toHaveBeenCalledWith('microphone');
    });
  });

  describe('showAccessOffDialog', () => {
    it('explains a managed mic and opens System Settings on request', () => {
      mockShowMessageBoxSync.mockReturnValue(0);
      const pm = new PermissionManager();
      pm.showAccessOffDialog('restricted');
      expect(mockShowMessageBoxSync).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Microphone Access Is Off',
        detail: expect.stringContaining('Your organization manages microphone access'),
        buttons: ['Open System Settings', 'OK'],
      }));
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      );
    });

    it('does not open System Settings on OK', () => {
      mockShowMessageBoxSync.mockReturnValue(1);
      new PermissionManager().showAccessOffDialog('denied');
      expect(mockOpenExternal).not.toHaveBeenCalled();
    });
  });

  // ---- registerIPC ----

  describe('registerIPC', () => {
    it('registers status and track-ended handlers; main.js owns request/open/focus channels', () => {
      const pm = new PermissionManager();
      pm.registerIPC(() => null);
      expect(Object.keys(mockIpcHandlers)).toEqual(['get-microphone-status']);
      expect(Object.keys(mockIpcOnHandlers)).toEqual(['microphone-track-ended']);
    });

    it('reading the status never prompts', () => {
      mockMediaAccessStatus = 'not-determined';
      new PermissionManager().registerIPC(() => null);
      expect(mockIpcHandlers['get-microphone-status']()).toBe('not-determined');
      expect(mockAskForMediaAccess).not.toHaveBeenCalled();
    });

    it('get-microphone-status handler returns current status', () => {
      mockMediaAccessStatus = 'denied';
      const pm = new PermissionManager();
      pm.registerIPC(() => null);
      expect(mockIpcHandlers['get-microphone-status']()).toBe('denied');
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
          title: 'Voice Monitoring Stopped',
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
          title: 'Voice Monitoring Stopped',
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
          detail: 'Check the mic connection, then try again.',
        })
      );
    });
  });
});
