import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4175',
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
    serviceWorkers: 'allow',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `"${process.execPath}" scripts/prepare-public-build.mjs && python3 -m http.server 4175 --bind 127.0.0.1 --directory dist`,
    url: 'http://127.0.0.1:4175/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
