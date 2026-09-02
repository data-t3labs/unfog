/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Served from GitHub Pages at https://data-t3labs.github.io/unfog/ — every absolute URL in the
// app must go through import.meta.env.BASE_URL.
export default defineConfig({
  base: '/unfog/',
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
      registerType: 'autoUpdate',
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
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: '/unfog/index.html',
        navigateFallbackDenylist: [/\/unfog\/welcome/],
        runtimeCaching: [
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
            // Prebuilt routing graph tiles (also bulk-fetched into this cache by "Download region").
            urlPattern: ({ url }) => url.pathname.startsWith('/unfog/graph/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'graph',
              expiration: { maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
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
