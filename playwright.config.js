const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  // shots.spec.js is the judge-panel screenshot harness, not a test gate: it
  // runs only when QP_SHOTS_DIR names its output directory.
  testIgnore: process.env.QP_SHOTS_DIR ? [] : ['**/shots.spec.js'],
  timeout: 30000,
  retries: 0,
  workers: 1, // Electron tests must run sequentially
  reporter: 'list',
});
