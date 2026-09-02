/**
 * Flows nobody had exercised end to end (QA flows-2):
 *
 *   A. "Download this area" — the worldwide path outside the prebuilt regions: the route sheet
 *      offers the download, Overpass → graph tiles → IndexedDB `unfog-graph`, routes compute,
 *      the area is listed on Data, survives a reload, can be deleted. Hermetic by default: the
 *      Overpass POST is answered from tests/fixtures/osm/nelson-3km.json.gz (the exact response
 *      for the query the app sends). One extra test goes to the REAL overpass-api.de and skips
 *      itself when the server does not answer (it was returning 504 "too busy" while this was
 *      written).
 *   B. Service-worker update — a v1 build is served by a tiny static server in this file, a v2
 *      build (different `UNFOG_BUILD` stamp, see vite.config.ts) is swapped in, and the update
 *      must show "Update available — Reload" without reloading on its own (a recording in
 *      progress keeps going), then Reload lands on v2 with a clean precache.
 *   C. A 5 MB Apple-Health-style GPX set imported while OFFLINE through the Data screen
 *      (production build + service worker on the preview server, like real.spec's offline block).
 *
 * Helpers mirror tests/e2e/real.spec.ts (kept local so the two specs can change independently).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const here = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(here, '..', '..');
const shots = path.join(here, 'screenshots');
const FIXTURES = path.join(here, '..', 'fixtures');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `flows-${name}.png`), fullPage: false });

// ---------------------------------------------------------------- Nelson, BC (no prebuilt region)

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** Stanley St & Victoria St, uphill residential — the user's position. */
const NELSON_HOME: [number, number] = [-117.2964, 49.4927];
/** Mill Street, ~1 km east: a route the sheet should find after the download. */
const NELSON_DEST = { name: 'Mill Street', locality: 'Nelson, BC', lonlat: [-117.2831, 49.492] as [number, number] };
const NELSON_FIXTURE = path.join(FIXTURES, 'osm', 'nelson-3km.json.gz');
let nelsonJson: string | null = null;
const nelsonBody = () => (nelsonJson ??= zlib.gunzipSync(fs.readFileSync(NELSON_FIXTURE)).toString('utf8'));
/** What overpass-api.de sends when its dispatcher is saturated (seen 2026-09-02): HTTP 504 with an XHTML page. */
const OVERPASS_504 = `<?xml version="1.0" encoding="UTF-8"?><html><body><p>Error: runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to handle your request.</p></body></html>`;

// ---------------------------------------------------------------- page-side types

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
interface AreaRecord {
  id: string;
  center: [number, number];
  radiusKm: number;
  tiles: number;
  bytes: number;
  builtAt: string;
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
          markTrack(t: { id: string; source: string; name?: string; points: Array<[number, number, number?]> }): Promise<unknown>;
          listTracks(): Promise<Array<{ id: string; source: string; name?: string; points: number; lengthM: number }>>;
        };
        route: {
          route(req: { from: [number, number]; to: [number, number]; mode: string; detour: number }): Promise<{ candidates: RouteCandidate[]; shortestM: number }>;
          coverage(bbox: [number, number, number, number]): Promise<{ needed: number; available: number; regions: string[] }>;
          listDownloads(): Promise<AreaRecord[]>;
          downloadArea(center: [number, number], radiusKm: number): Promise<{ tiles: number; bytes: number }>;
        };
      };
      dataChanged(): Promise<void>;
      map: {
        map: {
          loaded(): boolean;
          isMoving(): boolean;
          once(ev: 'idle', cb: () => void): unknown;
          jumpTo(o: { center: [number, number]; zoom: number }): unknown;
        };
      };
    };
  };
  __shared?: Array<{ name: string; type: string; b64: string }>;
  __toasts?: string[];
  __swEvents?: string[];
  __marker?: number;
};

// ---------------------------------------------------------------- helpers

interface BootOptions {
  share?: 'capture' | 'none';
  init?: () => void;
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
  await page.addInitScript(() => {
    localStorage.setItem('unfog.installDismissed', String(Date.now()));
    // Every toast text, in order (toasts fade after 3.5 s; the log outlives them).
    const w = window as unknown as UnfogWindow;
    w.__toasts = [];
    const seen = new WeakSet<Element>();
    new MutationObserver(() => {
      for (const t of document.querySelectorAll('.toast')) {
        if (seen.has(t)) continue;
        seen.add(t);
        w.__toasts!.push(t.querySelector('.toast-text')?.textContent ?? t.textContent ?? '');
      }
    }).observe(document, { childList: true, subtree: true }); // init scripts run before <html> exists
  });
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

async function waitReady(page: Page, timeout = 90_000): Promise<void> {
  await page.waitForFunction(() => (window as unknown as UnfogWindow).__unfog?.ready === true, null, { timeout });
  const mock = await page.evaluate(() => (window as unknown as UnfogWindow).__unfog?.mock);
  expect(mock, 'real engines (not mock mode)').toBe(false);
}

async function boot(page: Page, opts: BootOptions = {}): Promise<Booted> {
  const b = await prepare(page, opts);
  await page.goto('');
  await waitReady(page, opts.readyTimeout);
  expect(b.errors, 'no uncaught page errors during boot').toEqual([]);
  return b;
}

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
const toasts = (page: Page) => page.evaluate(() => (window as unknown as UnfogWindow).__toasts ?? []);

/** "850 m" / "1.3 km" / "0.5 mi" / "300 ft" → metres. */
function parseDistanceM(text: string): number {
  const m = /([\d.,]+)\s*(km|m|mi|ft)\b/.exec(text);
  if (!m) throw new Error(`no distance in "${text}"`);
  const v = Number(m[1].replace(/,/g, ''));
  return m[2] === 'km' ? v * 1000 : m[2] === 'mi' ? v * 1609.344 : m[2] === 'ft' ? v * 0.3048 : v;
}

/** "277 KB" / "1.2 MB" → bytes (src/app/format.ts fmtBytes). */
function parseBytes(text: string): number {
  const m = /([\d.,]+)\s*(B|KB|MB|GB)\b/.exec(text);
  if (!m) throw new Error(`no size in "${text}"`);
  const v = Number(m[1].replace(/,/g, ''));
  return m[2] === 'GB' ? v * 1e9 : m[2] === 'MB' ? v * 1e6 : m[2] === 'KB' ? v * 1e3 : v;
}

interface CandRow {
  name: string;
  lengthM: number;
  pctNew: number;
  newM: number;
  selected: boolean;
}

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

/** Wait for a (re)route to finish: the spinner is gone and at least one candidate row is there. */
async function waitRouted(page: Page, timeout = 60_000): Promise<CandRow[]> {
  const sheet = page.locator('.sheet.route');
  await expect(sheet.locator('.route-status .spinner')).toBeHidden({ timeout });
  await expect(sheet.locator('.route-status .error')).toHaveCount(0);
  await expect(sheet.locator('.cand').first()).toBeVisible({ timeout });
  return readCands(page);
}

/** The route sheet's "No routing data" offer with its area button. */
async function waitOffer(page: Page, timeout = 60_000): Promise<{ status: ReturnType<Page['locator']>; areaBtn: ReturnType<Page['locator']> }> {
  const status = page.locator('.sheet.route .route-status');
  await expect(status.locator('.spinner')).toBeHidden({ timeout });
  await expect(status).toContainText('No routing data for this area yet', { timeout });
  const areaBtn = status.getByRole('button', { name: /Download this area/ });
  await expect(areaBtn).toBeVisible();
  return { status, areaBtn };
}

async function walk(context: BrowserContext, page: Page, from: [number, number], step: [number, number], n: number, everyMs = 300): Promise<[number, number]> {
  let cur = from;
  for (let i = 0; i < n; i++) {
    cur = [cur[0] + step[0], cur[1] + step[1]];
    await context.setGeolocation({ longitude: cur[0], latitude: cur[1], accuracy: 5 });
    await page.waitForTimeout(everyMs);
  }
  return cur;
}

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

/** Overpass QL bbox `(s,w,n,e)` and timeout out of the POST body the app sends. */
function parseOverpassBody(body: string): { bbox: [s: number, w: number, n: number, e: number]; timeoutS: number; query: string } {
  const query = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
  const bb = /\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/.exec(query);
  const to = /\[timeout:(\d+)\]/.exec(query);
  if (!bb || !to) throw new Error(`unexpected Overpass query: ${query.slice(0, 200)}`);
  return { bbox: [Number(bb[1]), Number(bb[2]), Number(bb[3]), Number(bb[4])], timeoutS: Number(to[1]), query };
}

/** Record every Overpass POST the page (or its workers) makes; `answer` decides the response. */
async function stubOverpass(page: Page, answer: (n: number) => 'fixture' | '504' | 'empty' | 'through'): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  await page.route(OVERPASS_URL, async (route) => {
    const n = requests.push(route.request().postData() ?? '');
    const how = answer(n);
    if (how === 'through') return route.continue();
    if (how === '504') return route.fulfill({ status: 504, contentType: 'text/html; charset=utf-8', body: OVERPASS_504, headers: { 'access-control-allow-origin': '*' } });
    // A regional mirror (overpass.osm.ch for Nelson) or open water: a valid answer with no ways.
    const body = how === 'empty' ? JSON.stringify({ version: 0.6, generator: 'Overpass API', elements: [] }) : nelsonBody();
    return route.fulfill({ status: 200, contentType: 'application/json', body, headers: { 'access-control-allow-origin': '*' } });
  });
  return { requests };
}

// ================================================================ A. Download this area (Nelson, BC)

test.use({ locale: 'en-US', geolocation: { longitude: NELSON_HOME[0], latitude: NELSON_HOME[1] } });

test.describe('A. Download this area (no prebuilt region — Overpass → IndexedDB)', () => {
  test('A1. offer → download (fixture) → routes; Direct then novelty; listed on Data with a size; persists across reload; delete removes coverage', async ({ page }) => {
    const { requests } = await stubOverpass(page, () => 'fixture');
    const b = await boot(page);
    await openRoute(page, NELSON_DEST);
    const sheet = page.locator('.sheet.route');
    await expect(sheet.locator('h2')).toContainText('Mill Street');
    const { status, areaBtn } = await waitOffer(page);
    // ~1 km trip → 3 km radius (min 3, max 8); no region button — Nelson is in no prebuilt region.
    await expect(areaBtn).toHaveText('Download this area (3 km around here)');
    await expect(status.getByRole('button', { name: /^Download .* for offline$/ })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Go' })).toBeDisabled();
    await idle(page);
    await shot(page, 'area-offer');

    const t0 = Date.now();
    await areaBtn.click();
    await expect(status.locator('.progress')).toBeVisible();
    await expect(areaBtn).toBeDisabled();
    await expect(page.locator('.toast', { hasText: 'Routing data ready' })).toBeVisible({ timeout: 90_000 });
    const first = await waitRouted(page);
    const downloadMs = Date.now() - t0;
    test.info().annotations.push({ type: 'download-area-ms', description: `${downloadMs} ms (fixture, incl. graph build + IndexedDB store + first route)` });
    expect(downloadMs).toBeLessThan(60_000);
    expect(requests, 'exactly one Overpass request per download').toHaveLength(1);
    // The query is sane: bbox within the 8 km cap around the midpoint, server timeout set, highway ways with geometry.
    const q = parseOverpassBody(requests[0]);
    const kmNS = (q.bbox[2] - q.bbox[0]) * 110.574;
    const kmEW = (q.bbox[3] - q.bbox[1]) * 111.32 * Math.cos((49.49 * Math.PI) / 180);
    test.info().annotations.push({ type: 'overpass-query', description: `bbox ${q.bbox.join(',')} (${kmNS.toFixed(1)} × ${kmEW.toFixed(1)} km), timeout ${q.timeoutS} s` });
    expect(kmNS).toBeGreaterThan(5.5);
    expect(kmNS).toBeLessThanOrEqual(6.2); // 3 km radius → 6 km square
    expect(kmEW).toBeGreaterThan(5.5);
    expect(kmEW).toBeLessThanOrEqual(6.2);
    expect(kmNS).toBeLessThanOrEqual(16.1); // MAX_AREA_RADIUS_KM = 8
    expect(q.timeoutS).toBeGreaterThanOrEqual(30);
    expect(q.query).toMatch(/^\[out:json\]/);
    expect(q.query).toContain('way["highway"]');
    expect(q.query).toMatch(/out geom;$/);
    // Routes: Direct is there and about the straight-line distance (~1 km).
    const direct = first.find((c) => c.name === 'Direct');
    expect(direct, `Direct candidate (got ${first.map((c) => c.name).join(', ')})`).toBeTruthy();
    expect(direct!.lengthM).toBeGreaterThan(800);
    expect(direct!.lengthM).toBeLessThan(2500);
    expect(first[first.length - 1].name).toBe('Direct');
    await expect(sheet.locator('.route-status')).not.toContainText('map centre'); // origin = the user's position (Nelson)
    test.info().annotations.push({ type: 'candidates-nelson', description: first.map((c) => `${c.name} ${c.lengthM} m ${c.pctNew}% new`).join(' | ') });
    await idle(page);
    await shot(page, 'area-routes');

    // Mark Direct as walked → re-open → novelty candidates.
    const walked = await page.evaluate(async (req) => {
      const u = (window as unknown as UnfogWindow).__unfog!;
      const res = await u.ctx!.engines.route.route(req);
      const d = res.candidates[res.candidates.length - 1];
      await u.ctx!.engines.grid.markTrack({ id: 'qa-nelson-walk', source: 'gpx', name: 'QA walk', points: d.coords.map((c) => [c[0], c[1]] as [number, number]) });
      await u.ctx!.dataChanged();
      return { name: d.name, points: d.coords.length };
    }, { from: NELSON_HOME, to: NELSON_DEST.lonlat, mode: 'walk', detour: 0.25 });
    expect(walked.name).toBe('Direct');
    expect(walked.points).toBeGreaterThan(5);
    expect((await stats(page)).visitedCells).toBeGreaterThan(30);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await openRoute(page, NELSON_DEST);
    const second = await waitRouted(page);
    test.info().annotations.push({ type: 'candidates-nelson-after-walk', description: second.map((c) => `${c.name} ${c.lengthM} m ${c.pctNew}% new ${c.newM} m new`).join(' | ') });
    const direct2 = second[second.length - 1];
    expect(direct2.name).toBe('Direct');
    expect(direct2.pctNew, 'the walked Direct route is mostly not new any more').toBeLessThan(40);
    if (second.length > 1) {
      expect(second[0].name).toBe('Most new');
      expect(second[0].newM, 'Most new has more unexplored metres than Direct').toBeGreaterThan(direct2.newM);
      expect(second[0].lengthM).toBeLessThanOrEqual(direct2.lengthM * 1.25 + 30);
    }
    await sheet.getByRole('button', { name: 'Close' }).click();

    // Data lists the area with its size and download date.
    await page.getByRole('tab', { name: 'Data' }).click();
    const row = page.locator('#screen-data .row-item', { hasText: /^Area · 3 km around 49\.49\d, -117\.29\d/ });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/\d+(\.\d+)? (KB|MB) · downloaded/);
    const shownBytes = parseBytes((await row.locator('.st').textContent()) ?? '');
    const areas = await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.listDownloads());
    expect(areas).toHaveLength(1);
    expect(areas[0].radiusKm).toBe(3);
    expect(areas[0].tiles).toBeGreaterThanOrEqual(1);
    expect(areas[0].tiles).toBeLessThanOrEqual(9); // 6 km square → at most 3×3 z12 tiles
    expect(areas[0].bytes).toBeGreaterThan(20_000); // 1,234 ways packed
    expect(areas[0].bytes).toBeLessThan(3_000_000);
    expect(Math.abs(shownBytes - areas[0].bytes) / areas[0].bytes).toBeLessThan(0.06); // "277 KB" rounds
    test.info().annotations.push({ type: 'area-record', description: `${areas[0].tiles} tiles, ${areas[0].bytes} bytes, id ${areas[0].id}` });
    await shot(page, 'area-data');

    // Reload: the area is still there and routing works without another Overpass request.
    await page.reload();
    await waitReady(page);
    expect(await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.listDownloads())).toHaveLength(1);
    await openRoute(page, NELSON_DEST);
    const afterReload = await waitRouted(page);
    expect(afterReload[afterReload.length - 1].name).toBe('Direct');
    expect(requests, 'no re-download after a reload (IndexedDB unfog-graph)').toHaveLength(1);
    await sheet.getByRole('button', { name: 'Close' }).click();

    // Delete the area: the row goes, coverage is gone, the sheet offers the download again.
    await page.getByRole('tab', { name: 'Data' }).click();
    await row.getByRole('button', { name: 'Delete area' }).click();
    const modal = page.locator('.sheet.modal');
    await expect(modal).toContainText('Delete this downloaded area?');
    await modal.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('#screen-data .row-item', { hasText: /^Area ·/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.listDownloads())).toHaveLength(0);
    const cov = await page.evaluate((bbox) => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.coverage(bbox), [-117.31, 49.48, -117.27, 49.5] as [number, number, number, number]);
    expect(cov.available).toBe(0);
    expect(cov.regions).toEqual([]);
    await openRoute(page, NELSON_DEST);
    await waitOffer(page);
    expect(requests).toHaveLength(1);
    expect(b.errors).toEqual([]);
  });

  test('A2. Overpass 504 once: the sheet says it is retrying, the retry succeeds', async ({ page }) => {
    const { requests } = await stubOverpass(page, (n) => (n === 1 ? '504' : 'fixture'));
    const b = await boot(page);
    await openRoute(page, NELSON_DEST);
    const { status, areaBtn } = await waitOffer(page);
    const t0 = Date.now();
    await areaBtn.click();
    // The first attempt fails with 504 → a visible retry note (src/routing/engine.ts forwards each attempt).
    await expect(status).toContainText('Overpass is busy (HTTP 504) — retrying in 15 s', { timeout: 20_000 });
    await expect(areaBtn).toBeDisabled();
    await shot(page, 'area-retrying');
    await expect(page.locator('.toast', { hasText: 'Routing data ready' })).toBeVisible({ timeout: 90_000 });
    const cands = await waitRouted(page);
    const ms = Date.now() - t0;
    test.info().annotations.push({ type: 'retry-ms', description: `${ms} ms from tap to routes with one 504 (15 s back-off)` });
    expect(ms).toBeGreaterThanOrEqual(15_000);
    expect(ms).toBeLessThan(60_000);
    expect(requests).toHaveLength(2);
    expect(cands[cands.length - 1].name).toBe('Direct');
    expect(b.errors).toEqual([]);
  });

  test('A3. offline: "Download this area" fails at once with a clear message and can be retried once online', async ({ page, context }) => {
    const { requests } = await stubOverpass(page, () => 'fixture');
    const b = await boot(page);
    await openRoute(page, NELSON_DEST);
    const { status, areaBtn } = await waitOffer(page);
    await context.setOffline(true);
    const t0 = Date.now();
    await areaBtn.click();
    await expect(status).toContainText('Download failed: No internet connection. Check your connection and try again.', { timeout: 10_000 });
    test.info().annotations.push({ type: 'offline-fail-ms', description: `${Date.now() - t0} ms` });
    await expect(areaBtn).toBeEnabled(); // retry-able
    await expect(status.locator('.spinner')).toHaveCount(0);
    expect(requests).toHaveLength(0);
    await shot(page, 'area-offline');
    // The worker guards too (navigator.onLine inside the route worker): a direct call rejects at once
    // instead of sleeping through the retry ladder (15 + 30 + 60 s per endpoint).
    const direct = await page.evaluate(async (c) => {
      const t = Date.now();
      try {
        await (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.downloadArea(c, 3);
        return { ok: true, ms: Date.now() - t, message: '' };
      } catch (e) {
        return { ok: false, ms: Date.now() - t, message: String((e as Error)?.message ?? e) };
      }
    }, NELSON_HOME);
    test.info().annotations.push({ type: 'worker-offline-guard', description: JSON.stringify(direct) });
    expect(direct.ok).toBe(false);
    expect(direct.message).toBe('No internet connection');
    expect(direct.ms).toBeLessThan(5_000);
    expect(requests).toHaveLength(0);

    // Back online: the same button works.
    await context.setOffline(false);
    await areaBtn.click();
    await expect(page.locator('.toast', { hasText: 'Routing data ready' })).toBeVisible({ timeout: 90_000 });
    const cands = await waitRouted(page);
    expect(cands[cands.length - 1].name).toBe('Direct');
    expect(requests).toHaveLength(1);
    expect(b.errors).toEqual([]);
  });

  test('A5. Overpass answers with no ways (open water / regional mirror): a plain message, nothing stored, still retry-able', async ({ page }) => {
    const { requests } = await stubOverpass(page, (n) => (n === 1 ? 'empty' : 'fixture'));
    const b = await boot(page);
    await openRoute(page, NELSON_DEST);
    const { status, areaBtn } = await waitOffer(page);
    await areaBtn.click();
    await expect(status).toContainText('No streets found in this area. Zoom in on a town and try again.', { timeout: 30_000 });
    await expect(status).not.toContainText('Check your connection');
    await expect(status.locator('.progress')).toBeHidden();
    await expect(areaBtn).toBeEnabled();
    await expect(page.locator('.toast', { hasText: 'Routing data ready' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.listDownloads()), 'an empty area is not stored').toHaveLength(0);
    expect(requests).toHaveLength(1);
    // Try again (a different server answers this time): works as usual.
    await areaBtn.click();
    await expect(page.locator('.toast', { hasText: 'Routing data ready' })).toBeVisible({ timeout: 90_000 });
    const cands = await waitRouted(page);
    expect(cands[cands.length - 1].name).toBe('Direct');
    expect(requests).toHaveLength(2);
    expect(b.errors).toEqual([]);
  });

  test.describe('REAL Overpass (skips when overpass-api.de does not answer)', () => {
    let overpassUp = false;
    let probeNote = '';
    test.beforeAll(async () => {
      // The smallest query that proves the server answers: a 100 m box on Baker Street.
      const q = '[out:json][timeout:20];way["highway"](49.4890,-117.2915,49.4900,-117.2900);out ids;';
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30_000);
        // Node's default UA ("node") gets HTTP 406 from overpass-api.de's Apache; name ourselves like the CLI does.
        const res = await fetch(OVERPASS_URL, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': 'unfog-e2e/0.1 (+https://data-t3labs.github.io/unfog/)' }, signal: ctrl.signal });
        clearTimeout(timer);
        overpassUp = res.ok;
        probeNote = `HTTP ${res.status} in ${Date.now() - t0} ms`;
      } catch (e) {
        probeNote = `${String((e as Error)?.message ?? e)} after ${Date.now() - t0} ms`;
      }
    });

    test('A4. Nelson, BC 3 km against the real overpass-api.de: one request, routes, listed with a size', async ({ page }) => {
      test.skip(!overpassUp, `overpass-api.de not answering (${probeNote})`);
      test.setTimeout(300_000);
      test.info().annotations.push({ type: 'overpass-probe', description: probeNote });
      const { requests } = await stubOverpass(page, () => 'through');
      const b = await boot(page);
      await openRoute(page, NELSON_DEST);
      const { status, areaBtn } = await waitOffer(page);
      const t0 = Date.now();
      await areaBtn.click();
      // Overpass may be slow, answer 504 (the app backs off 15/30/60 s before the next try) or hold
      // the connection until the 120 s deadline. Server weather is a skip, not a failure: only a
      // client-side outcome (wrong message, hang past the ladder, page error) fails this test.
      const notes: string[] = [];
      let outcome: string | null = null;
      const until = Date.now() + 280_000;
      while (Date.now() < until) {
        const text = (await status.textContent()) ?? '';
        const m = /Downloading area: (.*)$/.exec(text)?.[1];
        if (m && notes[notes.length - 1] !== m) notes.push(m);
        if ((await page.locator('.toast', { hasText: 'Routing data ready' }).count()) || (await page.locator('.sheet.route .cand').count())) outcome = 'ready';
        else if (/Download failed|No streets found/.test(text)) outcome = text;
        if (outcome) break;
        await page.waitForTimeout(1000);
      }
      test.info().annotations.push({ type: 'real-overpass-notes', description: notes.join(' → ') || '(no retry note)' });
      if (outcome !== 'ready') {
        // A retry note proves the client side works (deadline / back-off / endpoint switch); the server is the problem.
        const serverWeather = notes.some((n) => /HTTP 5\d\d|did not answer/.test(n)) || /HTTP 5\d\d|did not answer|giving up/.test(outcome ?? '');
        test.skip(serverWeather, `overpass-api.de unavailable during the run: ${outcome ?? 'still retrying after 280 s'} (${notes.join(' → ')})`);
        throw new Error(`unexpected download outcome: ${outcome ?? 'no answer and no retry note after 280 s (deadline not working?)'}`);
      }
      const cands = await waitRouted(page);
      const ms = Date.now() - t0;
      const areas = await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.listDownloads());
      test.info().annotations.push({ type: 'real-overpass', description: `${ms} ms, ${requests.length} request(s), ${areas[0]?.tiles} tiles, ${areas[0]?.bytes} bytes; ${cands.map((c) => `${c.name} ${c.lengthM} m`).join(' | ')}` });
      expect(requests.length).toBeGreaterThanOrEqual(1);
      expect(cands[cands.length - 1].name).toBe('Direct');
      expect(cands[cands.length - 1].lengthM).toBeGreaterThan(800);
      expect(areas).toHaveLength(1);
      expect(areas[0].bytes).toBeGreaterThan(20_000);
      expect(areas[0].bytes).toBeLessThan(3_000_000);
      await page.locator('.sheet.route').getByRole('button', { name: 'Close' }).click();
      await page.getByRole('tab', { name: 'Data' }).click();
      await expect(page.locator('#screen-data .row-item', { hasText: /^Area · 3 km/ })).toContainText(/\d+(\.\d+)? (KB|MB)/);
      await shot(page, 'area-real-overpass');
      expect(b.errors).toEqual([]);
    });
  });
});

// ================================================================ B. Service-worker update

const SW_PORT = 4181;
const SW_URL = `http://localhost:${SW_PORT}/unfog/`;
const SW_CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'unfog-e2e');

/** Static server for a Vite dist dir under /unfog/ whose root can be swapped (a "deploy"). */
function serveDist(port: number): Promise<{ setRoot(dir: string): void; close(): Promise<void> }> {
  let root = '';
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2', '.map': 'application/json', '.ufg': 'application/octet-stream', '.txt': 'text/plain', '.ico': 'image/x-icon',
  };
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (!pathname.startsWith('/unfog/')) {
      res.writeHead(404).end();
      return;
    }
    let rel = pathname.slice('/unfog/'.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    // GitHub Pages sends max-age=600; the SW script is fetched past the HTTP cache anyway (updateViaCache default).
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, () =>
      resolve({
        setRoot: (dir) => {
          root = path.resolve(dir);
        },
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
  });
}

function buildDist(outDir: string, stamp: string): void {
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--outDir', outDir], {
    cwd: ROOT,
    env: { ...process.env, UNFOG_BUILD: stamp },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
}

/** `url`s of the precache manifest inside a generated sw.js. */
function precacheManifest(distDir: string): string[] {
  const sw = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf8');
  const urls = new Set<string>();
  for (const m of sw.matchAll(/url:\s*"([^"]+)"/g)) urls.add(m[1]);
  for (const m of sw.matchAll(/"url":\s*"([^"]+)"/g)) urls.add(m[1]);
  return [...urls].sort();
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p));
  }
  return out.sort();
}

test.describe('B. Service-worker update (v1 → v2 deploy)', () => {
  test.use({ baseURL: SW_URL, serviceWorkers: 'allow' });
  const stampTag = Date.now().toString(36);
  const V1 = { dir: path.join(SW_CACHE_DIR, 'sw-v1'), stamp: `qa-v1-${stampTag}` };
  const V2 = { dir: path.join(SW_CACHE_DIR, 'sw-v2'), stamp: `qa-v2-${stampTag}` };
  let server: Awaited<ReturnType<typeof serveDist>> | null = null;
  let buildNote = '';

  test.beforeAll(async () => {
    test.setTimeout(400_000);
    if (process.env.PW_NO_PREVIEW) return;
    const t0 = Date.now();
    buildDist(V1.dir, V1.stamp);
    const t1 = Date.now();
    buildDist(V2.dir, V2.stamp);
    buildNote = `v1 build ${t1 - t0} ms, v2 build ${Date.now() - t1} ms`;
    server = await serveDist(SW_PORT);
    server.setRoot(V1.dir);
  });
  test.afterAll(async () => {
    await server?.close();
  });
  test.beforeEach(async () => {
    test.skip(Boolean(process.env.PW_NO_PREVIEW), 'PW_NO_PREVIEW set: production builds skipped');
  });

  test('B1. v2 deploy → "Update available — Reload" toast, no forced reload, a recording keeps going; Reload → v2 with a clean precache', async ({ page, context }) => {
    test.setTimeout(240_000);
    test.info().annotations.push({ type: 'builds', description: buildNote });
    const b = await boot(page, {
      readyTimeout: 120_000,
      init: () => {
        const w = window as unknown as UnfogWindow;
        w.__swEvents = [];
        navigator.serviceWorker?.addEventListener('controllerchange', () => w.__swEvents!.push('controllerchange'));
      },
    });
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 60_000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => toasts(page), { timeout: 30_000 }).toContainEqual('Unfog is ready to work offline');
    // Second load: everything (workers, chunks, basemap style) now comes through the controlling worker.
    await page.reload();
    await waitReady(page, 120_000);
    await page.evaluate(() => {
      (window as unknown as UnfogWindow).__marker = 1;
    });
    const buildLine = page.locator('#screen-help .about');
    await page.getByRole('tab', { name: 'Help' }).click();
    await expect(buildLine.locator('.build')).toHaveText(V1.stamp);
    await page.getByRole('tab', { name: 'Map' }).click();
    const v1Assets = listFiles(V1.dir).filter((f) => f.startsWith('assets/') && /\.(js|css)$/.test(f));
    const v2Assets = listFiles(V2.dir).filter((f) => f.startsWith('assets/') && /\.(js|css)$/.test(f));
    const v1Only = v1Assets.filter((f) => !v2Assets.includes(f));
    test.info().annotations.push({ type: 'changed-assets', description: `v1-only: ${v1Only.join(', ')}` });
    expect(v1Only.length, 'the stamp changes at least the main chunk').toBeGreaterThan(0);
    const precacheBefore = await page.evaluate(async () => {
      const names = await caches.keys();
      const pre = names.find((n) => /precache/.test(n))!;
      return { names, keys: (await (await caches.open(pre)).keys()).map((r) => new URL(r.url).pathname) };
    });
    expect(precacheBefore.keys).toContain('/unfog/' + v1Only[0]);

    // A walk is being recorded when the deploy happens.
    await context.setGeolocation({ longitude: -73.9568, latitude: 40.7176, accuracy: 5 });
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    const banner = page.locator('.rec-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    const dist = banner.locator('.rec-main > span').nth(1);
    await walk(context, page, [-73.9568, 40.7176], [-0.0002, 0.00008], 4);
    const distBefore = parseDistanceM((await dist.textContent()) ?? '');
    expect(distBefore).toBeGreaterThan(30);

    // Deploy v2 and let the (open) app check for an update, as a relaunch would.
    server!.setRoot(V2.dir);
    const t0 = Date.now();
    await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.update()));
    const swToast = page.locator('.toast[data-toast="sw"]');
    await expect(swToast).toBeVisible({ timeout: 60_000 });
    const toastMs = Date.now() - t0;
    await expect(swToast.locator('.toast-text')).toHaveText('Update available');
    const reloadBtn = swToast.getByRole('button', { name: 'Reload' });
    await expect(reloadBtn).toBeVisible();
    test.info().annotations.push({ type: 'update-toast-ms', description: `${toastMs} ms from registration.update() to the toast` });
    expect(toastMs).toBeLessThan(30_000);
    // Nothing was interrupted: same document, recording still running and still counting fixes.
    expect(await page.evaluate(() => (window as unknown as UnfogWindow).__marker)).toBe(1);
    await expect(banner).toBeVisible();
    await expect(page.locator('.app')).toHaveClass(/recording/);
    await walk(context, page, [-73.9568 - 4 * 0.0002, 40.7176 + 4 * 0.00008], [-0.0002, 0.00008], 4);
    const distAfter = parseDistanceM((await dist.textContent()) ?? '');
    expect(distAfter).toBeGreaterThan(distBefore + 30);
    expect(await page.evaluate(() => (window as unknown as UnfogWindow).__swEvents), 'the new worker took control without a reload (skipWaiting + clientsClaim)').toContain('controllerchange');
    await shot(page, 'sw-update-toast');
    // The toast stays until acted on (sticky) while a transient toast passes.
    await page.waitForTimeout(4000);
    await expect(swToast).toBeVisible();

    // After activation the OLD bundle's assets are gone from the caches; a lazy v1 chunk would now hit the
    // network (a Pages deploy no longer has it). Recorded as a fact of autoUpdate mode, see the QA report.
    const staleFetch = await page.evaluate(async (u) => {
      const r = await fetch(u, { cache: 'no-store' });
      const inCache = Boolean(await caches.match(u, { ignoreSearch: true }));
      return { status: r.status, inCache };
    }, '/unfog/' + v1Only[0]);
    test.info().annotations.push({ type: 'stale-v1-asset', description: `${v1Only[0]} → HTTP ${staleFetch.status}, in cache: ${staleFetch.inCache}` });
    expect(staleFetch.inCache).toBe(false);

    // Stop the walk: summary as usual, session stored — the update did not touch it.
    await page.getByRole('button', { name: 'Stop recording' }).click();
    const summary = page.locator('.record-summary');
    await expect(summary).toBeVisible({ timeout: 20_000 });
    await expect(summary.locator('h2')).toHaveText('Walk recorded');
    await expect(summary.locator('p')).toContainText(/9 GPS points/);
    await summary.getByRole('button', { name: 'Done' }).click();
    await expect(summary).toBeHidden();
    // The sticky toast is still offered after the modal.
    await expect(swToast).toBeVisible();

    // Reload → v2, controlled by the new worker, data intact.
    await reloadBtn.click();
    await waitReady(page, 120_000);
    expect(await page.evaluate(() => (window as unknown as UnfogWindow).__marker)).toBeUndefined();
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${SW_URL}sw.js`);
    await page.getByRole('tab', { name: 'Help' }).click();
    await expect(buildLine.locator('.build')).toHaveText(V2.stamp);
    await shot(page, 'sw-updated');
    const tracks = await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.grid.listTracks());
    expect(tracks.filter((t) => t.source === 'session')).toHaveLength(1);

    // Precache integrity: exactly the v2 manifest, every precachable v2 file, nothing from v1.
    const manifest = precacheManifest(V2.dir);
    const after = await page.evaluate(async () => {
      const names = await caches.keys();
      const out: Record<string, string[]> = {};
      for (const n of names) out[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname);
      return out;
    });
    const preName = Object.keys(after).find((n) => /precache/.test(n))!;
    expect(preName).toBeTruthy();
    const cached = after[preName].map((p) => p.replace(/^\/unfog\//, '')).sort();
    expect(cached).toEqual(manifest);
    const precachable = listFiles(V2.dir).filter((f) => /\.(js|css|html|svg|png|woff2)$/.test(f) && !/^(sw\.js|workbox-.*\.js|registerSW\.js)$/.test(f));
    for (const f of precachable) expect(manifest, `${f} is precached`).toContain(f);
    for (const f of v1Only) for (const [name, keys] of Object.entries(after)) expect(keys, `${f} gone from ${name}`).not.toContain('/unfog/' + f);
    test.info().annotations.push({ type: 'precache', description: `${manifest.length} entries; caches: ${Object.keys(after).join(', ')}` });

    // Same build again: no update toast on a plain relaunch.
    await page.reload();
    await waitReady(page, 120_000);
    await page.waitForTimeout(5000);
    await expect(page.locator('.toast[data-toast="sw"]')).toHaveCount(0);
    expect((await toasts(page)).filter((t) => /Update available/.test(t))).toEqual([]);
    expect(b.errors).toEqual([]);
  });
});

// ================================================================ C. Offline GPX import (preview server + service worker)

const PREVIEW_URL = process.env.PW_PREVIEW_URL ?? 'http://localhost:4174/unfog/';

/**
 * An Apple Health `workout-routes/*.gpx` look-alike: `lon` before `lat`, metadata time, per-point
 * ele/time/extensions (speed, hAcc, vAcc, course). A seeded random walk from `start`, `points`
 * fixes 5 s apart (~7 m each), kept inside a 2 km box so the gap splitter never fires.
 */
function syntheticGpx(seed: number, start: [number, number], points: number, startMs: number): string {
  let s = seed >>> 0;
  const rnd = () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const KX = 111320 * Math.cos((start[1] * Math.PI) / 180);
  const KY = 110574;
  let heading = rnd() * Math.PI * 2;
  let [lon, lat] = start;
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Apple Health Export" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    `  <metadata>\n    <time>${iso(startMs)}</time>\n  </metadata>`,
    '  <trk>',
    `    <name>Route ${iso(startMs).slice(0, 10)} ${String(seed).padStart(2, '0')}</name>`,
    '    <trkseg>',
  ];
  for (let i = 0; i < points; i++) {
    heading += (rnd() - 0.5) * 0.6;
    const step = 6 + rnd() * 2; // metres
    lon += (Math.cos(heading) * step) / KX;
    lat += (Math.sin(heading) * step) / KY;
    // Bounce off a 2 km box around the start.
    if (Math.abs((lon - start[0]) * KX) > 1000 || Math.abs((lat - start[1]) * KY) > 1000) heading += Math.PI;
    const ele = (8 + Math.sin(i / 50) * 3).toFixed(1);
    lines.push(
      `      <trkpt lon="${lon.toFixed(5)}" lat="${lat.toFixed(5)}"><ele>${ele}</ele><time>${iso(startMs + i * 5000)}</time><extensions><speed>${(step / 5).toFixed(2)}</speed><hAcc>${(3 + rnd() * 3).toFixed(1)}</hAcc><vAcc>${(2 + rnd() * 3).toFixed(1)}</vAcc><course>${(((heading * 180) / Math.PI + 360) % 360).toFixed(1)}</course></extensions></trkpt>`,
    );
  }
  lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
  return lines.join('\n');
}

test.describe('C. Import a large GPX set while offline (preview server + service worker)', () => {
  test.use({ baseURL: PREVIEW_URL });
  test.beforeEach(async () => {
    test.skip(!(await reachable(PREVIEW_URL)), `preview server not running at ${PREVIEW_URL} (PW_NO_PREVIEW set?)`);
  });

  test('C1. 20 Apple-Health-style GPX files (~5 MB) → progress, summary, stats; export backup', async ({ page, context }) => {
    test.setTimeout(240_000);
    // 20 files, ~250 KB each (1,450 fixes × ~175 bytes), starting on a 5×4 grid over Williamsburg.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfog-gpx-'));
    const files: string[] = [];
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const start: [number, number] = [-73.9668 + (i % 5) * 0.005, 40.7096 + Math.floor(i / 5) * 0.004];
      const day = Date.UTC(2024, 5, 1 + i, 12, 15, 4);
      const text = syntheticGpx(i + 1, start, 1450, day);
      const name = `route_2024-06-${String(i + 1).padStart(2, '0')}_8.15am.gpx`;
      fs.writeFileSync(path.join(dir, name), text);
      files.push(path.join(dir, name));
      total += Buffer.byteLength(text);
    }
    test.info().annotations.push({ type: 'gpx-set', description: `${files.length} files, ${(total / 1e6).toFixed(2)} MB` });
    expect(total).toBeGreaterThan(4.5e6);
    expect(total).toBeLessThan(6e6);

    const b = await boot(page, { share: 'capture', readyTimeout: 120_000 });
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 60_000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await waitReady(page, 120_000);
    await context.setOffline(true);

    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.locator('#screen-data')).toBeVisible();
    // Record what the progress line and bar showed while the import ran.
    await page.evaluate(() => {
      const w = window as unknown as { __progress: string[] };
      w.__progress = [];
      const status = document.querySelector('#screen-data .progress + .muted.small') ?? document.querySelector('#screen-data .progress')?.nextElementSibling;
      const bar = document.querySelector('#screen-data .progress .bar') as HTMLElement | null;
      new MutationObserver(() => {
        const t = `${status?.textContent ?? ''} @ ${bar?.style.width ?? ''}`;
        if (w.__progress[w.__progress.length - 1] !== t) w.__progress.push(t);
      }).observe(document.querySelector('#screen-data')!, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] });
    });
    const t0 = Date.now();
    await page.locator('#screen-data input[type=file]').setInputFiles(files);
    const importBtn = page.getByRole('button', { name: 'Import files' });
    await expect(importBtn).toBeDisabled();
    await expect(page.locator('#screen-data .import-result .name')).toBeVisible({ timeout: 120_000 });
    await expect(importBtn).toBeEnabled();
    const importMs = Date.now() - t0;
    const summary = (await page.locator('#screen-data .import-result .name').textContent()) ?? '';
    const lines = await page.locator('#screen-data .import-result li').allTextContents();
    const progress = await page.evaluate(() => (window as unknown as { __progress: string[] }).__progress);
    test.info().annotations.push({ type: 'import', description: `${importMs} ms offline; "${summary}"; ${lines.length} lines; progress steps: ${progress.length} (${progress.slice(0, 3).join(' | ')} … ${progress.slice(-2).join(' | ')})` });
    expect(summary).toMatch(/^[\d,]+ new cells, [\d.]+ km² added$/);
    const newCells = Number(/^([\d,]+) new cells/.exec(summary)![1].replace(/,/g, ''));
    expect(newCells).toBeGreaterThan(10_000); // 20 × ~10 km of walking at ~10 m cells
    expect(lines).toHaveLength(20);
    for (const l of lines) expect(l).toMatch(/^route_2024-06-\d\d_8\.15am\.gpx: GPX — \d+ tracks?$/);
    expect(progress.length, 'the progress line moved while importing').toBeGreaterThan(2);
    expect(progress.some((p) => /Reading|Adding|GPX/.test(p))).toBe(true);
    expect(importMs).toBeLessThan(90_000);
    await expect(page.locator('.toast.success')).toContainText('new cells');
    await shot(page, 'gpx-import');
    const s = await stats(page);
    expect(s.visitedCells).toBe(newCells);
    const tracks = await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.grid.listTracks());
    expect(tracks.filter((t) => t.source === 'gpx').length).toBeGreaterThanOrEqual(20);
    expect(tracks.reduce((a, t) => a + t.lengthM, 0)).toBeGreaterThan(150_000); // ~10 km each

    // Stats: the GPX source is listed; the map chip shows the area.
    await page.getByRole('tab', { name: 'Stats' }).click();
    await expect(page.locator('#screen-stats')).toContainText('GPX imports');
    await expect(page.locator('#screen-stats .stat', { hasText: 'tracks stored' }).locator('.v')).toHaveText(/^\d+$/);
    await page.getByRole('tab', { name: 'Map' }).click();
    await expect(page.locator('.stat-chip .sub')).toHaveText(`${newCells.toLocaleString('en-US')} cells`);

    // Export backup (offline too — nothing leaves the device): a zip of a sane size.
    await page.getByRole('tab', { name: 'Data' }).click();
    const t1 = Date.now();
    await page.getByRole('button', { name: 'Export backup' }).click();
    await page.waitForFunction(() => ((window as unknown as UnfogWindow).__shared?.length ?? 0) > 0, null, { timeout: 60_000 });
    const shared = await page.evaluate(() => (window as unknown as UnfogWindow).__shared!);
    const bytes = Buffer.from(shared[0].b64, 'base64');
    test.info().annotations.push({ type: 'backup', description: `${shared[0].name} ${bytes.length} bytes in ${Date.now() - t1} ms` });
    expect(shared[0].name).toMatch(/^unfog-backup-\d{8}\.zip$/);
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(bytes.length).toBeGreaterThan(50_000);
    expect(bytes.length).toBeLessThan(15_000_000);
    await expect(page.locator('.toast.success', { hasText: 'Backup shared' })).toBeVisible();
    await expect(page.locator('#screen-data')).toContainText('Last backup today');
    expect(b.errors).toEqual([]);
    expect(b.consoleErrors.filter((e) => /import|worker|grid/i.test(e) && !/openfreemap|photon/i.test(e))).toEqual([]);
  });
});
