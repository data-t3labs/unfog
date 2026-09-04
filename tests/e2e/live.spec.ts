/**
 * LIVE smoke — the one suite that asserts on the DEPLOYED bytes at
 * https://data-t3labs.github.io/unfog/, including the `.ufp` graph packs fetched by byte range
 * straight from the sibling shard sites https://data-t3labs.github.io/unfog-graph-1..5/. Every
 * other suite runs against a local dev server or a local `vite preview` build, so nothing else can
 * tell whether what is PUBLISHED works; before 2026-09-04 each deploy was verified with curl alone
 * (docs/BUILD-PLAN.md §2.7 has the story of why a browser could not do it here).
 *
 * Run it with `npm run smoke:live`. Never with `npx playwright test`: this file registers no tests
 * unless UNFOG_LIVE_BASE is set, and only that script sets it, so the default suite and CI never
 * see it and never touch the network.
 *
 * What each test proves about the deploy, and only about the deploy:
 *   1  the published bundle boots the REAL engines, the fog overlay and layer control render, the
 *      published service worker registers and finishes its precache, and Help shows the build hash
 *      that was actually deployed;
 *   2  the published import worker turns the Fog of World fixture into cells, and the published
 *      renderer clears fog over them;
 *   3  a route in a city with NO prebuilt region comes back with candidates — i.e. the deployed
 *      packs-index.json and the .ufp shards answered byte ranges — with no download offer, and the
 *      streets land in Data → Routing data;
 *   4  the Google Maps hand-off row is there and its href is a valid Directions URL;
 *   5  a reload with the network cut still boots, from the published precache;
 *   6  the published landing page loads with no request leaving the origin.
 *
 * Helpers mirror tests/e2e/real.spec.ts (kept local so the two specs change independently).
 */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import zlib from 'node:zlib';

const here = path.dirname(new URL(import.meta.url).pathname);
const shots = path.join(here, 'screenshots');
const FIXTURES = path.join(here, '..', 'fixtures');
const FOW_FILES = [path.join(FIXTURES, 'fow', '23e4lltkkoke'), path.join(FIXTURES, 'fow', 'cd36lltksiwo')];
/** Visited pixels in the two FoW fixture tiles (tests/fixtures/fow/README.md): 3,757 + 33,226. */
const FOW_CELLS = 36_983;

/**
 * Boston Common → Faneuil Hall. Outside every bbox in public/graph/index.json (nyc reaches
 * -73.653 E, and Hoboken / Yonkers are both INSIDE the nyc box, so neither would test anything),
 * inside the published pack coverage — so every street in the answer arrived as a byte range from
 * a shard site. ~1 km apart, dense walkable grid.
 */
const BOSTON = {
  name: 'Faneuil Hall',
  locality: 'Boston, MA',
  lonlat: [-71.0555, 42.36] as [number, number],
  origin: [-71.0656, 42.355] as [number, number],
};

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `live-${name}.png`), fullPage: false });

// ---------------------------------------------------------------- page-side types (structural, kept independent of src/)

interface GridStats {
  visitedCells: number;
  areaM2: number;
  tiles: number;
  version: number;
}
type UnfogWindow = {
  __unfog?: {
    ready: boolean;
    mock: boolean;
    openRoute?: (d: { name: string; locality?: string; lonlat: [number, number]; origin?: [number, number] }) => void;
    ctx?: {
      engines: {
        grid: {
          getStats(): Promise<GridStats>;
          listBaseTiles(): Promise<Array<[number, number]>>;
          getTileCounts(level: number, tx: number, ty: number): Promise<Uint8Array | null>;
        };
      };
      map: {
        map: {
          loaded(): boolean;
          isMoving(): boolean;
          once(ev: 'idle', cb: () => void): unknown;
          jumpTo(o: { center: [number, number]; zoom: number }): unknown;
          getSource(id: string): { tiles?: string[] } | undefined;
          getLayer(id: string): unknown;
          areTilesLoaded(): boolean;
          project(ll: [number, number]): { x: number; y: number };
          getCenter(): { lng: number; lat: number };
        };
      };
    };
  };
};

// ---------------------------------------------------------------- helpers

interface Booted {
  errors: string[];
  consoleErrors: string[];
  /** Every request the page made, as absolute URLs — test 6 checks nothing left the origin. */
  requests: string[];
}

function watch(page: Page): Booted {
  const b: Booted = { errors: [], consoleErrors: [], requests: [] };
  page.on('pageerror', (e) => b.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') b.consoleErrors.push(m.text());
  });
  page.on('request', (r) => b.requests.push(r.url()));
  return b;
}

/** Boot the deployed app and insist on the real engines (a mock boot would prove nothing). */
async function boot(page: Page, opts: { query?: string } = {}): Promise<Booted> {
  const b = watch(page);
  await page.addInitScript(() => {
    localStorage.setItem('unfog.installDismissed', String(Date.now()));
    localStorage.setItem('unfog.trackingOffered', String(Date.now()));
  });
  await page.goto(opts.query ?? '');
  await waitReady(page);
  expect(b.errors, 'no uncaught page errors during boot').toEqual([]);
  return b;
}

async function waitReady(page: Page, timeout = 120_000): Promise<void> {
  await page.waitForFunction(() => (window as unknown as UnfogWindow).__unfog?.ready === true, null, { timeout });
  expect(await page.evaluate(() => (window as unknown as UnfogWindow).__unfog?.mock), 'deployed app runs the real engines').toBe(false);
}

/** Wait until MapLibre has nothing left to load/render (overlay tiles included). */
async function idle(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = (window as unknown as UnfogWindow).__unfog?.ctx?.map.map;
        if (!map) return resolve();
        if (map.loaded() && !map.isMoving()) return resolve();
        map.once('idle', () => resolve());
      }),
  );
  await page.waitForTimeout(100);
}

const stats = (page: Page) => page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.grid.getStats());

/** Data tab → hidden file input → wait for the import to finish; returns the summary line. */
async function importFiles(page: Page, files: string[]): Promise<string> {
  await page.getByRole('tab', { name: 'Data' }).click();
  await expect(page.locator('#screen-data')).toBeVisible();
  await page.locator('#screen-data input[type=file]').setInputFiles(files);
  await expect(page.locator('#screen-data .import-result .name')).toBeVisible({ timeout: 90_000 });
  return (await page.locator('#screen-data .import-result .name').textContent()) ?? '';
}

function pngPixel(png: Buffer): [number, number, number, number] {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let off = 8;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') colorType = data[9];
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  // One row: filter byte + one pixel. Every filter type degenerates to identity for a 1×1 image.
  const px = zlib.inflateSync(Buffer.concat(idat)).subarray(1);
  if (colorType === 6) return [px[0], px[1], px[2], px[3]];
  if (colorType === 2) return [px[0], px[1], px[2], 255];
  throw new Error(`unsupported PNG colour type ${colorType}`);
}

async function pixelLuma(page: Page, x: number, y: number): Promise<number> {
  const [r, g, b] = pngPixel(await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 }, scale: 'css' }));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The route sheet covers the tab bar; close it before touching Data / Help. */
async function closeSheet(page: Page): Promise<void> {
  await page.locator('.sheet.route').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.sheet.route')).toBeHidden();
}

/** Wait for a route to finish: no spinner, no error, at least one candidate row. */
async function waitRouted(page: Page): Promise<void> {
  const sheet = page.locator('.sheet.route');
  await expect(sheet.locator('.route-status .spinner')).toBeHidden({ timeout: 120_000 });
  await expect(sheet.locator('.route-status .error')).toHaveCount(0);
  await expect(sheet.locator('.cand').first()).toBeVisible({ timeout: 120_000 });
}

// ---------------------------------------------------------------- suite

// Opt-in gate. The `smoke:live` npm script is the only thing that sets UNFOG_LIVE_BASE, so with a
// plain `npx playwright test` (default config, which matches every tests/e2e/*.spec.ts) this file
// contributes no tests and `--list` does not mention it. Function declarations hoist, so the call
// may read ahead of the definition.
if (process.env.UNFOG_LIVE_BASE) registerLiveSuite();

function registerLiveSuite(): void {
  const BASE = new URL(process.env.UNFOG_LIVE_BASE!);
  const ORIGIN = BASE.origin;

  test.describe(`Unfog live smoke (${BASE.href})`, () => {
    test('1. boots from the deploy: map, fog overlay, layer control, service worker precache, build hash', async ({ page }) => {
      const b = await boot(page);
      await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
      await expect(page.locator('.seg button.on'), 'layer control, Fog selected').toHaveText('Fog');
      await expect(page.getByRole('button', { name: 'Search destination' })).toBeVisible();
      const overlay = await page.evaluate(() => {
        const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
        return { source: map.getSource('unfog-overlay')?.tiles?.[0], layer: Boolean(map.getLayer('unfog-overlay')) };
      });
      expect(overlay.layer, 'fog overlay layer on the deployed map').toBe(true);
      expect(overlay.source).toMatch(/^fog:\/\/\{z\}\/\{x\}\/\{y\}\?v=\d+$/);

      // The published service worker: registered, activated, controlling this page (workbox
      // clientsClaim), with its precache actually populated — a registration that never finished
      // installing would leave the offline test in test 5 with nothing to boot from.
      await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 90_000 });
      const reg = await page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return { scope: r?.scope ?? null, active: Boolean(r?.active), state: r?.active?.state ?? null };
      });
      expect(reg.scope, 'service-worker scope is the deployed app scope').toBe(`${ORIGIN}/unfog/`);
      expect(reg.active).toBe(true);
      expect(reg.state).toBe('activated');
      const precache = await page.evaluate(async () => {
        const names = await caches.keys();
        const name = names.find((n) => n.startsWith('workbox-precache'));
        if (!name) return { name: null, urls: [] as string[] };
        return { name, urls: (await (await caches.open(name)).keys()).map((r) => r.url) };
      });
      expect(precache.name, 'workbox precache exists').not.toBeNull();
      expect(precache.urls.length, `precache is populated (${precache.urls.length} entries)`).toBeGreaterThan(10);
      expect(precache.urls.some((u) => u.endsWith('.js') || u.includes('.js?')), 'precache holds the app bundle').toBe(true);
      expect(precache.urls.every((u) => u.startsWith(ORIGIN)), 'every precached URL is on the deployed origin').toBe(true);

      // Help shows the build the deploy was made from (vite.config.ts buildStamp → short git sha).
      await page.getByRole('tab', { name: 'Help' }).click();
      const build = (await page.locator('.build').textContent())?.trim() ?? '';
      expect(build, `Help build stamp "${build}" is a git sha, not the "dev" fallback`).toMatch(/^[0-9a-f]{7,40}$/);
      test.info().annotations.push({ type: 'deployed build', description: build });
      await page.getByRole('tab', { name: 'Map' }).click();
      await idle(page);
      await shot(page, 'boot');
      expect(b.errors, 'no uncaught page errors').toEqual([]);
      expect(b.consoleErrors, 'no console errors on the deployed build').toEqual([]);
    });

    test('2. the deployed import worker takes the Fog of World fixture and the deployed renderer clears fog over it', async ({ page }) => {
      const b = await boot(page);
      const summary = await importFiles(page, FOW_FILES);
      expect(summary).toMatch(/^36,983 new cells, .* added$/);
      const s = await stats(page);
      expect(s.visitedCells, 'cells from the fixture').toBeGreaterThan(0);
      expect(s.visitedCells).toBe(FOW_CELLS);
      expect(s.tiles).toBeGreaterThan(0);
      await page.getByRole('tab', { name: 'Map' }).click();
      await expect(page.locator('.stat-chip .sub')).toHaveText('36,983 cells');

      // A solidly visited cell and the centre of an untouched tile two tiles east (still Hainan).
      const spots = await page.evaluate(async () => {
        const grid = (window as unknown as UnfogWindow).__unfog!.ctx!.engines.grid;
        const tiles = await grid.listBaseTiles();
        const [tx, ty] = tiles[0];
        const counts = await grid.getTileCounts(14, tx, ty);
        if (!counts) throw new Error('no counts');
        let best = -1;
        let bestScore = -1;
        for (let i = 0; i < counts.length; i++) {
          if (!counts[i]) continue;
          const ix = i & 255;
          const iy = i >> 8;
          let score = 0;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) {
              const x = ix + dx;
              const y = iy + dy;
              if (x >= 0 && x < 256 && y >= 0 && y < 256 && counts[y * 256 + x]) score++;
            }
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        }
        const WORLD = 1 << 22;
        const toLL = (x: number, y: number): [number, number] => {
          const n = Math.PI - (2 * Math.PI * y) / WORLD;
          return [(x / WORLD) * 360 - 180, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
        };
        const have = new Set(tiles.map(([x, y]) => `${x}/${y}`));
        let ex = tx + 2;
        while (have.has(`${ex}/${ty}`)) ex++;
        return { visited: toLL(tx * 256 + (best & 255) + 0.5, ty * 256 + (best >> 8) + 0.5), empty: toLL(ex * 256 + 128, ty * 256 + 128) };
      });

      const jump = (ll: [number, number]) => page.evaluate((c) => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.jumpTo({ center: c, zoom: 17 }), ll);
      const centre = async () =>
        page.evaluate(() => {
          const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
          const p = map.project([map.getCenter().lng, map.getCenter().lat]);
          const r = document.querySelector('#map')!.getBoundingClientRect();
          return { x: r.left + p.x, y: r.top + p.y };
        });
      await jump(spots.visited);
      await idle(page);
      await shot(page, 'fog-cleared');
      const c = await centre();
      const lumaVisited = await pixelLuma(page, c.x, c.y);
      await jump(spots.empty);
      await idle(page);
      await shot(page, 'fog-intact');
      const lumaFog = await pixelLuma(page, c.x, c.y);
      expect(lumaFog, `fog pixel is dark (visited ${lumaVisited.toFixed(0)}, fog ${lumaFog.toFixed(0)})`).toBeLessThan(110);
      expect(lumaVisited - lumaFog, `the imported area is clearly lighter than fog (visited ${lumaVisited.toFixed(0)}, fog ${lumaFog.toFixed(0)})`).toBeGreaterThan(60);
      expect(b.errors).toEqual([]);
    });

    test('3. routes where nothing is prebuilt: the deployed packs answer, no download offer, the streets land in Data', async ({ page }) => {
      const b = await boot(page);
      // Nothing is prebuilt in Boston, so every street below came from packs-index.json and a
      // byte range against a shard site — which is exactly what only a live run can prove.
      await page.evaluate((d) => (window as unknown as UnfogWindow).__unfog!.openRoute!(d), BOSTON);
      const sheet = page.locator('.sheet.route');
      await expect(sheet).toBeVisible();
      await waitRouted(page);
      const cands = await sheet.locator('.cand').allInnerTexts();
      expect(cands.length, `route candidates in Boston (${JSON.stringify(cands)})`).toBeGreaterThan(0);
      for (const c of cands) expect(c, 'each candidate carries a distance and a duration').toMatch(/\d[\d.,]*\s*(m|km)\b[\s\S]*\d+\s*(min|h)\b/);

      // The status line must not fall back to "no coverage here" — no download button, no offer.
      const status = (await sheet.locator('.route-status').innerText()).trim();
      expect(status, `route status "${status}" must not offer a download`).not.toMatch(/Download|Route anyway|straight line/i);
      await expect(sheet.getByRole('button', { name: /Download this area/ }), 'no "Download this area" offer where packs cover').toHaveCount(0);
      await shot(page, 'route-boston');

      // Data → Routing data: the pack cache now holds the streets, named and sized.
      await closeSheet(page);
      await page.getByRole('tab', { name: 'Data' }).click();
      const rows = page.locator('.packs-cell');
      await expect(rows.first(), 'Routing data lists the cached streets').toBeVisible({ timeout: 60_000 });
      const names = await rows.locator('.name').allInnerTexts();
      const sizes = await rows.locator('.st').allInnerTexts();
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(n, 'each row names a region').toMatch(/\S/);
      for (const s of sizes) expect(s, `each row shows a size ("${s}")`).toMatch(/\d[\d.,]*\s*(B|KB|MB|GB)\b/);
      await expect(page.locator('.packs-total')).toHaveText(/\d[\d.,]*\s*(B|KB|MB|GB) of streets on this phone/);
      await expect(page.locator('.packs-age')).toHaveText(/Coverage list updated/);
      await shot(page, 'routing-data');
      expect(b.errors).toEqual([]);
    });

    test('4. the Google Maps hand-off row is there and its href is a valid Directions URL', async ({ page }) => {
      await boot(page);
      await page.evaluate((d) => (window as unknown as UnfogWindow).__unfog!.openRoute!(d), BOSTON);
      await expect(page.locator('.sheet.route')).toBeVisible();
      await waitRouted(page);
      // The hand-off block sits under the Go button and appears with the selected candidate. Do NOT
      // tap Go first: that starts following, which collapses the sheet into the follow bar and hides
      // the row — a race an assertion can win on a fast run and lose on a slow one. handoff.spec.ts
      // reads it the same way, without a tap.
      const handoff = page.locator('.sheet.route .handoff');
      await expect(handoff, 'the hand-off block under Go').toBeVisible();
      const gmaps = handoff.locator('a.gmaps');
      await expect(gmaps, 'the Google Maps row').toBeVisible();
      const href = await gmaps.getAttribute('href');
      expect(href, 'the row carries an href').toBeTruthy();
      const u = new URL(href!);
      expect(u.host).toBe('www.google.com');
      expect(u.pathname).toBe('/maps/dir/');
      expect(u.searchParams.get('travelmode')).toBe('walking');
      expect(u.searchParams.get('api')).toBe('1');
      expect(u.searchParams.get('destination'), 'destination is a LAT,LNG pair').toMatch(/^-?\d+\.\d+,-?\d+\.\d+$/);
      await shot(page, 'handoff');
    });

    test('5. offline: a reload with the network cut still boots, from the deployed precache', async ({ page, context }) => {
      await boot(page);
      await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 90_000 });
      // A second online load so the style and its tiles go through the now-controlling worker.
      await page.reload();
      await waitReady(page);
      await page.evaluate(() => navigator.serviceWorker.ready);
      await idle(page);

      await context.setOffline(true);
      try {
        await page.reload();
        await waitReady(page);
        await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
        await expect(page.locator('.seg button.on')).toHaveText('Fog');
        // Prove the boot above really came off the precache: a fresh URL nothing has cached must
        // fail. (`navigator.onLine` is no use — Playwright cuts the network without flipping it.)
        const reachedNetwork = await page.evaluate(async (u) => {
          try {
            await fetch(u, { cache: 'no-store' });
            return true;
          } catch {
            return false;
          }
        }, `${ORIGIN}/unfog/__live-smoke-offline-probe-${Date.now()}`);
        expect(reachedNetwork, 'the context really is offline: an uncached request fails').toBe(false);
        await idle(page);
        await shot(page, 'offline');
      } finally {
        await context.setOffline(false);
      }
    });

    test('6. the landing page loads and makes no request off the origin', async ({ page }) => {
      const b = watch(page);
      await page.goto(`${ORIGIN}/unfog/welcome/`, { waitUntil: 'load' });
      await expect(page.locator('h1')).toContainText('Lift the fog');
      await expect(page.getByRole('link', { name: 'Open Unfog' }).first()).toHaveAttribute('href', '/unfog/');
      // Fonts, styles and images are all self-hosted; a request to any other origin would mean the
      // deployed landing page leaks a visitor to a third party.
      const foreign = [...new Set(b.requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:')))];
      expect(foreign, `every request stays on ${ORIGIN}`).toEqual([]);
      expect(b.requests.some((u) => u.endsWith('.woff2')), 'the self-hosted fonts were fetched').toBe(true);
      expect(b.errors).toEqual([]);
      await shot(page, 'welcome');
    });
  });
}
