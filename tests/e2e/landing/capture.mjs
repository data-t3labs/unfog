/**
 * Landing-site screenshot capture — REAL app, real engines, no ?mock=1.
 *
 * Runs against a local preview of the built app (`npm run build && npx vite preview --port 4173 --strictPort`),
 * seeds the real grid store with tracks along real Williamsburg streets (tests/fixtures/osm/williamsburg.json.gz,
 * chosen with the same distance-decay probabilities as docs/mockups/mock.js so the fog looks lived-in), then
 * captures the Fog / Heat / Route / Loop / Satellite / Night / Data / Stats / Help / Tracking / Settings screens at
 * the iPhone 15 viewport (393×852, DPR 3) plus a wide desktop fog view. Masters are PNG; tests/e2e/landing/encode.mjs
 * derives the WebP + JPEG pairs in welcome/img/.
 *
 * The Data screen shows the REAL automatic routing layer: build, then `node tools/build-graph/mirror-packs.mjs --out
 * dist/graph/packs` (what deploy.yml does) so the preview serves the deployed packs-index.json and the app fetches
 * real packs from the real shard sites. The prebuilt NYC region already covers Williamsburg, so the capture pans to
 * eastern Long Island (outside the prebuilt tiles) and lets the prefetch driver pull the streets there by itself.
 *
 *   node tests/e2e/landing/capture.mjs app  [outDir]   # app screenshots (default out: tests/e2e/landing/out)
 *   node tests/e2e/landing/capture.mjs site [outDir]   # the landing page itself at 393 and 1280 px (review)
 *   node tests/e2e/landing/capture.mjs og   [outDir]   # 1200×630 Open Graph image from welcome/og.html
 *
 * Env: PW_CHROMIUM (browser binary), UNFOG_URL (default http://localhost:4173/unfog/), UNFOG_PACKS_INDEX (a
 * packs-index.json written by mirror-packs.mjs; when set, the app's request for graph/packs/packs-index.json is
 * answered from that file, so a concurrent `npm run build` emptying dist/ cannot take the index away mid-capture),
 * UNFOG_PACKS_DIR (a directory of `<cell>.ufp` packs curl'd from the shard sites — see bootApp for why).
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
// Westhampton Beach, NY: z12 tile 1220/1538 — outside the prebuilt NYC region (x 1201–1209) and inside the
// "Geofabrik us/new-york" pack cell 6/19/24, so the automatic layer lists "Streets near New York (US)".
const WESTHAMPTON = [-72.6451, 40.8051];
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
  if (process.env.UNFOG_PACKS_INDEX) {
    const body = fs.readFileSync(process.env.UNFOG_PACKS_INDEX);
    await page.context().route('**/graph/packs/packs-index.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body }));
  }
  if (process.env.UNFOG_PACKS_DIR) {
    // Headless Chromium on the capture Mac cannot open a connection to *.github.io (IPv6 dead, and the v4
    // path hangs in Chromium while curl gets a 206 at once), so the shard packs named by the index are
    // relayed from local copies fetched with curl: same bytes, same byte-range protocol (206 + Content-Range),
    // same app code path (index → ranges → IndexedDB → Data rows). Packs not present locally fail fast.
    const dir = process.env.UNFOG_PACKS_DIR;
    await page.context().route(/https:\/\/data-t3labs\.github\.io\/unfog-graph-\d+\/packs\/.+\.ufp$/, (route) => {
      const file = path.join(dir, route.request().url().split('/').pop());
      if (!fs.existsSync(file)) return route.abort('failed');
      const all = fs.readFileSync(file);
      const m = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers()['range'] ?? '');
      const cors = { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes', 'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges' };
      if (!m) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/octet-stream', 'content-length': String(all.length) }, body: all });
      const start = Number(m[1]);
      const end = m[2] === '' ? all.length - 1 : Math.min(Number(m[2]), all.length - 1);
      const part = all.subarray(start, end + 1);
      return route.fulfill({
        status: 206,
        headers: { ...cors, 'content-type': 'application/octet-stream', 'content-length': String(part.length), 'content-range': `bytes ${start}-${end}/${all.length}` },
        body: part,
      });
    });
  }
  if (dismissInstallCard) await page.addInitScript(() => localStorage.setItem('unfog.installDismissed', String(Date.now())));
  // The first-run "Track my movement?" card would sit in every frame otherwise.
  await page.addInitScript(() => localStorage.setItem('unfog.trackingOffered', String(Date.now())));
  // Headless Chromium exposes navigator.wakeLock but refuses the request, which would make the tracking pill read
  // "Tracking · keep the screen on"; a Home Screen app on iOS 18.4+ holds the lock, so the frame shows what the
  // phone shows: the request always succeeds here.
  await page.addInitScript(() => {
    const lock = { released: false, type: 'screen', release: async () => {}, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => lock }, configurable: true });
  });
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

/**
 * Scroll a screen so `el` sits flush under its sticky header (scrollIntoView aligns to the scroll box, which
 * runs under the header, so a sliver of the row above would show). Scrolls whichever ancestor scrolls.
 */
async function flushUnderHeader(page, screenId, elFn) {
  await page.evaluate(
    ({ screenId, src }) => {
      const el = new Function('return (' + src + ')')()();
      const head = document.querySelector(`#${screenId} .screen-head`);
      el.scrollIntoView({ block: 'start' });
      const d = el.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
      if (Math.abs(d) < 1) return;
      let sc = el.parentElement;
      while (sc && sc.scrollHeight <= sc.clientHeight + 1) sc = sc.parentElement;
      (sc ?? window).scrollBy(0, d);
    },
    { screenId, src: elFn.toString() },
  );
}

/** Help → Settings → Basemap: the same taps a user makes; leaves the app on the map tab. */
async function setBasemap(page, label) {
  await page.locator('.tab[data-tab="help"]').click();
  await page.waitForSelector('#screen-help', { state: 'visible' });
  const settings = page.locator('#help-settings');
  if (!(await settings.evaluate((d) => d.open))) await settings.locator('summary').click();
  await settings.locator('.seg.inline[aria-label="Basemap"] button', { hasText: new RegExp(`^${label}$`) }).click();
  await settings.locator('summary').click();
  await page.locator('.tab[data-tab="map"]').click();
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
  // Feedback-3: the hand-off row under Go (Google Maps / Apple Maps / Save GPX) belongs in the frame.
  await page.waitForSelector('.sheet.route .handoff:not([hidden]) a.gmaps', { state: 'visible', timeout: 20_000 });
  await idle(page, 1200);
  const cands = await page.$$eval('.sheet.route .cand', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('  candidates:', cands);
  console.log('  hand-off row:', await page.$eval('.sheet.route .handoff', (e) => e.textContent.replace(/\s+/g, ' ').trim()));
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
  await page.waitForSelector('.sheet.route.loop .handoff:not([hidden]) a.gmaps', { state: 'visible', timeout: 20_000 });
  await idle(page, 1200);
  const loops = await page.$$eval('.sheet.route.loop .cand', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const loopTitle = await page.$eval('.sheet.route.loop h2', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  const loopStatus = await page.$eval('.sheet.route.loop .route-status', (e) => e.textContent.trim());
  console.log('  loop title:', loopTitle, '| status:', JSON.stringify(loopStatus));
  console.log('  loops:', loops);
  console.log('  hand-off row:', await page.$eval('.sheet.route.loop .handoff', (e) => e.textContent.replace(/\s+/g, ' ').trim()));
  await shot(page, 'loop');
  // A 3 km loop already needs two Google Maps parts, and the taller sheet leaves the map strip ~120 px; the 2 km
  // preset (one tap away) is captured too so the page can use whichever frame reads better.
  await page.locator('.sheet.route.loop .chips button', { hasText: /^2 km$/ }).click();
  await page.waitForFunction(() => /about 2 km/.test(document.querySelector('.sheet.route.loop h2')?.textContent ?? '') && document.querySelectorAll('.sheet.route.loop .cand').length >= 2, null, { timeout: 90_000 });
  await page.waitForSelector('.sheet.route.loop .handoff:not([hidden]) a.gmaps', { state: 'visible', timeout: 20_000 });
  await idle(page, 1200);
  console.log('  loops 2 km:', await page.$$eval('.sheet.route.loop .cand', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim())));
  console.log('  hand-off row:', await page.$eval('.sheet.route.loop .handoff', (e) => e.textContent.replace(/\s+/g, ' ').trim()));
  await shot(page, 'loop-2km');
  await page.locator('.sheet.route.loop .chips button', { hasText: /^3 km$/ }).click();
  await page.waitForFunction(() => /about 3 km/.test(document.querySelector('.sheet.route.loop h2')?.textContent ?? ''), null, { timeout: 90_000 });
  await page.getByRole('button', { name: 'Clear destination' }).click();
  await idle(page, 300);

  // 3c. Basemaps (feedback-1): Satellite (Esri imagery under the same fog, labels kept) and the Dark "night" map —
  // switched in Help → Settings → Basemap, the same taps a user makes. Over dark rooftops the fog only reads where
  // whole blocks are unexplored, so the frame is a little wider than Fog (z14.6) and centred ~600 m south-east of
  // home: the walked blocks form a lighter island upper-left with lit street corridors, deep fog around them.
  await page.evaluate((c) => window.__unfog.ctx.map.map.jumpTo({ center: [c[0] + 0.003, c[1] - 0.005], zoom: 14.6 }), HOME);
  await setBasemap(page, 'Satellite');
  await page.waitForFunction(
    () => {
      const m = window.__unfog.ctx.map.map;
      const style = m.getStyle();
      return style?.name === 'unfog-satellite' && style.layers.some((l) => l.type === 'symbol') && m.isStyleLoaded() && m.areTilesLoaded();
    },
    null,
    { timeout: 120_000 },
  );
  await idle(page, 2500);
  await shot(page, 'satellite');
  await page.evaluate((c) => window.__unfog.ctx.map.map.jumpTo({ center: c, zoom: 15.3 }), HOME);
  await setBasemap(page, 'Dark');
  await page.waitForFunction(() => document.documentElement.classList.contains('dark') && window.__unfog.ctx.map.map.getStyle()?.name !== 'unfog-satellite' && window.__unfog.ctx.map.map.isStyleLoaded() && window.__unfog.ctx.map.map.areTilesLoaded(), null, { timeout: 120_000 });
  await idle(page, 2500);
  await shot(page, 'night');
  await setBasemap(page, 'Map');
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark') && window.__unfog.ctx.map.map.isStyleLoaded() && window.__unfog.ctx.map.map.areTilesLoaded(), null, { timeout: 120_000 });
  await idle(page, 1500);

  // 3d. Coverage v2: pan to eastern Long Island (no prebuilt tiles there) and let the prefetch driver fetch the
  // streets around the map centre from the real packs, so Data → Routing data has something to list.
  // The prefetch policy ignores map moves for 60 s after a position fix (positionPriorityMs), and resolving a
  // route/loop origin just produced one — so pan, let that window pass, then move once more so a fresh
  // moveend is the notification that counts.
  await page.evaluate((c) => window.__unfog.ctx.map.map.jumpTo({ center: c, zoom: 14 }), WESTHAMPTON);
  await page.waitForTimeout(61_000);
  await page.evaluate((c) => window.__unfog.ctx.map.map.jumpTo({ center: [c[0] + 0.002, c[1]], zoom: 14 }), WESTHAMPTON);
  // Poll the engine (index → byte ranges → IndexedDB); the driver's own throttle is 5 s.
  let packs = await page.evaluate(() => window.__unfog.ctx.engines.route.packsStatus());
  const t1 = Date.now();
  while (packs.totalTiles === 0 && Date.now() - t1 < 180_000) {
    await page.waitForTimeout(3000);
    packs = await page.evaluate(() => window.__unfog.ctx.engines.route.packsStatus());
  }
  const packsOk = packs.totalTiles > 0;
  console.log(`  packs after the pan: ${packsOk ? 'fetched' : 'NOT fetched (timeout)'} — ${packs.totalTiles} tiles, ${Math.round(packs.totalBytes / 1024)} KB, cells:`, packs.cells.map((c) => `${c.cell} ${c.source ?? ''}`));
  await page.evaluate((c) => window.__unfog.ctx.map.map.jumpTo({ center: c, zoom: 15.3 }), HOME);
  await idle(page, 600);

  // 4. Data screen, framed on Backup + Routing data (the automatic rows + the prebuilt Regions list): the
  // Sources cards above them show set-up state, which is not a landing-page subject.
  await page.locator('.tab[data-tab="data"]').click();
  await page.waitForSelector('#screen-data .row-item', { state: 'visible', timeout: 20_000 });
  if (packsOk) await page.waitForSelector('#screen-data .packs-cell', { state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(400);
  console.log('  routing data rows:', await page.$$eval('#screen-data .packs-cell, #screen-data .packs-total', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim())));
  await flushUnderHeader(page, 'screen-data', () => [...document.querySelectorAll('#screen-data h3')].find((h) => h.textContent.trim() === 'Backup'));
  await page.waitForTimeout(350);
  await shot(page, 'data');
  await page.evaluate(() => document.querySelector('#screen-data .screen-body')?.scrollTo(0, 0));

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
  await sections.nth(1).locator('summary').click();

  // 7. Tracking (feedback-2): the switch goes on (the location permission is already granted in this context),
  // the map shows only the quiet "Tracking" pill top-left; then Help → Settings with the switch on.
  // The emulated position fires once; minutes later the app's cached fix is stale and it asks for a fresh one.
  // A nudged position = the fresh fix a phone would have, and the fix the new session's pill waits for.
  await ctx.setGeolocation({ longitude: HOME[0] + 0.00001, latitude: HOME[1], accuracy: 8 });
  await page.waitForTimeout(500);
  const trackingOn = await page.evaluate(() => window.__unfog.ctx.tracking.setEnabled(true));
  console.log('  tracking switch →', trackingOn, trackingOn ? '' : JSON.stringify(await page.$eval('.toasts', (e) => e.textContent.trim()).catch(() => '')));
  await ctx.setGeolocation({ longitude: HOME[0] + 0.00002, latitude: HOME[1], accuracy: 8 });
  await page.locator('.tab[data-tab="map"]').click();
  await page.evaluate((c) => window.__unfog.ctx.map.map.jumpTo({ center: c, zoom: 16 }), HOME);
  await page.waitForSelector('.track-pill:not([hidden])', { state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector('.track-pill .t')?.textContent === 'Tracking', null, { timeout: 30_000 }).catch(() => {});
  await idle(page, 900);
  console.log('  pill:', JSON.stringify(await page.$eval('.track-pill', (e) => e.textContent.trim())));
  await shot(page, 'tracking');
  await page.locator('.tab[data-tab="help"]').click();
  const settings = page.locator('#help-settings');
  if (!(await settings.evaluate((d) => d.open))) await settings.locator('summary').click();
  // Settings is the last section, so the scroller cannot bring its row to the top: show the row above it in full
  // instead (flush under the sticky Help header) rather than a sliver of it.
  await flushUnderHeader(page, 'screen-help', () => document.getElementById('help-settings').previousElementSibling);
  await page.waitForTimeout(350);
  console.log('  switch aria-checked:', await settings.locator('.switch').getAttribute('aria-checked'));
  await shot(page, 'settings');
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
        for (const id of ['views', 'loops', 'tracking', 'how', 'export', 'install', 'privacy', 'faq']) {
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
