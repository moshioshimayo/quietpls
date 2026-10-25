const SAFE_PREFIX = 'safe:';

module.exports = {
  safeStorage: {
    encryptString: (str) => Buffer.from(SAFE_PREFIX + str, 'utf8'),
    decryptString: (buf) => {
      const str = buf.toString('utf8');
      if (!str.startsWith(SAFE_PREFIX)) throw new Error('Decryption failed');
      return str.slice(SAFE_PREFIX.length);
    },
  },
  shell: {},
  BrowserWindow: function BrowserWindow() {},
  session: {
    defaultSession: {
      clearStorageData: () => Promise.resolve(),
    },
  },
};
