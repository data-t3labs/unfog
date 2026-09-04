/**
 * Playwright config for the LIVE smoke (tests/e2e/live.spec.ts) — the only suite that drives the
 * deployed site at https://data-t3labs.github.io/unfog/ instead of a local server.
 *
 * Own config on purpose: no `webServer` (nothing is built or served here) and none of the
 * playwright.config.ts ports, so it never collides with a dev :5173 / preview :4174 run in another
 * session. Reached only through `npm run smoke:live`, which sets UNFOG_LIVE_BASE to the deployed
 * URL. Without that variable the spec registers no tests at all, which is what keeps the live smoke
 * out of the default suite and CI. Point it at another deploy by setting UNFOG_LIVE_BASE yourself.
 */
import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const headlessShell =
  process.env.PW_CHROMIUM ??
  path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1237/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const executablePath = fs.existsSync(headlessShell) ? headlessShell : undefined;

const iphone = devices['iPhone 15'];

export default defineConfig({
  testDir: '.',
  testMatch: /live\.spec\.ts/,
  // Live network + a real service-worker install; generous, but every test has its own tighter waits.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../test-results/live',
  use: {
    baseURL: process.env.UNFOG_LIVE_BASE,
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: iphone.isMobile,
    hasTouch: iphone.hasTouch,
    viewport: { width: 393, height: 852 },
    browserName: 'chromium',
    launchOptions: { executablePath },
    // The deployed build ships a service worker; the suite asserts on it, so contexts must keep it.
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    // Boston Common: outside every prebuilt region in public/graph/index.json, inside pack coverage.
    geolocation: { longitude: -71.0656, latitude: 42.355 },
    permissions: ['geolocation'],
  },
});
