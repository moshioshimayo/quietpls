// Patch CJS require for electron modules before any tests run
const Module = require("module");
const originalResolveFilename = Module._resolveFilename;

const SAFE_PREFIX = "safe:";

const mocks = {
  electron: {
    safeStorage: {
      encryptString: (str) => Buffer.from(SAFE_PREFIX + str, "utf8"),
      decryptString: (buf) => {
        const str = buf.toString("utf8");
        if (!str.startsWith(SAFE_PREFIX)) throw new Error("Decryption failed");
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
    net: {
      online: true,
    },
    powerMonitor: {
      on: () => {},
    },
    ipcMain: {
      handle: () => {},
      on: () => {},
    },
    nativeImage: {
      createFromDataURL: () => ({ isEmpty: () => false }),
    },
    clipboard: {
      writeImage: () => {},
    },
  },
  "electron-store": (() => {
    const getStore = () => {
      if (!globalThis.__testStoreData) globalThis.__testStoreData = {};
      return globalThis.__testStoreData;
    };
    function Store() {
      this.get = (key) => getStore()[key];
      this.set = (key, value) => {
        getStore()[key] = value;
      };
      this.delete = (key) => {
        delete getStore()[key];
      };
      this.clear = () => {
        globalThis.__testStoreData = {};
      };
    }
    return Store;
  })(),
};

// Intercept require for mocked modules
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (mocks[id] !== undefined) {
    return mocks[id];
  }
  return originalRequire.apply(this, arguments);
};
