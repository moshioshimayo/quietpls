const getStore = () => {
  if (!globalThis.__testStoreData) globalThis.__testStoreData = {};
  return globalThis.__testStoreData;
};

function Store() {
  this.get = (key) => getStore()[key];
  this.set = (key, value) => { getStore()[key] = value; };
  this.delete = (key) => { delete getStore()[key]; };
  this.clear = () => { globalThis.__testStoreData = {}; };
}

module.exports = Store;
