/**
 * Real-engine end-to-end suite: the grid worker (IndexedDB), the route worker (prebuilt NYC graph
 * from public/graph/) and the import worker, driven through the UI at the iPhone 15 viewport.
 *
 * Hermetic by construction: the only server is the local Vite dev server (and, for the offline
 * block, `vite preview` of a production build so the service worker exists — see
 * playwright.config.ts). Photon is stubbed with page.route; the OpenFreeMap basemap may or may
 * not load and no assertion depends on it. Every test gets a fresh browser context, so
 * IndexedDB and localStorage start empty.
 *
 * The app exposes `window.__unfog = { ready, mock, openRoute, ctx }` once the map is idle
 * (src/main.ts); `ctx.engines.grid` / `ctx.engines.route` are the Comlink clients of the real
 * workers and are used from page.evaluate for setup and cross-checks.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const here = path.dirname(new URL(import.meta.url).pathname);
const shots = path.join(here, 'screenshots');
const FIXTURES = path.join(here, '..', 'fixtures');
const FOW_FILES = [path.join(FIXTURES, 'fow', '23e4lltkkoke'), path.join(FIXTURES, 'fow', 'cd36lltksiwo')];
/** Visited pixels in the two FoW fixture tiles (tests/fixtures/fow/README.md): 3,757 + 33,226. */
const FOW_CELLS = 36_983;

const BEDFORD_N7: [number, number] = [-73.9568, 40.7176];
const DOMINO_PARK = { name: 'Domino Park', locality: 'Williamsburg, Brooklyn', lonlat: [-73.9678, 40.7142] as [number, number] };
/**
 * Sutphin Blvd → Archer Av (Jamaica, Queens): graph tile 1207/1539, not shared with the Williamsburg
 * routes. (Not Jamaica Center [-73.801, 40.702] → Hillside Av [-73.79, 40.71]: walk mode returns no
 * candidates there while drive routes — reported as an engine bug in the QA report.)
 */
const JAMAICA = { name: 'Archer Avenue', locality: 'Jamaica, Queens', lonlat: [-73.798, 40.706] as [number, number], origin: [-73.8075, 40.702] as [number, number] };

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `real-${name}.png`), fullPage: false });
/** Feedback-2 review frames (route sheet, loop sheet, Settings, the tracking pill). */
const shotFb2 = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `fb2-${name}.png`), fullPage: false });

// ---------------------------------------------------------------- page-side types (structural, kept independent of src/)

interface GridStats {
  visitedCells: number;
  areaM2: number;
  tiles: number;
  version: number;
}
interface RouteCandidate {
  name: string;
  coords: Array<[number, number]>;
  lengthM: number;
  newM: number;
  pctNew: number;
  etaMin: number;
}
interface Track {
  id: string;
  source: string;
  name?: string;
  points: Array<[number, number]>;
}
// Not `Window & …`: src/main.ts augments Window with the app's own __unfog type, and the
// intersection would drag maplibre's overloads into these structural stubs.
type UnfogWindow = {
  __unfog?: {
    ready: boolean;
    mock: boolean;
    openRoute?: (d: { name: string; locality?: string; lonlat: [number, number]; origin?: [number, number] }) => void;
    openLoop?: (from?: [number, number]) => void;
    ctx?: {
      engines: {
        grid: {
          getStats(): Promise<GridStats>;
          applyPayload(p: { tracks: Track[]; meta: { source: string; fileName: string; items: number } }): Promise<{ stats: GridStats }>;
          listBaseTiles(): Promise<Array<[number, number]>>;
          getTileCounts(level: number, tx: number, ty: number): Promise<Uint8Array | null>;
          markTrack(t: { id: string; source: string; name?: string; points: Array<[number, number, number?]> }): Promise<unknown>;
          listTracks(): Promise<Array<{ id: string; source: string; name?: string; points: number; lengthM: number }>>;
        };
        route: {
          route(req: { from: [number, number]; to: [number, number]; mode: string; detour: number }): Promise<{ candidates: RouteCandidate[]; shortestM: number }>;
          loop(req: { from: [number, number]; mode: string; targetKm: number }): Promise<{ candidates: RouteCandidate[]; shortestM: number }>;
          invalidateCells(version: number): Promise<void>;
        };
      };
      dataChanged(): Promise<void>;
      /** "Track my movement" (src/app/tracking.ts); rollover = the midnight path, driven directly. */
      tracking: { enabled: boolean; active: boolean; rollover(): Promise<void> };
      map: {
        map: {
          loaded(): boolean;
          isMoving(): boolean;
          once(ev: 'idle', cb: () => void): unknown;
          jumpTo(o: { center: [number, number]; zoom: number }): unknown;
          getSource(id: string): { tiles?: string[] } | undefined;
          getLayer(id: string): unknown;
          getStyle(): { name?: string; layers: Array<{ id: string }> };
          areTilesLoaded(): boolean;
          project(ll: [number, number]): { x: number; y: number };
          getCenter(): { lng: number; lat: number };
        };
      };
    };
  };
  __shared?: Array<{ name: string; type: string; b64: string }>;
};

// ---------------------------------------------------------------- helpers

interface BootOptions {
  /** Keep the iOS install card (default: pre-dismissed so the chrome is unobstructed). */
  installCard?: boolean;
  /** 'capture' replaces navigator.share with a stub that records the shared File; 'none' removes share so the <a download> path runs. */
  share?: 'capture' | 'none';
  /** Query string, e.g. '?mock=1'. */
  query?: string;
  /** Extra init script. */
  init?: () => void;
  /** Longest wait for `__unfog.ready`. */
  readyTimeout?: number;
}

interface Booted {
  errors: string[];
  consoleErrors: string[];
}

async function prepare(page: Page, opts: BootOptions = {}): Promise<Booted> {
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  if (!opts.installCard) await page.addInitScript(() => localStorage.setItem('unfog.installDismissed', String(Date.now())));
  // The first-run "Track my movement?" card (feedback-2) is smoke-tested; here it would only shift the chrome.
  await page.addInitScript(() => localStorage.setItem('unfog.trackingOffered', String(Date.now())));
  if (opts.share === 'capture') {
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: Array<{ name: string; type: string; b64: string }> };
      w.__shared = [];
      const toB64 = (buf: ArrayBuffer) => {
        const bytes = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      };
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: { files?: File[] }) => {
          for (const f of data.files ?? []) w.__shared.push({ name: f.name, type: f.type, b64: toB64(await f.arrayBuffer()) });
        },
      });
    });
  } else if (opts.share === 'none') {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    });
  }
  if (opts.init) await page.addInitScript(opts.init);
  return { errors, consoleErrors };
}

/** Wait for the real engines + an idle map. Fails fast if the app fell back to the mocks. */
async function waitReady(page: Page, timeout = 90_000): Promise<void> {
  await page.waitForFunction(() => (window as unknown as UnfogWindow).__unfog?.ready === true, null, { timeout });
  const mock = await page.evaluate(() => (window as unknown as UnfogWindow).__unfog?.mock);
  expect(mock, 'real engines (not mock mode)').toBe(false);
}

async function boot(page: Page, opts: BootOptions = {}): Promise<Booted> {
  const b = await prepare(page, opts);
  await page.goto(opts.query ?? '');
  await waitReady(page, opts.readyTimeout);
  expect(b.errors, 'no uncaught page errors during boot').toEqual([]);
  return b;
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
  const input = page.locator('#screen-data input[type=file]');
  await expect(input).toHaveAttribute('accept', /\.zip/);
  await input.setInputFiles(files);
  const importBtn = page.getByRole('button', { name: 'Import files' });
  await expect(importBtn).toBeDisabled();
  await expect(page.locator('#screen-data .import-result .name')).toBeVisible({ timeout: 60_000 });
  await expect(importBtn).toBeEnabled();
  return (await page.locator('#screen-data .import-result .name').textContent()) ?? '';
}

/** "850 m" / "1.3 km" / "0.5 mi" / "300 ft" → metres. */
function parseDistanceM(text: string): number {
  const m = /([\d.,]+)\s*(km|m|mi|ft)\b/.exec(text);
  if (!m) throw new Error(`no distance in "${text}"`);
  const v = Number(m[1].replace(/,/g, ''));
  return m[2] === 'km' ? v * 1000 : m[2] === 'mi' ? v * 1609.344 : m[2] === 'ft' ? v * 0.3048 : v;
}

/** "16 min" / "1 h 05 min" / "2 h" → minutes. */
function parseMinutes(text: string): number {
  const h = /(\d+)\s*h\b/.exec(text);
  const m = /(\d+)\s*min\b/.exec(text);
  if (!h && !m) throw new Error(`no duration in "${text}"`);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

interface CandRow {
  name: string;
  lengthM: number;
  etaMin: number;
  pctNew: number;
  newM: number;
  selected: boolean;
}

/** Read the candidate rows of the route sheet as numbers. */
async function readCands(page: Page): Promise<CandRow[]> {
  return page.locator('.sheet.route .cand').evaluateAll((rows) =>
    rows.map((r) => ({
      name: r.querySelector('.name')?.textContent ?? '',
      st: r.querySelector('.st')?.textContent ?? '',
      nu: r.querySelector('.new')?.textContent ?? '',
      selected: r.classList.contains('on'),
    })),
  ).then((rows) =>
    rows.map((r) => ({
      name: r.name,
      lengthM: parseDistanceM(r.st),
      etaMin: parseMinutes(r.st),
      pctNew: Number(/(\d+)% new/.exec(r.nu)?.[1] ?? NaN),
      newM: parseDistanceM(r.nu.replace(/^\d+% new/, '')),
      selected: r.selected,
    })),
  );
}

async function openRoute(page: Page, dest: { name: string; locality?: string; lonlat: [number, number]; origin?: [number, number] }): Promise<void> {
  await page.evaluate((d) => (window as unknown as UnfogWindow).__unfog!.openRoute!(d), dest);
  await expect(page.locator('.sheet.route')).toBeVisible();
}

/**
 * Every candidate line is drawn in the strip of map between the top chrome and the sheet
 * (route-sheet fit padding, BUILD-PLAN §2.2) — checked in CSS pixels at the 393×852 viewport.
 */
async function expectLinesAboveSheet(page: Page, coords: Array<[number, number]>): Promise<void> {
  await idle(page); // fitBounds animates for 600 ms
  const r = await page.evaluate((cs) => {
    const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of cs) {
      const p = map.project(c);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return {
      minX, maxX, minY, maxY,
      sheetTop: document.querySelector('.sheet.route')!.getBoundingClientRect().top,
      chromeBottom: document.querySelector('.top')!.getBoundingClientRect().bottom,
      width: window.innerWidth,
    };
  }, coords);
  const desc = `lines y ${r.minY.toFixed(0)}–${r.maxY.toFixed(0)}, x ${r.minX.toFixed(0)}–${r.maxX.toFixed(0)}; chrome bottom ${r.chromeBottom.toFixed(0)}, sheet top ${r.sheetTop.toFixed(0)}`;
  expect(r.maxY, `lines end above the sheet (${desc})`).toBeLessThan(r.sheetTop);
  expect(r.minY, `lines start below the top chrome (${desc})`).toBeGreaterThan(r.chromeBottom);
  expect(r.minX, `lines inside the viewport (${desc})`).toBeGreaterThan(0);
  expect(r.maxX, `lines inside the viewport (${desc})`).toBeLessThan(r.width);
}

/** Wait for a (re)route to finish: the spinner is gone and at least one candidate row is there. */
async function waitRouted(page: Page): Promise<CandRow[]> {
  const sheet = page.locator('.sheet.route');
  await expect(sheet.locator('.route-status .spinner')).toBeHidden({ timeout: 60_000 });
  await expect(sheet.locator('.route-status .error')).toHaveCount(0);
  await expect(sheet.locator('.cand').first()).toBeVisible({ timeout: 60_000 });
  return readCands(page);
}

/** Feed geolocation fixes along a line; the recorder needs ≥1.5 m and ≤30 m per 300 ms step. */
async function walk(context: BrowserContext, page: Page, from: [number, number], step: [number, number], n: number, everyMs = 300): Promise<[number, number]> {
  let cur = from;
  for (let i = 0; i < n; i++) {
    cur = [cur[0] + step[0], cur[1] + step[1]];
    await context.setGeolocation({ longitude: cur[0], latitude: cur[1], accuracy: 5 });
    await page.waitForTimeout(everyMs);
  }
  return cur;
}

/** Help → Settings → the "Track my movement" switch (feedback-2: tracking is a switch, not a map button). */
async function setTracking(page: Page, on: boolean): Promise<void> {
  await page.getByRole('tab', { name: 'Help' }).click();
  const settings = page.locator('#help-settings');
  if ((await settings.getAttribute('open')) === null) await settings.locator('summary').click(); // <details open=""> → ''
  const sw = settings.getByRole('switch', { name: 'Track my movement' });
  await expect(sw).toHaveAttribute('aria-checked', String(!on));
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', String(on), { timeout: 20_000 });
  await page.getByRole('tab', { name: 'Map' }).click();
}

/**
 * The pill once a fix has arrived: plain "Tracking", or "Tracking · keep the screen on" where the
 * Screen Wake Lock is unavailable (headless Chromium here; Safari tabs before iOS 18.4).
 */
const PILL_ON = /^Tracking( · keep the screen on)?$/;

/** The persisted session (localStorage `unfog.session`, written on every fix), or null. */
const session = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('unfog.session') ?? 'null') as { id: string; points: unknown[]; distanceM: number } | null);

const listSessions = (page: Page) =>
  page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.grid.listTracks()).then((ts) => ts.filter((t) => t.source === 'session'));

/** Decode the single pixel of a 1×1 PNG (Chromium screenshot with a 1×1 clip at CSS scale). */
function pngPixel(png: Buffer): [number, number, number, number] {
  const sig = png.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let off = 8;
  let colorType = -1;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (width !== 1 || height !== 1) throw new Error(`expected a 1×1 PNG, got ${width}×${height}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // One row: filter byte + one pixel. Every filter type degenerates to identity for a 1×1 image.
  const px = raw.subarray(1);
  if (colorType === 6) return [px[0], px[1], px[2], px[3]];
  if (colorType === 2) return [px[0], px[1], px[2], 255];
  if (colorType === 0) return [px[0], px[0], px[0], 255];
  if (colorType === 4) return [px[0], px[0], px[0], px[1]];
  throw new Error(`unsupported PNG colour type ${colorType}`);
}

/** Luminance of the composited page pixel at CSS coordinates (x, y). */
async function pixelLuma(page: Page, x: number, y: number): Promise<number> {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 }, scale: 'css' });
  const [r, g, b] = pngPixel(png);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfog-e2e-'));
  return path.join(dir, name);
}

/**
 * Walks along real Williamsburg streets around Bedford & N 7th, chosen with the distance-decay
 * probabilities of tests/e2e/landing/capture.mjs (same seed ⇒ the same lived-in fog as the landing
 * site): a realistic ground for the night-mode checks.
 */
function williamsburgWalks(seed = 7): Track[] {
  const gz = fs.readFileSync(path.join(FIXTURES, 'osm', 'williamsburg.json.gz'));
  const data = JSON.parse(zlib.gunzipSync(gz).toString('utf8')) as { elements: Array<{ type: string; id: number; geometry?: Array<{ lon: number; lat: number }>; tags?: { name?: string } }> };
  const ways = data.elements.filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 1);
  const KX = 111320 * Math.cos((40.716 * Math.PI) / 180);
  const KY = 110574;
  const dist = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
  let s = seed >>> 0;
  const rnd = () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const tracks: Track[] = [];
  ways.forEach((w, i) => {
    const g = w.geometry!;
    const mid = g[Math.floor(g.length / 2)];
    const d = dist([mid.lon, mid.lat], BEDFORD_N7);
    const p = 0.92 * Math.exp(-d / 420) + 0.07;
    if (rnd() < p) {
      const count = 1 + Math.floor(Math.pow(rnd(), 1.4) * 9 * Math.exp(-d / 380));
      const points = g.map((pt): [number, number] => [pt.lon, pt.lat]);
      for (let k = 0; k < count; k++) tracks.push({ id: `walk-${i}-${k}`, source: 'gpx', name: w.tags?.name ?? `way ${w.id}`, points });
    }
  });
  return tracks;
}

/** Wait until every basemap and overlay tile in view is loaded and drawn. */
async function tilesSettled(page: Page): Promise<void> {
  await idle(page);
  await page.waitForFunction(() => {
    const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
    return map.loaded() && map.areTilesLoaded();
  }, null, { timeout: 60_000 });
  await idle(page);
}

/** Luminance of a grid of points over the map strip (below the top chrome, above the stat chip). */
async function lumaGrid(page: Page): Promise<number[]> {
  const out: number[] = [];
  for (let y = 230; y <= 690; y += 46) for (let x = 40; x <= 350; x += 62) out.push(await pixelLuma(page, x, y));
  return out;
}

const PHOTON_FC = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: DOMINO_PARK.lonlat }, properties: { name: 'Domino Park', district: 'Williamsburg', city: 'Brooklyn', state: 'New York', country: 'United States', osm_key: 'leisure', osm_value: 'park' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-73.9591, 40.7189] }, properties: { name: 'Domino Sugar Refinery', district: 'Williamsburg', city: 'Brooklyn', osm_key: 'historic', osm_value: 'building' } },
  ],
};

// ================================================================ tests

test.use({ locale: 'en-US' });

test.describe('Unfog real engines', () => {
  test('boots with the real grid + route workers and an empty store', async ({ page }) => {
    await boot(page);
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
    await expect(page.locator('.stat-chip .val')).toHaveText('0.00 km²');
    await expect(page.locator('.stat-chip .big')).toHaveText('0.00 km² explored');
    await expect(page.locator('.stat-chip .sub')).toHaveText('0 cells');
    // Empty state: a one-line hint under the map (tap → Data) and the Stats screen says so too.
    const hint = page.locator('.hint');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('Import your Fog of World history, or turn on tracking in Settings');
    // Feedback-2: no Record button; the tracking pill only shows while the switch is on.
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toHaveCount(0);
    await expect(page.locator('.track-pill')).toBeHidden();
    expect((await hint.boundingBox())!.height, 'hint is a 44 px touch target').toBeGreaterThanOrEqual(44);
    const s = await stats(page);
    expect(s.visitedCells).toBe(0);
    expect(s.tiles).toBe(0);
    // No "mock mode" toast.
    await expect(page.locator('.toast', { hasText: /mock/i })).toHaveCount(0);
    await idle(page);
    await shot(page, 'empty');
    await page.getByRole('tab', { name: 'Stats' }).click();
    await expect(page.locator('#screen-stats')).not.toContainText('mock');
    await expect(page.locator('#screen-stats .empty-state')).toContainText('Nothing explored yet');
    await expect(page.locator('#screen-stats .stat.big .v')).toHaveText('0.00 km²');
    await shot(page, 'stats-empty');
    await page.locator('#screen-stats .empty-state').getByRole('button', { name: 'Go to Data' }).click();
    await expect(page.locator('#screen-data')).toBeVisible();
    await page.getByRole('tab', { name: 'Map' }).click();
    await hint.click();
    await expect(page.locator('#screen-data')).toBeVisible();
    // First run on Data: the picker trap is named, and the how-to opens Help with the export steps expanded.
    await expect(page.locator('#screen-data')).toContainText('If Sync.zip is greyed out');
    await page.getByRole('button', { name: /How to get Sync.zip/ }).click();
    await expect(page.locator('#screen-help')).toBeVisible();
    await expect(page.locator('#help-export')).toHaveAttribute('open', '');
    await expect(page.locator('#help-install')).not.toHaveAttribute('open', '');
    await expect(page.locator('#help-export')).toContainText('Long-press the "Sync" folder');
  });

  test('1. import: two FoW tiles → 36,983 cells; re-import is idempotent', async ({ page }) => {
    const b = await boot(page);
    const summary = await importFiles(page, FOW_FILES);
    expect(summary).toMatch(/^36,983 new cells, .* added$/);
    // Bare tile files picked together are merged into one Fog of World payload (one result line).
    const lines = await page.locator('#screen-data .import-result li').allTextContents();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const l of lines) expect(l).toMatch(/Fog of World/);
    // No internal cell-tile count in the per-file lines (the summary line carries the numbers).
    expect(lines.join('\n')).not.toMatch(/map tiles/);
    await expect(page.locator('.toast.success')).toContainText('36,983 new cells');
    const s1 = await stats(page);
    expect(s1.visitedCells).toBe(FOW_CELLS);
    expect(s1.tiles).toBeGreaterThan(0);
    expect(s1.areaM2).toBeGreaterThan(2e6); // ≈ 36,983 × 82 m² (Hainan, 18.6° N) ≈ 3 km²
    expect(s1.areaM2).toBeLessThan(4e6);
    await page.getByRole('tab', { name: 'Map' }).click();
    await expect(page.locator('.stat-chip .sub')).toHaveText('36,983 cells');
    await expect(page.locator('.stat-chip .val')).toHaveText(/^\d\.\d km²$/);
    await expect(page.locator('.hint')).toBeHidden(); // no longer empty
    await shot(page, 'import');

    // Second import of the same files: nothing new, the store unchanged.
    const again = await importFiles(page, FOW_FILES);
    expect(again).toMatch(/^0 new cells, 0\.00 km² added$/);
    const s2 = await stats(page);
    expect(s2.visitedCells).toBe(FOW_CELLS);
    expect(s2.areaM2).toBe(s1.areaM2);
    await page.getByRole('tab', { name: 'Stats' }).click();
    await expect(page.locator('#screen-stats .stat.big .v')).toHaveText(/km²/);
    await expect(page.locator('#screen-stats')).toContainText('36,983');
    await expect(page.locator('#screen-stats')).toContainText('Last import');
    expect(b.errors).toEqual([]);
  });

  test('2. fog renders over the imported area: overlay tiles load and a visited cell is lighter than fog', async ({ page }) => {
    const b = await boot(page);
    await importFiles(page, FOW_FILES);
    await page.getByRole('tab', { name: 'Map' }).click();

    // A visited cell (count > 0) from the first base tile with data, and the centre of an empty
    // tile two tiles away (still Hainan, never visited).
    const spots = await page.evaluate(async () => {
      const grid = (window as unknown as UnfogWindow).__unfog!.ctx!.engines.grid;
      const tiles = await grid.listBaseTiles();
      const [tx, ty] = tiles[0];
      const counts = await grid.getTileCounts(14, tx, ty);
      if (!counts) throw new Error('no counts');
      // Pick the visited cell with the most visited 3×3 neighbourhood so the cleared core is solid.
      let best = -1, bestScore = -1;
      for (let i = 0; i < counts.length; i++) {
        if (!counts[i]) continue;
        const ix = i & 255, iy = i >> 8;
        let score = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const x = ix + dx, y = iy + dy;
          if (x >= 0 && x < 256 && y >= 0 && y < 256 && counts[y * 256 + x]) score++;
        }
        if (score > bestScore) { bestScore = score; best = i; }
      }
      const cx = tx * 256 + (best & 255) + 0.5, cy = ty * 256 + (best >> 8) + 0.5;
      const WORLD = 1 << 22;
      const toLL = (x: number, y: number): [number, number] => {
        const n = Math.PI - (2 * Math.PI * y) / WORLD;
        return [(x / WORLD) * 360 - 180, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
      };
      const have = new Set(tiles.map(([x, y]) => `${x}/${y}`));
      let ex = tx + 2, ey = ty;
      while (have.has(`${ex}/${ey}`)) ex++;
      return { tiles: tiles.length, visited: toLL(cx, cy), empty: toLL(ex * 256 + 128, ey * 256 + 128), neighbourhood: bestScore };
    });
    expect(spots.tiles).toBeGreaterThan(0);
    expect(spots.visited[0]).toBeGreaterThan(108); // Hainan
    expect(spots.visited[1]).toBeGreaterThan(17);

    const jump = (ll: [number, number]) => page.evaluate((c) => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.jumpTo({ center: c, zoom: 17 }), ll);
    await jump(spots.visited);
    await idle(page);
    const overlay = await page.evaluate(() => {
      const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
      return { source: map.getSource('unfog-overlay')?.tiles?.[0], layer: Boolean(map.getLayer('unfog-overlay')), tilesLoaded: map.areTilesLoaded() };
    });
    expect(overlay.source).toMatch(/^fog:\/\/\{z\}\/\{x\}\/\{y\}\?v=\d+$/);
    expect(overlay.layer).toBe(true);
    expect(overlay.tilesLoaded).toBe(true);
    await shot(page, 'fog-hainan-visited');
    const centre = await page.evaluate(() => {
      const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
      const p = map.project([map.getCenter().lng, map.getCenter().lat]);
      const r = document.querySelector('#map')!.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    const lumaVisited = await pixelLuma(page, centre.x, centre.y);

    await jump(spots.empty);
    await idle(page);
    await shot(page, 'fog-hainan-empty');
    const lumaFog = await pixelLuma(page, centre.x, centre.y);
    // Fog: rgb(16,20,30) at α 0.8 over anything light ≈ luma < 90. A cleared core shows the basemap
    // (or, without basemap tiles, the page background) ≈ luma > 150.
    expect(lumaFog, `fog pixel should be dark (visited ${lumaVisited.toFixed(0)}, fog ${lumaFog.toFixed(0)})`).toBeLessThan(110);
    expect(lumaVisited - lumaFog, `visited pixel should be clearly lighter than fog (visited ${lumaVisited.toFixed(0)}, fog ${lumaFog.toFixed(0)})`).toBeGreaterThan(60);

    // Heat mode renders too.
    await page.getByRole('button', { name: 'Heat' }).click();
    await jump(spots.visited);
    await idle(page);
    const heatSrc = await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.getSource('unfog-overlay')?.tiles?.[0]);
    expect(heatSrc).toMatch(/^heat:\/\//);
    await shot(page, 'heat-hainan');
    expect(b.errors).toEqual([]);
    const overlayErrors = b.consoleErrors.filter((e) => /overlay|renderTile|grid|worker/i.test(e));
    expect(overlayErrors, 'no overlay/grid console errors').toEqual([]);
  });

  test('3. route sheet on the real NYC graph: Direct, then novelty after marking it walked; one mode, slider, Go/End', async ({ page }) => {
    const b = await boot(page);
    await openRoute(page, DOMINO_PARK);
    const sheet = page.locator('.sheet.route');
    await expect(sheet.locator('h2')).toContainText('Domino Park');
    const first = await waitRouted(page);
    // Nothing visited yet: every street is new. Direct must be there and ≈1.3 km.
    const direct = first.find((c) => c.name === 'Direct');
    expect(direct, `Direct candidate present (got ${first.map((c) => c.name).join(', ')})`).toBeTruthy();
    expect(direct!.lengthM).toBeGreaterThan(1000);
    expect(direct!.lengthM).toBeLessThan(1800);
    expect(first[first.length - 1].name).toBe('Direct');
    await expect(sheet.locator('h2 small')).toContainText(/direct$/);
    await expect(sheet.locator('.route-status')).not.toContainText('map centre'); // origin = the user's position
    // The selected row is the only pressed one (assistive tech reads the selection).
    await expect(sheet.locator('.cand[aria-pressed="true"]')).toHaveCount(1);
    // Feedback-2: one travel mode — no Walk/Bike/Drive chips; a line says what a route is instead.
    await expect(sheet.locator('.modes')).toHaveCount(0);
    for (const name of ['Walk', 'Bike', 'Drive']) await expect(sheet.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(sheet.locator('.sheet-note')).toHaveText('Routes follow paths where they exist and straight lines where they don’t, timed at walking pace.');
    expect(direct!.etaMin, 'walking pace (4.8 km/h)').toBeGreaterThanOrEqual(Math.floor((direct!.lengthM / 1000 / 4.8) * 60));
    // The route lines are on the map.
    const routeFeatures = await page.evaluate(() => (window as unknown as { __unfog: { ctx: { map: { map: { querySourceFeatures(s: string): unknown[] } } } } }).__unfog.ctx.map.map.querySourceFeatures('unfog-routes').length);
    expect(routeFeatures).toBeGreaterThan(0);
    await idle(page);
    await shot(page, 'route-empty-grid');
    // The camera fits every candidate (and the pin) between the top chrome and the sheet.
    const firstCoords = await page.evaluate(async (req) => {
      const r = await (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.route(req);
      return r.candidates.flatMap((c) => c.coords).concat([req.from, req.to]);
    }, { from: BEDFORD_N7, to: DOMINO_PARK.lonlat, mode: 'walk', detour: 0.25 });
    await expectLinesAboveSheet(page, firstCoords);
    test.info().annotations.push({ type: 'candidates-empty-grid', description: first.map((c) => `${c.name} ${c.lengthM} m ${c.pctNew}% new`).join(' | ') });

    // Mark the direct route as walked (a GPX-like track), invalidate, and re-open.
    const walked = await page.evaluate(async (req) => {
      const u = (window as unknown as UnfogWindow).__unfog!;
      const res = await u.ctx!.engines.route.route(req);
      const d = res.candidates[res.candidates.length - 1];
      await u.ctx!.engines.grid.markTrack({ id: 'qa-walk', source: 'gpx', name: 'QA walk', points: d.coords.map((c) => [c[0], c[1]] as [number, number]) });
      await u.ctx!.dataChanged();
      return { name: d.name, points: d.coords.length, lengthM: d.lengthM };
    }, { from: BEDFORD_N7, to: DOMINO_PARK.lonlat, mode: 'walk', detour: 0.25 });
    expect(walked.name).toBe('Direct');
    expect(walked.points).toBeGreaterThan(5);
    const s = await stats(page);
    expect(s.visitedCells).toBeGreaterThan(50);

    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
    await openRoute(page, DOMINO_PARK);
    const second = await waitRouted(page);
    test.info().annotations.push({ type: 'candidates-after-walk', description: second.map((c) => `${c.name} ${c.lengthM} m ${c.pctNew}% new ${c.newM} m new`).join(' | ') });
    expect(second.length).toBeGreaterThanOrEqual(2);
    expect(second.length).toBeLessThanOrEqual(3);
    expect(second[0].name).toBe('Most new');
    expect(second[0].selected).toBe(true);
    expect(second[second.length - 1].name).toBe('Direct');
    const direct2 = second[second.length - 1];
    expect(direct2.pctNew, 'the walked Direct route is mostly not new any more').toBeLessThan(40);
    expect(second[0].newM, 'Most new has more unexplored metres than Direct').toBeGreaterThan(direct2.newM);
    expect(second[0].lengthM).toBeLessThanOrEqual(direct2.lengthM * 1.25 + 30); // within the +25 % budget
    await idle(page);
    await shot(page, 'route-after-walk');
    await shotFb2(page, 'route-sheet');

    // Detour slider: +25 % → +60 % re-routes and the budget text changes.
    const sliderRow = sheet.locator('.slider');
    await expect(sliderRow).toContainText('+25%');
    const budgetBefore = await sliderRow.textContent();
    await sheet.getByLabel('Detour budget').fill('60');
    await expect(sliderRow).toContainText('+60%');
    const budgetAfter = await sliderRow.textContent();
    expect(budgetAfter).not.toBe(budgetBefore);
    const wide = await waitRouted(page);
    expect(wide[wide.length - 1].name).toBe('Direct');
    expect(wide[0].lengthM).toBeLessThanOrEqual(direct2.lengthM * 1.6 + 30);
    test.info().annotations.push({ type: 'candidates-60pct', description: wide.map((c) => `${c.name} ${c.lengthM} m ${c.pctNew}% new`).join(' | ') });
    // Persisted for the next sheet (no mode preference any more).
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('unfog.routePrefs') ?? '{}'));
    expect(prefs).toMatchObject({ detour: 0.6 });
    expect(prefs).not.toHaveProperty('mode');

    // Tapping a row selects it; Go collapses to the follow bar; End restores the chrome.
    await sheet.locator('.cand').last().click();
    await expect(sheet.locator('.cand.on .name')).toHaveText('Direct');
    await sheet.getByRole('button', { name: 'Go' }).click();
    const bar = page.locator('.follow-bar');
    await expect(bar).toBeVisible();
    await expect(sheet).toBeHidden();
    await expect(bar).toContainText('Direct');
    await expect(bar).toContainText('Domino Park');
    await expect(page.locator('.float')).toBeHidden();
    await expect(page.locator('.tabs')).toBeHidden();
    await expect(page.locator('.fab.active')).toHaveCount(1); // follow mode on (location granted)
    await idle(page);
    await shot(page, 'follow');
    await bar.getByRole('button', { name: 'End' }).click();
    await expect(bar).toBeHidden();
    await expect(page.locator('.search .ph')).toHaveText('Where to?');
    await expect(page.locator('.stat-chip')).toBeVisible();
    await expect(page.locator('.tabs')).toBeVisible();
    // The GeoJSON source re-tiles asynchronously after setData([]).
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __unfog: { ctx: { map: { map: { querySourceFeatures(s: string): unknown[] } } } } }).__unfog.ctx.map.map.querySourceFeatures('unfog-routes').length))
      .toBe(0);
    expect(b.errors).toEqual([]);
  });

  test('4. search (Photon stubbed): typing shows suggestions; tapping one opens the route sheet', async ({ page }) => {
    const photonRequests: string[] = [];
    await page.route('https://photon.komoot.io/**', async (route) => {
      photonRequests.push(route.request().url());
      await route.fulfill({ json: PHOTON_FC, headers: { 'access-control-allow-origin': '*' } });
    });
    const b = await boot(page);
    await page.getByRole('button', { name: 'Search destination' }).click();
    const input = page.locator('.search-input');
    await expect(input).toBeFocused();
    await input.fill('Do'); // < 3 chars: no request
    await page.waitForTimeout(500);
    expect(photonRequests).toEqual([]);
    await input.fill('Domino');
    const results = page.locator('.search-list .result');
    await expect(results).toHaveCount(2);
    await expect(results.first()).toContainText('Domino Park');
    await expect(results.first()).toContainText('Williamsburg, Brooklyn, New York');
    await expect(results.nth(1)).toContainText('Domino Sugar Refinery');
    expect(photonRequests.length).toBeGreaterThanOrEqual(1);
    const url = new URL(photonRequests[photonRequests.length - 1]);
    expect(url.searchParams.get('q')).toBe('Domino');
    expect(Number(url.searchParams.get('lat'))).toBeCloseTo(BEDFORD_N7[1], 1); // biased to the map centre
    expect(Number(url.searchParams.get('lon'))).toBeCloseTo(BEDFORD_N7[0], 1);
    await shot(page, 'search-results');
    await results.first().click();
    await expect(page.locator('.search-panel')).toBeHidden();
    const sheet = page.locator('.sheet.route');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('h2')).toContainText('Domino Park');
    await expect(page.locator('.search .val')).toHaveText('Domino Park');
    await waitRouted(page);

    // Photon down → a clear status line, no crash.
    await sheet.getByRole('button', { name: 'Close' }).click();
    await page.unroute('https://photon.komoot.io/**');
    await page.route('https://photon.komoot.io/**', (route) => route.abort('failed'));
    await page.getByRole('button', { name: 'Search destination' }).click();
    await input.fill('Prospect Park');
    await expect(page.locator('.search-status')).toHaveText('Search failed — try again');
    expect(b.errors).toEqual([]);
  });

  test('5. tracking (feedback-2): the Settings switch runs a passive session — moving fixes grow it and cells increase live; off saves it quietly; Data lists it with GPX download', async ({ page, context }) => {
    const b = await boot(page, { share: 'none' });
    const before = await stats(page);
    await context.setGeolocation({ longitude: BEDFORD_N7[0], latitude: BEDFORD_N7[1], accuracy: 5 });
    // The switch lives in Help → Settings with the honest iOS note; the map has no Record button.
    await page.getByRole('tab', { name: 'Help' }).click();
    await page.locator('#help-settings summary').click();
    const sw = page.getByRole('switch', { name: 'Track my movement' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#help-settings')).toContainText('iOS only lets a web app record while it is open and the screen is on');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 }); // flips at once; persists once location is granted
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('unfog.settings') ?? '{}').tracking ?? false), { timeout: 20_000 }).toBe(true);
    await expect(sw).toBeEnabled();
    await shotFb2(page, 'settings');
    // The note's link opens "Always recording" (Fog of World as the background recorder; Overland coming).
    await page.locator('#help-settings').getByRole('button', { name: 'Always recording' }).click();
    await expect(page.locator('#help-always')).toHaveAttribute('open', '');
    await expect(page.locator('#help-always')).toContainText('Fog of World records in the background');
    await expect(page.locator('#help-always')).toContainText('Overland');
    await page.getByRole('tab', { name: 'Map' }).click();

    // The pill is the only trace on the map; the chrome is untouched (no banner, no Stop, no follow hijack).
    const pill = page.locator('.track-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(PILL_ON, { timeout: 20_000 }); // the first fix arrived
    await expect(pill).toHaveClass(/\bon\b/);
    await expect(page.locator('.stat-chip')).toBeVisible();
    await expect(page.locator('.tabs')).toBeVisible();
    await expect(page.locator('.rec-banner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Stop/ })).toHaveCount(0);
    // Along N 7th St towards the river: ~19 m per fix, 8 fixes; the session persists on every fix.
    await walk(context, page, BEDFORD_N7, [-0.0002, 0.00008], 8);
    const s1 = (await session(page))!;
    expect(s1.points.length).toBe(9); // first watch fix + 8 steps
    expect(s1.distanceM).toBeGreaterThanOrEqual(100);
    expect(s1.distanceM).toBeLessThanOrEqual(200);
    // Cells increase live (a checkpoint every ≤ 5 s) — nothing to stop; the stat chip follows.
    await expect.poll(async () => (await stats(page)).visitedCells, { timeout: 15_000, message: 'cells marked by a checkpoint' }).toBeGreaterThan(before.visitedCells + 5);
    await expect(page.locator('.stat-chip .sub')).not.toHaveText('0 cells');
    const mid = await stats(page);
    await walk(context, page, [BEDFORD_N7[0] - 8 * 0.0002, BEDFORD_N7[1] + 8 * 0.00008], [-0.0002, 0.00008], 4);
    await expect.poll(async () => (await stats(page)).visitedCells, { timeout: 15_000, message: 'cells keep increasing as fixes arrive' }).toBeGreaterThan(mid.visitedCells);
    expect((await session(page))!.points.length).toBe(13);
    await idle(page);
    await shot(page, 'tracking');
    await shotFb2(page, 'tracking-pill');
    // Routing is not blocked by a running session.
    await openRoute(page, DOMINO_PARK);
    await waitRouted(page);
    await expect(pill).toBeVisible();
    await page.locator('.sheet.route').getByRole('button', { name: 'Close' }).click();

    // Off: the switch saves the session — no summary sheet, no dialog — and the pill goes.
    await setTracking(page, false);
    await expect(pill).toBeHidden();
    await expect(page.locator('.record-summary')).toHaveCount(0);
    await expect(page.locator('.sheet.modal')).toHaveCount(0);
    expect(await session(page)).toBeNull();
    await expect(page.locator('.toast', { hasText: 'Tracking off' })).toBeVisible();
    // Fixes after Off change nothing (a checkpoint would have run within 5 s).
    const after = await stats(page);
    await walk(context, page, [BEDFORD_N7[0] - 12 * 0.0002, BEDFORD_N7[1] + 12 * 0.00008], [-0.0002, 0.00008], 3);
    await page.waitForTimeout(6000);
    expect((await stats(page)).visitedCells).toBe(after.visitedCells);
    expect(await session(page)).toBeNull();

    // The store has the cells and the session; the Data tab lists it with GPX export + delete.
    expect(after.visitedCells).toBeGreaterThan(before.visitedCells + 5);
    const sessions = await listSessions(page);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].points).toBe(13);
    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.locator('#screen-data')).toContainText('Sessions');
    await expect(page.locator('#screen-data')).not.toContainText(/\bRecord\b/);
    const row = page.locator('#screen-data .row-item', { hasText: 'GPS points' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/^Tracked /);
    await expect(row).toContainText('13 GPS points');
    await shot(page, 'data-session');
    // Export GPX (no navigator.share here → <a download>).
    const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: 'Export GPX' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^unfog-\d{4}-\d{2}-\d{2}-\d{4}\.gpx$/);
    const gpx = fs.readFileSync((await download.path())!, 'utf8');
    expect(gpx).toMatch(/^<\?xml/);
    expect(gpx).toContain('<gpx version="1.1" creator="Unfog"');
    expect((gpx.match(/<trkpt /g) ?? []).length).toBe(13);
    expect((gpx.match(/<time>/g) ?? []).length).toBe(14); // metadata + every point
    await expect(page.locator('.toast.success')).toContainText('GPX downloaded');
    await page.getByRole('tab', { name: 'Stats' }).click();
    await expect(page.locator('#screen-stats')).toContainText('Tracked sessions');
    await expect(page.locator('#screen-stats .stat', { hasText: 'tracked sessions' }).locator('.v')).toHaveText('1');
    // Delete the session: the row goes, the cells stay.
    await page.getByRole('tab', { name: 'Data' }).click();
    await row.getByRole('button', { name: 'Delete session' }).click();
    await page.locator('.sheet.modal').getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('#screen-data .row-item', { hasText: 'GPS points' })).toHaveCount(0);
    expect((await stats(page)).visitedCells).toBe(after.visitedCells);
    expect(b.errors).toEqual([]);
  });

  test('6. backup round-trip: export (share sheet) → delete all → import the backup restores 36,983 cells', async ({ page }) => {
    const b = await boot(page, { share: 'capture' });
    await importFiles(page, FOW_FILES);
    await expect(page.locator('#screen-data')).toContainText('No backup yet');

    // Dismissing the iOS share sheet (AbortError) is not a backup: no date recorded, no success toast.
    await page.evaluate(() => {
      const captured = navigator.share;
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw new DOMException('The user cancelled', 'AbortError'); } });
      (window as unknown as { __restoreShare: () => void }).__restoreShare = () => Object.defineProperty(navigator, 'share', { configurable: true, value: captured });
    });
    await page.getByRole('button', { name: 'Export backup' }).click();
    await expect(page.locator('.toast', { hasText: 'Backup cancelled' })).toBeVisible();
    await expect(page.locator('#screen-data')).toContainText('No backup yet');
    expect(await page.evaluate(() => localStorage.getItem('unfog.lastBackup'))).toBeNull();
    await page.evaluate(() => (window as unknown as { __restoreShare: () => void }).__restoreShare());

    await page.getByRole('button', { name: 'Export backup' }).click();
    await page.waitForFunction(() => ((window as unknown as UnfogWindow).__shared?.length ?? 0) > 0, null, { timeout: 30_000 });
    const shared = await page.evaluate(() => (window as unknown as UnfogWindow).__shared!);
    expect(shared).toHaveLength(1);
    expect(shared[0].name).toMatch(/^unfog-backup-\d{8}\.zip$/);
    expect(shared[0].type).toBe('application/zip');
    const bytes = Buffer.from(shared[0].b64, 'base64');
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(bytes.length).toBeGreaterThan(1000);
    await expect(page.locator('.toast.success', { hasText: 'Backup shared' })).toBeVisible();
    await expect(page.locator('#screen-data')).toContainText('Last backup today');
    const backupPath = tmpFile(shared[0].name);
    fs.writeFileSync(backupPath, bytes);

    // Delete everything through the confirm sheet.
    await page.getByRole('button', { name: 'Delete all data' }).click();
    const modal = page.locator('.sheet.modal');
    await expect(modal).toContainText('Delete everything?');
    await modal.getByRole('button', { name: 'Cancel' }).click();
    expect((await stats(page)).visitedCells).toBe(FOW_CELLS); // cancel keeps the data
    await page.getByRole('button', { name: 'Delete all data' }).click();
    await modal.getByRole('button', { name: 'Delete all' }).click();
    await expect(page.locator('.toast', { hasText: 'All data deleted' })).toBeVisible();
    await expect.poll(async () => (await stats(page)).visitedCells).toBe(0);
    await page.getByRole('tab', { name: 'Map' }).click();
    await expect(page.locator('.stat-chip .sub')).toHaveText('0 cells');
    await expect(page.locator('.hint')).toBeVisible(); // empty again

    // Restore from the backup file through the same picker.
    const summary = await importFiles(page, [backupPath]);
    expect(summary).toMatch(/^36,983 new cells/);
    await expect(page.locator('#screen-data .import-result li')).toContainText('backup restored (36,983 cells total)');
    const s = await stats(page);
    expect(s.visitedCells).toBe(FOW_CELLS);
    await page.getByRole('tab', { name: 'Map' }).click();
    await expect(page.locator('.stat-chip .sub')).toHaveText('36,983 cells');
    await expect(page.locator('.hint')).toBeHidden();
    expect(b.errors).toEqual([]);
  });

  test('7. settings: feather/halo bump the overlay, dark basemap swaps the style, imperial units', async ({ page }) => {
    const b = await boot(page);
    await importFiles(page, FOW_FILES);
    const tilesUrl = () => page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.getSource('unfog-overlay')?.tiles?.[0]);
    const v0 = await tilesUrl();
    expect(v0).toMatch(/^fog:\/\/.*\?v=\d+$/);

    await page.getByRole('tab', { name: 'Help' }).click();
    const settings = page.locator('.help-section', { has: page.locator('summary', { hasText: /^Settings$/ }) });
    await settings.locator('summary').click();
    await expect(settings.locator('.settings')).toBeVisible();
    await settings.getByLabel('Fog softness').fill('3');
    await expect(settings.locator('.setting', { hasText: 'Fog softness' })).toContainText('25%'); // 3 cells on the 2–6 range
    // RasterTileSource.setTiles applies asynchronously → poll.
    await expect.poll(tilesUrl).not.toBe(v0);
    const v1 = await tilesUrl();
    await settings.getByLabel('Reveal (halo)').fill('0.3');
    await expect(settings.locator('.setting', { hasText: 'Reveal' })).toContainText('30%');
    await expect.poll(tilesUrl).not.toBe(v1);
    const v2 = await tilesUrl();
    await settings.locator('.seg', { hasText: 'Tight' }).getByRole('button', { name: 'Tight' }).click();
    await expect.poll(tilesUrl).not.toBe(v2);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('unfog.settings') ?? '{}'))).toMatchObject({ feather: 3, halo: 0.3, coreRadius: 0 });

    // Dark basemap: the night style (OpenFreeMap fiord) is requested, the chrome flips to dark and
    // the overlay tiles get a new URL (night render settings; no cached daytime tile survives).
    const v3 = await tilesUrl();
    const darkReq = page.waitForRequest((r) => r.url().startsWith('https://tiles.openfreemap.org/styles/fiord'), { timeout: 15_000 });
    await settings.getByRole('group', { name: 'Basemap' }).getByRole('button', { name: 'Dark' }).click();
    await darkReq;
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#17181d');
    await expect.poll(async () => { const u = await tilesUrl(); return Boolean(u) && u !== v3; }, { timeout: 30_000 }).toBe(true);
    // Overlay + route layers are re-added after the style swap.
    await page.waitForFunction(() => {
      const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
      return Boolean(map.getLayer('unfog-overlay')) && Boolean(map.getSource('unfog-routes'));
    }, null, { timeout: 30_000 }).catch(() => undefined);
    const dark = await page.evaluate(() => {
      const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
      return { overlay: Boolean(map.getLayer('unfog-overlay')), routes: Boolean(map.getSource('unfog-routes')), tiles: map.getSource('unfog-overlay')?.tiles?.[0] };
    });
    test.info().annotations.push({ type: 'dark-style', description: JSON.stringify(dark) });

    // Imperial: the stat chip shows mi².
    await settings.getByRole('group', { name: 'Units' }).getByRole('button', { name: 'miles' }).click();
    await page.getByRole('tab', { name: 'Map' }).click();
    await expect(page.locator('.stat-chip .val')).toHaveText(/mi²$/);
    await idle(page);
    await shot(page, 'settings-dark-imperial');
    // Survives a reload.
    await page.reload();
    await waitReady(page);
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.locator('.stat-chip .val')).toHaveText(/mi²$/);
    expect(b.errors).toEqual([]);
  });

  test('8. install card: iOS Safari (not standalone) shows it; Dismiss persists across reloads', async ({ page }) => {
    await boot(page, { installCard: true, init: () => Object.defineProperty(navigator, 'standalone', { configurable: true, value: false }) });
    const card = page.locator('.install-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Add to Home Screen');
    await expect(page.locator('.stat-chip')).toBeVisible();
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(card).toBeHidden();
    await page.reload();
    await waitReady(page);
    await expect(page.locator('.install-card')).toHaveCount(0);
    const dismissedAt = await page.evaluate(() => Number(localStorage.getItem('unfog.installDismissed')));
    expect(Date.now() - dismissedAt).toBeLessThan(120_000);
  });

  test('8b. install card is hidden in a standalone (Home Screen) app', async ({ page }) => {
    await boot(page, { installCard: true, init: () => Object.defineProperty(navigator, 'standalone', { configurable: true, value: true }) });
    await expect(page.locator('.install-card')).toHaveCount(0);
  });

  test('10. relaunch while tracking (feedback-2): no dialog — the previous session is saved as a track and a new one runs; midnight rollover splits the same way; off saves', async ({ page, context }) => {
    const b = await boot(page);
    await context.setGeolocation({ longitude: BEDFORD_N7[0], latitude: BEDFORD_N7[1], accuracy: 5 });
    await setTracking(page, true);
    const pill = page.locator('.track-pill');
    await expect(pill).toHaveText(PILL_ON, { timeout: 20_000 });
    await walk(context, page, BEDFORD_N7, [-0.0002, 0.00008], 5);
    const persisted = (await session(page))!;
    expect(persisted.points.length).toBe(6);

    // "Process death": a reload. The switch is on, so tracking comes back by itself — no sheet,
    // no Resume/Finish/Discard; what was persisted becomes a track, a fresh session runs.
    await page.reload();
    await waitReady(page);
    await expect(page.locator('.sheet.modal')).toHaveCount(0);
    await expect(pill).toHaveText(PILL_ON, { timeout: 20_000 });
    await shot(page, 'relaunch');
    const fresh = (await session(page))!;
    expect(fresh.id, 'a new session after the relaunch').not.toBe(persisted.id);
    let sessions = await listSessions(page);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(persisted.id);
    expect(sessions[0].points).toBe(6);
    expect((await stats(page)).visitedCells).toBeGreaterThan(5);

    // Keep moving: the new session grows.
    await walk(context, page, [BEDFORD_N7[0] - 5 * 0.0002, BEDFORD_N7[1] + 5 * 0.00008], [-0.0002, 0.00008], 3);
    expect((await session(page))!.points.length).toBeGreaterThanOrEqual(4);

    // Midnight rollover (the same path the 60 s timer takes, driven directly): the running
    // session is saved, another starts, the pill never blinks out of "Tracking".
    await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.tracking.rollover());
    await expect(pill).toHaveText(PILL_ON, { timeout: 20_000 });
    const third = (await session(page))!;
    expect(third.id).not.toBe(fresh.id);
    sessions = await listSessions(page);
    expect(sessions.map((s) => s.id).sort()).toEqual([persisted.id, fresh.id].sort());
    await walk(context, page, [BEDFORD_N7[0] - 8 * 0.0002, BEDFORD_N7[1] + 8 * 0.00008], [-0.0002, 0.00008], 3);

    // Off: the third session is saved too, quietly; nothing is left to resume.
    await setTracking(page, false);
    await expect(pill).toBeHidden();
    expect(await session(page)).toBeNull();
    sessions = await listSessions(page);
    expect(sessions.map((s) => s.id).sort()).toEqual([persisted.id, fresh.id, third.id].sort());
    await page.reload();
    await waitReady(page);
    await expect(page.locator('.sheet.modal')).toHaveCount(0);
    await expect(pill).toBeHidden();
    expect(await session(page)).toBeNull();
    expect((await listSessions(page)).length).toBe(3);
    expect(b.errors).toEqual([]);
  });

  test('11. boots on the fallback style when the basemap host is unreachable; recovers when online', async ({ page }) => {
    let blocked = true;
    await page.route('https://tiles.openfreemap.org/**', (route) => (blocked ? route.abort('failed') : route.continue()));
    const b = await boot(page, { readyTimeout: 60_000 });
    // getStyle() is undefined for a moment while setStyle swaps the fallback for the real style (the poll below spans it).
    const styleName = () => page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.getStyle()?.name);
    expect(await styleName()).toBe('unfog-fallback');
    await importFiles(page, FOW_FILES);
    await page.getByRole('tab', { name: 'Map' }).click();
    const state = await page.evaluate(() => {
      const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
      return { overlay: Boolean(map.getLayer('unfog-overlay')), tiles: map.getSource('unfog-overlay')?.tiles?.[0], routes: Boolean(map.getSource('unfog-routes')) };
    });
    expect(state.overlay, 'fog overlay layer exists without a basemap').toBe(true);
    expect(state.routes, 'route layers exist without a basemap').toBe(true);
    await expect(page.locator('.stat-chip .sub')).toHaveText('36,983 cells');
    await openRoute(page, DOMINO_PARK);
    await waitRouted(page);
    await idle(page);
    await shot(page, 'no-basemap');
    await page.locator('.sheet.route').getByRole('button', { name: 'Close' }).click();

    // Connectivity returns: the real style is fetched again and replaces the fallback.
    blocked = false;
    const styleReq = page.waitForRequest((r) => r.url().startsWith('https://tiles.openfreemap.org/styles/bright'), { timeout: 15_000 });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await styleReq;
    await expect.poll(styleName, { timeout: 30_000 }).not.toBe('unfog-fallback');
    await page.waitForFunction(() => Boolean((window as unknown as UnfogWindow).__unfog!.ctx!.map.map.getLayer('unfog-overlay')), null, { timeout: 30_000 });
    expect(b.errors).toEqual([]);
  });

  test('12. loop mode on the real NYC graph: 3 km from Bedford & N 7th → 1–3 loops within ±25 %, drawn above the sheet; chips, slider, Go/End', async ({ page }) => {
    const b = await boot(page);
    // Entry point: the search panel's "Explore a loop from here" row.
    await page.getByRole('button', { name: 'Search destination' }).click();
    await page.getByRole('option', { name: /Explore a loop from here/ }).click();
    await expect(page.locator('.search-panel')).toBeHidden();
    const sheet = page.locator('.sheet.route.loop');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-kind', 'loop');
    await expect(sheet.locator('h2')).toContainText('Explore from here');
    await expect(sheet.locator('.chips button.on')).toHaveText('3 km');
    await expect(sheet.locator('.modes')).toHaveCount(0); // feedback-2: one mode, no chips
    await expect(sheet.locator('.sheet-note')).toHaveText('Round trips on streets and paths, timed at walking pace.');
    await expect(page.locator('.search .val')).toHaveText('Loop from here');
    const loops = await waitRouted(page);
    test.info().annotations.push({ type: 'loops-3km-walk', description: loops.map((c) => `${c.name} ${c.lengthM} m ${c.pctNew}% new ${c.etaMin} min`).join(' | ') });
    expect(loops.length).toBeGreaterThanOrEqual(1);
    expect(loops.length).toBeLessThanOrEqual(3);
    loops.forEach((c, i) => {
      expect(c.name).toBe(`Loop ${'ABC'[i]}`);
      expect(c.lengthM, `${c.name} within ±25 % of 3 km`).toBeGreaterThanOrEqual(2250);
      expect(c.lengthM, `${c.name} within ±25 % of 3 km`).toBeLessThanOrEqual(3750);
      expect(c.pctNew, `${c.name} is mostly new on an empty store`).toBeGreaterThan(50);
      expect(c.etaMin).toBeGreaterThan(20); // 4.8 km/h
    });
    expect(loops[0].selected).toBe(true);
    await expect(sheet.locator('h2 small')).toHaveText(`${loops.length} loop${loops.length === 1 ? '' : 's'} of about 3 km`);
    await expect(sheet.locator('.route-status')).not.toContainText('map centre'); // started from the user's position
    // Closed rings that start near the origin; drawn on the map, fitted above the sheet.
    const ring = await page.evaluate(async (req) => {
      const r = await (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.loop(req);
      const d = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * 84_300, (a[1] - b[1]) * 111_000);
      return {
        coords: r.candidates.flatMap((c) => c.coords),
        closes: r.candidates.map((c) => d(c.coords[0], c.coords[c.coords.length - 1])),
        startsNear: r.candidates.map((c) => d(c.coords[0], req.from)),
      };
    }, { from: BEDFORD_N7, mode: 'walk', targetKm: 3 });
    for (const m of ring.closes) expect(m).toBeLessThan(30);
    for (const m of ring.startsNear) expect(m).toBeLessThan(300);
    const routeFeatures = await page.evaluate(() => (window as unknown as { __unfog: { ctx: { map: { map: { querySourceFeatures(s: string): unknown[] } } } } }).__unfog.ctx.map.map.querySourceFeatures('unfog-routes').length);
    expect(routeFeatures).toBeGreaterThan(0);
    await expectLinesAboveSheet(page, ring.coords);
    await shot(page, 'loop');
    await shotFb2(page, 'loop-sheet');

    // 5 km chip → every loop within ±25 % of 5 km; the choice persists.
    await sheet.getByRole('button', { name: '5 km' }).click();
    await expect(sheet.locator('.chips button.on')).toHaveText('5 km');
    await expect(sheet.getByLabel('Loop length', { exact: true })).toHaveValue('5');
    const inRange = (lo: number, hi: number) => async () => {
      const rows = await readCands(page).catch(() => [] as CandRow[]);
      return rows.length > 0 && rows.every((c) => c.lengthM >= lo && c.lengthM <= hi);
    };
    await expect.poll(inRange(3750, 6250), { timeout: 60_000 }).toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('unfog.routePrefs') ?? '{}'))).toMatchObject({ loopKm: 5 });
    // Slider → 2 km (the chip lights up).
    await sheet.getByLabel('Loop length', { exact: true }).fill('2');
    await expect(sheet.locator('.slider-loop')).toContainText('2 km');
    await expect(sheet.locator('.chips button.on')).toHaveText('2 km');
    await expect.poll(inRange(1500, 2500), { timeout: 60_000 }).toBe(true);
    const walk2 = await readCands(page);
    expect(walk2[0].etaMin, 'walking pace').toBeGreaterThanOrEqual(Math.floor((walk2[0].lengthM / 1000 / 4.8) * 60));
    await shot(page, 'loop-2km');

    // Go → follow bar names the loop; End restores the chrome and clears the lines.
    await sheet.getByRole('button', { name: 'Go' }).click();
    const bar = page.locator('.follow-bar');
    await expect(bar).toBeVisible();
    await expect(sheet).toBeHidden();
    await expect(bar).toContainText('Loop A');
    await expect(bar).toContainText('round trip from here');
    await expect(page.locator('.fab.active')).toHaveCount(1);
    await bar.getByRole('button', { name: 'End' }).click();
    await expect(bar).toBeHidden();
    await expect(page.locator('.search .ph')).toHaveText('Where to?');
    await expect(page.locator('.stat-chip')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __unfog: { ctx: { map: { map: { querySourceFeatures(s: string): unknown[] } } } } }).__unfog.ctx.map.map.querySourceFeatures('unfog-routes').length))
      .toBe(0);
    expect(b.errors).toEqual([]);
  });

  test('12b. a pin off the network is not an error: the route ends with an off-path leg (feedback-1 item 2)', async ({ page }) => {
    const b = await boot(page);
    // A pin mid-East River (≈450 m from Kent Av and from the FDR greenway): used to be "no street
    // within 300 m" and an empty sheet; now the nearest street is snapped at any distance and the
    // last leg is the straight walk from the street to the pin (tests/e2e/fb1.spec.ts covers the
    // note, the dashed part and the no-coverage "Route anyway").
    await openRoute(page, { name: 'East River', lonlat: [-73.97, 40.7205] });
    const sheet = page.locator('.sheet.route');
    const status = sheet.locator('.route-status');
    const cands = await waitRouted(page);
    expect(cands[cands.length - 1].name).toBe('Direct');
    await expect(status.locator('.error')).toHaveCount(0);
    await expect(status).toContainText(/off-path/);
    await expect(sheet.getByRole('button', { name: 'Go' })).toBeEnabled();
    await shot(page, 'route-error');
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
    expect(b.errors).toEqual([]);
  });

  test('13. night mode: fiord basemap, navy fog with lit visited streets; heat legend and routes still read', async ({ page }) => {
    const b = await boot(page);
    const tracks = williamsburgWalks();
    await page.evaluate(async (tracks) => {
      const ctx = (window as unknown as UnfogWindow).__unfog!.ctx!;
      const r = await ctx.engines.grid.applyPayload({ tracks, meta: { source: 'gpx', fileName: 'walks', items: tracks.length } });
      await ctx.engines.route.invalidateCells(r.stats.version);
      await ctx.dataChanged();
    }, tracks);
    expect((await stats(page)).visitedCells).toBeGreaterThan(3000);
    const tilesUrl = () => page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.getSource('unfog-overlay')?.tiles?.[0]);
    const jumpHome = () => page.evaluate((c) => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.jumpTo({ center: c, zoom: 15.3 }), BEDFORD_N7);

    // Daylight reference: the same strip of map, sampled on a grid.
    await jumpHome();
    await tilesSettled(page);
    const dayUrl = await tilesUrl();
    expect(dayUrl).toMatch(/^fog:\/\/.*\?v=\d+$/);
    const day = await lumaGrid(page);
    const dayMin = Math.min(...day), dayMax = Math.max(...day);

    // Settings → Dark map: the night style is requested and the overlay tiles get a new URL.
    await page.getByRole('tab', { name: 'Help' }).click();
    const settings = page.locator('.help-section', { has: page.locator('summary', { hasText: /^Settings$/ }) });
    await settings.locator('summary').click();
    const styleReq = page.waitForRequest((r) => r.url().startsWith('https://tiles.openfreemap.org/styles/fiord'), { timeout: 15_000 });
    await settings.getByRole('group', { name: 'Basemap' }).getByRole('button', { name: 'Dark' }).click();
    await styleReq;
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('tab', { name: 'Map' }).click();
    await page.waitForFunction(() => {
      const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
      return Boolean(map.getLayer('unfog-overlay')) && Boolean(map.getSource('unfog-routes'));
    }, null, { timeout: 30_000 });
    await expect.poll(async () => { const u = await tilesUrl(); return Boolean(u) && u !== dayUrl; }, { timeout: 30_000 }).toBe(true);
    const nightUrl = await tilesUrl();
    expect(nightUrl).toMatch(/^fog:\/\/.*\?v=\d+$/);
    // The fog is above the buildings and roads, below the labels.
    const order = await page.evaluate(() => {
      const ids = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.getStyle().layers.map((l) => l.id);
      return { overlay: ids.indexOf('unfog-overlay'), building: ids.indexOf('building'), roads: ids.indexOf('highway_minor'), labels: ids.indexOf('highway_name_other') };
    });
    expect(order.overlay, JSON.stringify(order)).toBeGreaterThan(order.building);
    expect(order.overlay, JSON.stringify(order)).toBeGreaterThan(order.roads);
    expect(order.overlay, JSON.stringify(order)).toBeLessThan(order.labels);

    // Night: the unknown is darker than by day, the walked streets are lit, and it is still a dark map.
    await jumpHome();
    await tilesSettled(page);
    const night = await lumaGrid(page);
    const nightMin = Math.min(...night), nightMax = Math.max(...night);
    const desc = `day ${dayMin.toFixed(0)}–${dayMax.toFixed(0)}, night ${nightMin.toFixed(0)}–${nightMax.toFixed(0)}`;
    test.info().annotations.push({ type: 'luma', description: desc });
    expect(nightMin, `the unknown is darker at night (${desc})`).toBeLessThan(dayMin - 15);
    expect(nightMax - nightMin, `lit streets stand out from the fog (${desc})`).toBeGreaterThanOrEqual(60);
    expect(nightMax, `lit streets are light, not a hole (${desc})`).toBeGreaterThanOrEqual(90);
    expect(nightMax, `still a dark map: dimmer than daylight (${desc})`).toBeLessThan(dayMax - 40);
    await shot(page, 'night-fog');

    // Heat: the ramp sits on the navy dim layer; the legend shows.
    await page.locator('.seg button[data-layer="heat"]').click();
    await expect(page.locator('.legend')).toBeVisible();
    await expect(page.locator('.legend i')).toHaveCount(4);
    await tilesSettled(page);
    await shot(page, 'night-heat');
    await page.locator('.seg button[data-layer="fog"]').click();

    // Routes keep their daytime paint on the navy ground.
    await openRoute(page, { ...DOMINO_PARK, origin: BEDFORD_N7 });
    const cands = await waitRouted(page);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    await tilesSettled(page);
    await shot(page, 'night-route');
    await page.getByRole('button', { name: 'Clear destination' }).click();
    await expect(page.locator('.sheet.route')).toBeHidden();

    expect(b.errors).toEqual([]);
    expect(b.consoleErrors.filter((e) => /overlay|renderTile|grid|worker/i.test(e))).toEqual([]);
  });
});

// ================================================================ offline (production build + service worker)

const PREVIEW_URL = process.env.PW_PREVIEW_URL ?? 'http://localhost:4174/unfog/';

function reachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 400);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

test.describe('Unfog offline (vite preview + service worker)', () => {
  test.use({ baseURL: PREVIEW_URL });
  test.beforeEach(async () => {
    test.skip(!(await reachable(PREVIEW_URL)), `preview server not running at ${PREVIEW_URL} (PW_NO_PREVIEW set?)`);
  });

  async function waitControlled(page: Page): Promise<void> {
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 60_000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
  }

  test('9. offline: reload boots from the precache, data persists, cached graph routes; region download prefills the cache', async ({ page, context }) => {
    const b = await boot(page, { readyTimeout: 120_000 });
    await waitControlled(page);
    // Second online load so the basemap style + tiles go through the (now controlling) worker's runtime cache.
    await page.reload();
    await waitReady(page, 120_000);
    await waitControlled(page);
    await importFiles(page, FOW_FILES);
    await page.getByRole('tab', { name: 'Map' }).click();
    await openRoute(page, DOMINO_PARK);
    await waitRouted(page);
    await page.locator('.sheet.route').getByRole('button', { name: 'Close' }).click();
    const cachedAfterRoute = await page.evaluate(async () => (await (await caches.open('graph')).keys()).map((r) => new URL(r.url).pathname));
    test.info().annotations.push({ type: 'graph-cache-after-route', description: `${cachedAfterRoute.length} entries: ${cachedAfterRoute.slice(0, 5).join(', ')}` });
    const precache = await page.evaluate(async () => (await caches.keys()).join(', '));
    test.info().annotations.push({ type: 'caches', description: precache });

    await context.setOffline(true);
    await page.reload();
    await waitReady(page, 120_000);
    await expect(page.locator('.stat-chip .sub')).toHaveText('36,983 cells');
    expect((await stats(page)).visitedCells).toBe(FOW_CELLS);
    await shot(page, 'offline-boot');
    // Route over tiles fetched while online: served from the 'graph' runtime cache.
    await openRoute(page, DOMINO_PARK);
    const offlineCands = await waitRouted(page);
    expect(offlineCands[offlineCands.length - 1].name).toBe('Direct');
    await page.locator('.sheet.route').getByRole('button', { name: 'Close' }).click();
    // Jamaica, Queens sits in a z12 graph tile (1207/1539) that was never fetched → no coverage
    // offline: the sheet offers the downloads instead of a route (and no spinner is left hanging).
    await openRoute(page, JAMAICA);
    const status = page.locator('.sheet.route .route-status');
    await expect(status.locator('.spinner')).toBeHidden({ timeout: 60_000 });
    await expect(status).toContainText('No routing data for this area yet');
    await expect(status.getByRole('button', { name: /Download New York City/ })).toBeVisible();
    await expect(status.getByRole('button', { name: /Download this area/ })).toBeVisible();
    // Offline, the download fails with a message rather than a stuck progress bar.
    await status.getByRole('button', { name: /Download New York City/ }).click();
    await expect(status).toContainText(/Download failed/, { timeout: 60_000 });
    await shot(page, 'offline-no-coverage');
    await page.locator('.sheet.route').getByRole('button', { name: 'Close' }).click();

    // Back online: Download New York City, then offline again → the Jamaica route computes.
    await context.setOffline(false);
    await page.getByRole('tab', { name: 'Data' }).click();
    const nyc = page.locator('#screen-data .row-item', { hasText: 'New York City' });
    await expect(nyc).toBeVisible();
    await nyc.getByRole('button', { name: 'Download' }).click();
    await expect(page.locator('.toast', { hasText: 'ready for offline routing' })).toBeVisible({ timeout: 120_000 });
    await expect(nyc).toContainText('Offline since');
    await expect(nyc).toContainText(/\d+(\.\d+)? MB/); // size, not the internal tile count
    await expect(nyc.getByRole('button', { name: 'Update' })).toBeVisible();
    const cachedAfterDownload = await page.evaluate(async () => (await (await caches.open('graph')).keys()).length);
    expect(cachedAfterDownload).toBeGreaterThanOrEqual(67);
    await shot(page, 'offline-region');
    await context.setOffline(true);
    await page.reload();
    await waitReady(page, 120_000);
    await openRoute(page, JAMAICA);
    const pp = await waitRouted(page);
    expect(pp[pp.length - 1].name).toBe('Direct');
    expect(pp[pp.length - 1].lengthM).toBeGreaterThan(1000);
    await shot(page, 'offline-route');
    expect(b.errors).toEqual([]);
  });
});
