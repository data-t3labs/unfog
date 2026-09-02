import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Browsers are not installed through `playwright install` on this machine; the Chromium headless
// shell from the Playwright cache is used directly. Override with PW_CHROMIUM=/path/to/chrome.
const headlessShell =
  process.env.PW_CHROMIUM ??
  path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1237/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const executablePath = fs.existsSync(headlessShell) ? headlessShell : undefined;

const iphone = devices['iPhone 15'];

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:5173/unfog/',
    // iPhone 15 profile (UA, DPR 3, touch) but standalone-app viewport (no Safari chrome) on Chromium.
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: iphone.isMobile,
    hasTouch: iphone.hasTouch,
    viewport: { width: 393, height: 852 },
    browserName: 'chromium',
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
    geolocation: { longitude: -73.9568, latitude: 40.7176 },
    permissions: ['geolocation'],
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173/unfog/',
    reuseExistingServer: true,
    timeout: 90_000,
  },
});
