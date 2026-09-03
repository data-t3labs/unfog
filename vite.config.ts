/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Build stamp shown on the Help screen ("Unfog 0.1.0 · build 73d1693") so a phone can tell which
 * deploy it runs after an "Update available — Reload". `UNFOG_BUILD` overrides (the e2e update
 * test builds a v2 with it); else the short git sha; else the build time.
 */
function buildStamp(): string {
  if (process.env.UNFOG_BUILD) return process.env.UNFOG_BUILD;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return new Date().toISOString().slice(0, 16).replace('T', ' ');
  }
}

type RuntimeCachingEntry = NonNullable<NonNullable<NonNullable<Parameters<typeof VitePWA>[0]>['workbox']>['runtimeCaching']>[number];

/**
 * Service-worker runtime caching (exported so tests/unit/sw-runtime-caching.test.ts can check which
 * URLs each rule claims — the pack files must never be answered from a cache).
 */
export const runtimeCaching: RuntimeCachingEntry[] = [
  {
    // Basemap vector tiles, style, glyphs, sprites — cached as you pan so revisited areas work offline.
    urlPattern: /^https:\/\/tiles\.openfreemap\.org\//,
    handler: 'CacheFirst',
    options: {
      cacheName: 'basemap',
      expiration: { maxEntries: 6000, maxAgeSeconds: 60 * 60 * 24 * 60 },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  {
    // Satellite basemap: Esri World Imagery tiles (src/map/map.ts), cached as you pan like the
    // vector basemap. 256-px JPEGs, ~20 KB each; 3000 entries ≈ 60 MB for a well-walked city.
    urlPattern: /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\//,
    handler: 'CacheFirst',
    options: {
      cacheName: 'satellite',
      expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 30 },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  {
    // Prebuilt routing graph tiles (also bulk-fetched into this cache by "Download region").
    // NOT /unfog/graph/packs/: packs-index.json must reach the network (PackSource fetches
    // it with `cache: 'no-cache'` and keeps its own copy in IndexedDB) — a CacheFirst hit
    // would pin a stale coverage list for 180 days — and a `.ufp` pack mirrored there is
    // read by byte range; a cache answering a Range request with a stored full body breaks
    // the 206 contract (and would pull whole packs). Pack tiles live in IndexedDB `unfog-packs`.
    urlPattern: ({ url }) => url.pathname.startsWith('/unfog/graph/') && !url.pathname.startsWith('/unfog/graph/packs/'),
    handler: 'CacheFirst',
    options: {
      cacheName: 'graph',
      expiration: { maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 180 },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
];

// Served from GitHub Pages at https://data-t3labs.github.io/unfog/ — every absolute URL in the
// app must go through import.meta.env.BASE_URL.
export default defineConfig({
  base: '/unfog/',
  define: { __UNFOG_BUILD__: JSON.stringify(buildStamp()) },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        welcome: fileURLToPath(new URL('./welcome/index.html', import.meta.url)),
      },
    },
  },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      // Prompt mode: a new worker installs and WAITS. The open page keeps its own worker (and its
      // precache, so lazy chunks of the running bundle still resolve after a deploy) until the user
      // taps Reload on the "Update available" toast (src/app/pwa.ts sends SKIP_WAITING) or every
      // window is closed. autoUpdate would activate at once and drop the old chunks (QA flows-2 F4).
      registerType: 'prompt',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        id: '/unfog/',
        name: 'Unfog',
        short_name: 'Unfog',
        description: 'Your Fog of World map, plus routes that take you somewhere new.',
        start_url: '/unfog/',
        scope: '/unfog/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f4f2ee',
        theme_color: '#f4f2ee',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // skipWaiting stays off (prompt mode); once the waiting worker is told to activate it must
        // claim the open page so `controllerchange` fires and pwa.ts can reload onto the new build.
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: '/unfog/index.html',
        navigateFallbackDenylist: [/\/unfog\/welcome/],
        runtimeCaching,
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    testTimeout: 20000,
  },
});
