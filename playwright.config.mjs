import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.TRAILS_PORT || 4174);
const browsers = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'], browserName: 'firefox' } },
  { name: 'webkit', use: { ...devices['Desktop Safari'], browserName: 'webkit' } },
  { name: 'mobile-chromium', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
];

// Runs against the built site, so "npm run build" comes first.
export default defineConfig({
  testDir: 'tests/trails/e2e',
  fullyParallel: true,
  workers: 4,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: [['list']],
  outputDir: 'test-results',
  projects: process.env.E2E_BROWSER ? browsers.filter(project => project.use.browserName === process.env.E2E_BROWSER) : browsers,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  webServer: { command: 'npm run serve:trails', url: `http://127.0.0.1:${PORT}`, env: { PORT: String(PORT) }, reuseExistingServer: !process.env.CI, timeout: 30_000 },
});
