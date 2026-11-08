const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './e2e', workers: 1, timeout: 30000, fullyParallel: false,
  use: { browserName: 'chromium', channel: process.env.AGENTFORGE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true, viewport: { width: 1500, height: 960 }, trace: 'retain-on-failure' },
  reporter: 'list',
});
