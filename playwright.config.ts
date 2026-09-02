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
/** Build output for the preview server (gitignored via node_modules/). */
const E2E_DIST = 'node_modules/.cache/unfog-e2e/dist';

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
  webServer: [
    {
      // HMR + watcher off (tests/e2e/vite.e2e.config.ts): a src/ edit during a run would otherwise
      // full-reload the page mid-test.
      command: 'npx vite --config tests/e2e/vite.e2e.config.ts --port 5173 --strictPort',
      url: 'http://localhost:5173/unfog/',
      reuseExistingServer: true,
      timeout: 90_000,
      // The e2e config imports vite.config without an extension (tsconfig has no allowImportingTsExtensions).
      env: { VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
    },
    // Production build + `vite preview` for the offline tests (tests/e2e/real.spec.ts): the service
    // worker only exists in a build (initPwa returns early under import.meta.env.DEV). Own outDir and
    // port so it never collides with `npm run build` / `npm run preview`. Skip with PW_NO_PREVIEW=1;
    // the offline block then skips itself. A preview already listening on :4174 is reused (no rebuild).
    ...(process.env.PW_NO_PREVIEW
      ? []
      : [
          {
            command: `npx vite build --outDir ${E2E_DIST} && npx vite preview --outDir ${E2E_DIST} --port 4174 --strictPort`,
            url: 'http://localhost:4174/unfog/',
            reuseExistingServer: true,
            timeout: 180_000,
          },
        ]),
  ],
});
