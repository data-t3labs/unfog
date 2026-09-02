/**
 * Landing-site screenshot capture — REAL app, real engines, no ?mock=1.
 *
 * Runs against a local preview of the built app (`npm run build && npx vite preview --port 4173 --strictPort`),
 * seeds the real grid store with tracks along real Williamsburg streets (tests/fixtures/osm/williamsburg.json.gz,
 * chosen with the same distance-decay probabilities as docs/mockups/mock.js so the fog looks lived-in), then
 * captures the Fog / Heat / Route / Data / Stats / Help screens at the iPhone 15 viewport (393×852, DPR 3)
 * plus a wide desktop fog view. Masters are PNG; tests/e2e/landing/make-images.sh derives the JPEGs in welcome/img/.
 *
 *   node tests/e2e/landing/capture.mjs app  [outDir]   # app screenshots (default out: tests/e2e/landing/out)
 *   node tests/e2e/landing/capture.mjs site [outDir]   # the landing page itself at 393 and 1280 px (review)
 *   node tests/e2e/landing/capture.mjs og   [outDir]   # 1200×630 Open Graph image from welcome/og.html
 *
 * Env: PW_CHROMIUM (browser binary), UNFOG_URL (default http://localhost:4173/unfog/).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const mode = process.argv[2] ?? 'app';
const outDir = path.resolve(process.argv[3] ?? path.join(here, 'out'));
fs.mkdirSync(outDir, { recursive: true });

const BASE = process.env.UNFOG_URL ?? 'http://localhost:4173/unfog/';
const executablePath =
  process.env.PW_CHROMIUM ??
  path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1237/chrome-headless-shell-mac-arm64/chrome-headless-shell');

const HOME = [-73.9568, 40.7176]; // Bedford Av & N 7th St
const DOMINO = { name: 'Domino Park', locality: 'Brooklyn', lonlat: [-73.9678, 40.7142] };
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

// ---------------------------------------------------------------- seed tracks (mock.js probabilities)
function seedTracks(seed = 7) {
  const gz = fs.readFileSync(path.join(repo, 'tests/fixtures/osm/williamsburg.json.gz'));
  const data = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  const ways = data.elements.filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 1);
  const KX = 111320 * Math.cos((40.716 * Math.PI) / 180);
  const KY = 110574;
  const dist = (a, b) => Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
  let s = seed >>> 0;
  const rnd = () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const tracks = [];
  let chosen = 0;
  ways.forEach((w, i) => {
    const g = w.geometry;
    const mid = g[Math.floor(g.length / 2)];
    const d = dist([mid.lon, mid.lat], HOME);
    const p = 0.92 * Math.exp(-d / 420) + 0.07;
    if (rnd() < p) {
      const count = 1 + Math.floor(Math.pow(rnd(), 1.4) * 9 * Math.exp(-d / 380));
      chosen++;
      const points = g.map((pt) => [pt.lon, pt.lat]);
      for (let k = 0; k < count; k++) tracks.push({ id: `seed-${i}-${k}`, source: 'gpx', name: w.tags?.name ?? `way ${w.id}`, points });
    }
  });
  return { tracks, ways: ways.length, chosen };
}

// ---------------------------------------------------------------- page helpers
async function bootApp(page, { dismissInstallCard = true } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (dismissInstallCard) await page.addInitScript(() => localStorage.setItem('unfog.installDismissed', String(Date.now())));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__unfog?.ready === true, null, { timeout: 120_000 });
  const mock = await page.evaluate(() => window.__unfog.mock);
  if (mock) throw new Error('app booted with MOCK engines — the landing site must show the real ones');
  if (errors.length) console.warn('page errors during boot:', errors);
  return errors;
}

async function idle(page, settle = 500) {
  await page.waitForTimeout(settle);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const map = window.__unfog?.ctx?.map.map;
        if (!map) return resolve();
        if (map.loaded() && !map.isMoving()) return resolve();
        map.once('idle', () => resolve());
      }),
  );
  await page.waitForTimeout(250);
}

async function seed(page) {
  const { tracks, ways, chosen } = seedTracks();
  const before = await page.evaluate(() => window.__unfog.ctx.engines.grid.getStats());
  if (before.visitedCells > 0) {
    console.log(`store already has ${before.visitedCells} cells — wiping first`);
    await page.evaluate(() => window.__unfog.ctx.engines.grid.deleteAll());
  }
  const t0 = Date.now();
  const res = await page.evaluate(async (tracks) => {
    const { grid, route } = window.__unfog.ctx.engines;
    const r = await grid.applyPayload({ tracks, meta: { source: 'gpx', fileName: 'workout-routes', items: tracks.length } });
    await route.invalidateCells(r.stats.version);
    await window.__unfog.ctx.dataChanged();
    return r.stats;
  }, tracks);
  const areaKm2 = res.areaM2 / 1e6;
  // Make the Data / Stats screens reflect the import that just happened (same fields the Data screen writes).
  await page.evaluate(
    ({ cells, km2 }) => {
      const summary = `${cells.toLocaleString('en-US')} new cells, ${km2.toFixed(1)} km² added`;
      localStorage.setItem('unfog.lastImport', JSON.stringify({ at: Date.now() - 3 * 86_400_000, summary }));
      localStorage.setItem('unfog.lastBackup', JSON.stringify({ at: Date.now() - 5 * 86_400_000 }));
    },
    { cells: res.visitedCells, km2: areaKm2 },
  );
  console.log(`seeded ${tracks.length} tracks over ${chosen}/${ways} ways → ${res.visitedCells} cells, ${areaKm2.toFixed(2)} km² in ${Date.now() - t0} ms`);
  return res;
}

/** Toasts (SW "ready to work offline", import summary…) must not photobomb a frame. They queue one at a time now, so allow for two in a row. */
async function noToasts(page) {
  await page.waitForFunction(() => !document.querySelector('.toasts')?.children.length, null, { timeout: 25_000 }).catch(() => {});
}

async function shot(page, name, opts = {}) {
  await noToasts(page);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false, ...opts });
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`  ${name}.png  ${kb} KB`);
  return file;
}

// ---------------------------------------------------------------- modes
async function captureApp(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_UA,
    geolocation: { longitude: HOME[0], latitude: HOME[1], accuracy: 8 },
    permissions: ['geolocation'],
    colorScheme: 'light',
  });
  const page = await ctx.newPage();
  await bootApp(page);
  await seed(page);

  // 1. Fog, centred on home at z15.3 with the user dot (locate = the same tap a user makes).
  await page.getByRole('button', { name: 'My location' }).click();
  await page.waitForSelector('.user-dot', { state: 'attached', timeout: 20_000 });
  await page.evaluate((c) => window.__unfog.ctx.map.map.jumpTo({ center: c, zoom: 15.3 }), HOME);
  await idle(page, 900);
  await shot(page, 'fog');

  // 2. Heat.
  await page.locator('.seg button[data-layer="heat"]').click();
  await page.waitForSelector('.legend', { state: 'visible' });
  await idle(page, 900);
  await shot(page, 'heat');
  await page.locator('.seg button[data-layer="fog"]').click();
  await idle(page, 400);

  // 3. Route sheet to Domino Park (origin = the user's position).
  await page.evaluate((d) => window.__unfog.openRoute(d), DOMINO);
  const sheet = page.locator('.sheet.route');
  await sheet.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('.sheet.route .cand').length >= 2, null, { timeout: 60_000 });
  await idle(page, 1200);
  const cands = await page.$$eval('.sheet.route .cand', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('  candidates:', cands);
  await shot(page, 'route');
  await page.getByRole('button', { name: 'Clear destination' }).click();
  await idle(page, 300);

  // 3b. Loop mode ("Explore from here"): no `from` argument = the same path as the search-panel row,
  // so the loops start at the user's position (no start pin, no "from the map centre" line).
  // The 3 km chip is the app default; clicking it is a no-op when already selected.
  await page.evaluate(() => window.__unfog.openLoop());
  const loopSheet = page.locator('.sheet.route.loop');
  await loopSheet.waitFor({ state: 'visible' });
  await page.locator('.sheet.route.loop .chips button', { hasText: /^3 km$/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sheet.route.loop .cand').length >= 2, null, { timeout: 90_000 });
  await idle(page, 1200);
  const loops = await page.$$eval('.sheet.route.loop .cand', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const loopTitle = await page.$eval('.sheet.route.loop h2', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  const loopStatus = await page.$eval('.sheet.route.loop .route-status', (e) => e.textContent.trim());
  console.log('  loop title:', loopTitle, '| status:', JSON.stringify(loopStatus));
  console.log('  loops:', loops);
  await shot(page, 'loop');
  await page.getByRole('button', { name: 'Clear destination' }).click();
  await idle(page, 300);

  // 4. Data screen.
  await page.locator('.tab[data-tab="data"]').click();
  await page.waitForSelector('#screen-data .row-item', { state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(400);
  await shot(page, 'data');

  // 5. Stats.
  await page.locator('.tab[data-tab="stats"]').click();
  await page.waitForFunction(() => (document.querySelector('#screen-stats .stat.big .v')?.textContent ?? '') !== '', null, { timeout: 20_000 });
  await page.waitForTimeout(400);
  await shot(page, 'stats');

  // 6. Help: export steps open, then install steps open.
  await page.locator('.tab[data-tab="help"]').click();
  await page.waitForSelector('#screen-help', { state: 'visible' });
  const sections = page.locator('#screen-help .help-section');
  await sections.nth(0).locator('summary').click();
  await page.waitForTimeout(350);
  await shot(page, 'help-export');
  await sections.nth(0).locator('summary').click();
  await sections.nth(1).locator('summary').click();
  await page.waitForTimeout(350);
  await shot(page, 'help-install');
  await page.locator('.tab[data-tab="map"]').click();
  await idle(page, 300);
  await ctx.close();

  // 7. Wide desktop fog view (chrome hidden — the map only). Separate context = separate IndexedDB, so seed again.
  const wide = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    geolocation: { longitude: HOME[0], latitude: HOME[1], accuracy: 8 },
    permissions: ['geolocation'],
    colorScheme: 'light',
  });
  const wp = await wide.newPage();
  await bootApp(wp);
  await seed(wp);
  await wp.evaluate((c) => window.__unfog.ctx.map.map.jumpTo({ center: [c[0] - 0.0035, c[1] - 0.0012], zoom: 15.1 }), HOME);
  await wp.addStyleTag({ content: '.top, .bottom, .maplibregl-ctrl-bottom-left { visibility: hidden !important; }' });
  await idle(wp, 1200);
  await shot(wp, 'fog-wide');
  await wide.close();
}

async function captureSite(browser) {
  const url = new URL('welcome/', BASE).toString();
  for (const [name, vp, dpr, mobile] of [
    ['site-393', { width: 393, height: 852 }, 2, true],
    ['site-1280', { width: 1280, height: 900 }, 1, false],
  ]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile, colorScheme: scheme, userAgent: mobile ? IPHONE_UA : undefined });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('requestfailed', (r) => console.warn('  request failed:', r.url()));
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      // Scroll through once so lazy images load, then back to the top.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 40));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(400);
      await shot(page, `${name}-${scheme}`, { fullPage: true });
      if (scheme === 'dark') await shot(page, `${name}-hero-dark`);
      if (scheme === 'light') {
        // Viewport close-ups at each section for review (full-page shots are too tall to read).
        await shot(page, `${name}-hero`);
        for (const id of ['views', 'loops', 'how', 'export', 'install', 'privacy', 'faq']) {
          await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start' }), id);
          await page.waitForTimeout(250);
          await shot(page, `${name}-${id}`);
        }
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(250);
        await shot(page, `${name}-footer`);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      const weight = await page.evaluate(() => {
        const entries = performance.getEntriesByType('resource').map((e) => ({ name: e.name.split('/').pop().split('?')[0], bytes: e.transferSize || e.encodedBodySize || 0 }));
        const nav = performance.getEntriesByType('navigation')[0];
        entries.unshift({ name: 'index.html', bytes: nav?.transferSize || nav?.encodedBodySize || 0 });
        return entries;
      });
      if (scheme === 'light') {
        const total = weight.reduce((a, b) => a + b.bytes, 0);
        console.log(`  page weight @${vp.width}: ${(total / 1024).toFixed(0)} KB over ${weight.length} requests`);
        for (const w of weight) console.log(`    ${String(Math.round(w.bytes / 1024)).padStart(5)} KB  ${w.name}`);
      }
      // Invariants: nothing bleeds into a horizontal scroll (the hero fog is clipped by body overflow-x), and no third-party request.
      const inv = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        height: document.documentElement.scrollHeight,
        thirdParty: performance.getEntriesByType('resource').filter((e) => !e.name.startsWith(location.origin)).map((e) => e.name),
      }));
      console.log(`  @${vp.width} ${scheme}: scrollWidth ${inv.scrollWidth} / clientWidth ${inv.clientWidth}, page height ${inv.height} px, third-party requests ${inv.thirdParty.length}`);
      if (inv.scrollWidth > inv.clientWidth) throw new Error(`horizontal overflow at ${vp.width}px ${scheme}: scrollWidth ${inv.scrollWidth} > clientWidth ${inv.clientWidth}`);
      if (inv.thirdParty.length) throw new Error(`third-party requests: ${inv.thirdParty.join(', ')}`);
      if (errors.length) console.warn('  page errors:', errors);
      await ctx.close();
    }
  }
}

/** welcome/og.html → public/og.jpg (Vite hashes everything under welcome/, so the card lives in public/ for a stable URL). */
async function captureOg(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await ctx.newPage();
  const src = path.join(repo, 'welcome/og.html');
  let html = fs.readFileSync(src, 'utf8');
  // Inline fonts + images as data URLs so the page renders from a plain setContent (no server, no file:// policy).
  html = html.replace(/url\('(fonts\/[^']+)'\)/g, (_, p) => `url('data:font/woff2;base64,${fs.readFileSync(path.join(repo, 'welcome', p)).toString('base64')}')`);
  html = html.replace(/src="(img\/[^"]+\.jpg)"/g, (_, p) => `src="data:image/jpeg;base64,${fs.readFileSync(path.join(repo, 'welcome', p)).toString('base64')}"`);
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const file = path.join(repo, 'public/og.jpg');
  await page.screenshot({ path: file, type: 'jpeg', quality: 86 });
  console.log(`  og.jpg  ${Math.round(fs.statSync(file).size / 1024)} KB → ${file}`);
  await ctx.close();
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  if (mode === 'app') await captureApp(browser);
  else if (mode === 'site') await captureSite(browser);
  else if (mode === 'og') await captureOg(browser);
  else throw new Error(`unknown mode ${mode}`);
} finally {
  await browser.close();
}
console.log(`done → ${outDir}`);
