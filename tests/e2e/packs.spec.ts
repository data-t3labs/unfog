/**
 * Coverage v2 end to end — routing on published graph packs with no prebuilt region and no
 * downloaded area, the automatic prefetch around the user, the Data screen's "Routing data"
 * (list, sizes, Clear), offline routing from the pack cache, and a shard that is not deployed yet
 * (404) degrading to the straight-line floor with no error.
 *
 * Hermetic: headless Chromium on this machine cannot reach external hosts, so `context.route`
 * serves a fake packs-index.json on the app origin and the packs from sibling paths
 * (`/unfog-graph-N/packs/…`, as the real shard sites do: same origin, absolute URLs in the index),
 * answering `Range` with 206 + Content-Range like GitHub Pages. The packs are real: built here from
 * the prebuilt public/graph/{nyc,vancouver} tiles with src/routing/pack-format.ts. graph/index.json
 * is stubbed to `[]`, so nothing is prebuilt and every street the route worker sees came through a
 * byte range. Helpers mirror tests/e2e/real.spec.ts (kept local so the specs change independently).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { cellKey, cellOf, encodePack, packFileName, type PacksIndex } from '../../src/routing/pack-format';

const here = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(here, '..', '..');
const shots = path.join(here, 'screenshots');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `packs-${name}.png`), fullPage: false });

const APP = 'http://localhost:5173';
/** The map's default centre and the e2e geolocation (playwright.config.ts): z12 tile 1206/1539, cell 6/18/24. */
const BEDFORD_N7: [number, number] = [-73.9568, 40.7176];
const DOMINO_PARK = { name: 'Domino Park', locality: 'Williamsburg, Brooklyn', lonlat: [-73.9678, 40.7142] as [number, number] };
/** Sutphin Blvd → Archer Av, Jamaica (Queens): tile 1208/1540 — a different tile from Bedford, same cell. */
const JAMAICA = { name: 'Archer Avenue', locality: 'Jamaica, Queens', lonlat: [-73.798, 40.706] as [number, number], origin: [-73.8075, 40.702] as [number, number] };
/** Downtown Vancouver (cell 6/10/21): the second pack. */
const VANCOUVER = { name: 'Vancouver Art Gallery', locality: 'Downtown Vancouver', lonlat: [-123.1207, 49.2827] as [number, number], origin: [-123.1105, 49.276] as [number, number] };
/** Open water south of Block Island: tile 1229/1537, cell 6/19/24 — listed in the index, shard not deployed (404). */
const SEA = { name: 'Open water', locality: 'Atlantic', lonlat: [-71.88, 40.91] as [number, number], origin: [-71.9, 40.9] as [number, number] };
/** Outside every pack: the pre-existing download offer must still appear. */
const PARIS = { name: 'Louvre', locality: 'Paris', lonlat: [2.3364, 48.8606] as [number, number], origin: [2.3522, 48.8566] as [number, number] };

// ---------------------------------------------------------------- page-side types (structural)

interface PackStatus {
  indexAgeMs: number;
  indexCells: number;
  cells: Array<{ cell: string; tiles: number; bytes: number; lastUsed: number; source?: string }>;
  totalBytes: number;
  totalTiles: number;
}
type UnfogWindow = {
  __unfog?: {
    ready: boolean;
    mock: boolean;
    openRoute?: (d: { name: string; locality?: string; lonlat: [number, number]; origin?: [number, number] }) => void;
    ctx?: {
      engines: {
        route: {
          coverage(bbox: [number, number, number, number]): Promise<{ needed: number; available: number; packable: number; regions: string[] }>;
          packsStatus(): Promise<PackStatus>;
          route(req: { from: [number, number]; to: [number, number]; mode: string; detour: number }): Promise<{ candidates: Array<{ name: string; lengthM: number; parts?: Array<{ kind: string }> }>; graphTiles: number }>;
        };
      };
      map: { map: { loaded(): boolean; isMoving(): boolean; once(ev: 'idle', cb: () => void): unknown } };
    };
  };
};

// ---------------------------------------------------------------- the fake pack host

interface BuiltPack {
  cell: string;
  name: string;
  bytes: Uint8Array;
  indexBytes: number;
  tiles: Array<[number, number]>;
  builtAt: string;
}

/** Real packs from a prebuilt region's z12 tiles, one per z6 cell (NYC spans 6/18/23 — the Bronx row — and 6/18/24). */
function buildPacks(region: string): BuiltPack[] {
  const dir = path.join(ROOT, 'public', 'graph', region);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { tiles: Array<[number, number, number]>; builtAt: string };
  const byCell = new Map<string, Array<{ tx: number; ty: number; bytes: Uint8Array }>>();
  for (const [tx, ty] of m.tiles) {
    const k = cellKey(...cellOf(tx, ty));
    (byCell.get(k) ?? byCell.set(k, []).get(k)!).push({ tx, ty, bytes: new Uint8Array(fs.readFileSync(path.join(dir, '12', String(tx), `${ty}.ufg`))) });
  }
  return [...byCell].map(([cell, tiles]) => {
    const [cx, cy] = cellOf(tiles[0].tx, tiles[0].ty);
    const p = encodePack([cx, cy], tiles);
    return { cell, name: packFileName(cx, cy), bytes: p.bytes, indexBytes: p.index.indexBytes, tiles: tiles.map((t) => [t.tx, t.ty] as [number, number]), builtAt: m.builtAt };
  });
}

interface PackHost {
  /** The pack holding Bedford & N 7th's tile (cell 6/18/24). */
  nyc: BuiltPack;
  /** Downtown Vancouver's pack (cell 6/10/21). */
  van: BuiltPack;
  index: PacksIndex;
  /** Every pack request the worker made. */
  log: Array<{ url: string; range: string | null; status: number }>;
  indexFetches: number;
}

const shardUrl = (shard: number, name: string) => `${APP}/unfog-graph-${shard}/packs/${name}`;

async function servePacks(context: BrowserContext): Promise<PackHost> {
  const nycPacks = buildPacks('nyc'), vanPacks = buildPacks('vancouver');
  const nyc = nycPacks.find((p) => p.cell === cellKey(18, 24))!, van = vanPacks.find((p) => p.cell === cellKey(10, 21))!;
  expect(nyc, 'NYC pack for cell 6/18/24').toBeTruthy();
  expect(van, 'Vancouver pack for cell 6/10/21').toBeTruthy();
  const files = new Map<string, Uint8Array>();
  const index: PacksIndex = { version: 1, zoom: 12, packZoom: 6, builtAt: '2026-09-02T12:00:00Z', release: 'graphs-v1', packs: {} };
  const publish = (packs: BuiltPack[], shard: number, source: string) => {
    for (const p of packs) {
      files.set(shardUrl(shard, p.name), p.bytes);
      index.packs[p.cell] = { url: shardUrl(shard, p.name), bytes: p.bytes.length, indexBytes: p.indexBytes, tiles: p.tiles.length, builtAt: p.builtAt, source };
    }
  };
  publish(nycPacks, 1, 'Geofabrik us/new-york 2026-09-02');
  publish(vanPacks, 2, 'Geofabrik canada/british-columbia 2026-09-02');
  // Shard 3 has not deployed: every request 404s. "Not available this session", never an error.
  index.packs['6/19/24'] = { url: shardUrl(3, packFileName(19, 24)), bytes: 4096, indexBytes: 48, tiles: 1, builtAt: nyc.builtAt, source: 'Geofabrik us/new-york 2026-09-02' };
  const host: PackHost = { nyc, van, index, log: [], indexFetches: 0 };
  await context.route('**/unfog/graph/index.json', (r) => r.fulfill({ json: [] }));
  await context.route('**/unfog/graph/packs/packs-index.json', (r) => {
    host.indexFetches++;
    return r.fulfill({ json: index, headers: { 'cache-control': 'no-cache' } });
  });
  await context.route('**/unfog-graph-*/packs/*.ufp', (r) => {
    const url = r.request().url();
    const range = r.request().headers()['range'] ?? null;
    const body = files.get(url);
    if (!body) {
      host.log.push({ url, range, status: 404 });
      return r.fulfill({ status: 404, body: 'Not Found' });
    }
    const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (!m) {
      host.log.push({ url, range, status: 200 });
      return r.fulfill({ status: 200, body: Buffer.from(body), contentType: 'application/octet-stream' });
    }
    const start = Number(m[1]), end = Math.min(Number(m[2]), body.length - 1);
    host.log.push({ url, range, status: 206 });
    return r.fulfill({
      status: 206,
      body: Buffer.from(body.subarray(start, end + 1)),
      headers: { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' },
    });
  });
  return host;
}

// ---------------------------------------------------------------- helpers

async function boot(page: Page): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('unfog.installDismissed', String(Date.now()));
    localStorage.setItem('unfog.trackingOffered', String(Date.now()));
  });
  await page.goto('');
  await page.waitForFunction(() => (window as unknown as UnfogWindow).__unfog?.ready === true, null, { timeout: 90_000 });
  expect(await page.evaluate(() => (window as unknown as UnfogWindow).__unfog?.mock), 'real engines (not mock mode)').toBe(false);
  expect(errors, 'no uncaught page errors during boot').toEqual([]);
  return { errors };
}

const status = (page: Page) => page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.packsStatus());

async function openRoute(page: Page, dest: { name: string; locality?: string; lonlat: [number, number]; origin?: [number, number] }): Promise<void> {
  await page.evaluate((d) => (window as unknown as UnfogWindow).__unfog!.openRoute!(d), dest);
  await expect(page.locator('.sheet.route')).toBeVisible();
}

/** "850 m" / "1.3 km" → metres. */
function parseDistanceM(text: string): number {
  const m = /([\d.,]+)\s*(km|m)\b/.exec(text);
  if (!m) throw new Error(`no distance in "${text}"`);
  const v = Number(m[1].replace(/,/g, ''));
  return m[2] === 'km' ? v * 1000 : v;
}

/** Wait for a route to finish: spinner gone, no error, ≥ 1 candidate row; the rows as name + metres. */
async function waitRouted(page: Page): Promise<Array<{ name: string; lengthM: number }>> {
  const sheet = page.locator('.sheet.route');
  await expect(sheet.locator('.route-status .spinner')).toBeHidden({ timeout: 60_000 });
  await expect(sheet.locator('.route-status .error')).toHaveCount(0);
  await expect(sheet.locator('.cand').first()).toBeVisible({ timeout: 60_000 });
  return sheet.locator('.cand').evaluateAll((rows) => rows.map((r) => ({ name: r.querySelector('.name')?.textContent ?? '', st: r.querySelector('.st')?.textContent ?? '' }))).then((rows) => rows.map((r) => ({ name: r.name, lengthM: parseDistanceM(r.st) })));
}

/** The sheet never offered a download or an error: the route "just worked". */
async function expectNoPrompt(page: Page): Promise<void> {
  const st = page.locator('.sheet.route .route-status');
  await expect(st.locator('.download-offer')).toHaveCount(0);
  await expect(st).not.toContainText('No routing data');
  await expect(st.locator('.error')).toHaveCount(0);
  await expect(page.locator('.toast.error')).toHaveCount(0);
}

const closeSheet = async (page: Page) => {
  await page.locator('.sheet.route').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.sheet.route')).toBeHidden();
};

const ring = (x: number, y: number, r = 2): Set<string> => {
  const out = new Set<string>();
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.add(`${x + dx}/${y + dy}`);
  return out;
};

// ================================================================ tests

test.use({ locale: 'en-US' });

test.describe('Coverage v2: graph packs', () => {
  test('1. a city with no prebuilt region and no download: routes need no prompt (byte ranges, index first), a second pack on another shard, the cache serves offline', async ({ page, context }) => {
    const host = await servePacks(context);
    const b = await boot(page);
    expect(host.indexFetches, 'the coverage list is fetched from the network at boot').toBe(1);

    // A route across Williamsburg: no "download" prompt, no error — Direct ≈ 1.3 km on pack tiles.
    await openRoute(page, DOMINO_PARK);
    const cands = await waitRouted(page);
    await expectNoPrompt(page);
    const direct = cands[cands.length - 1];
    expect(direct.name).toBe('Direct');
    expect(direct.lengthM).toBeGreaterThan(1000);
    expect(direct.lengthM).toBeLessThan(1800);
    await page.waitForTimeout(700); // fitBounds
    await shot(page, 'route');
    // Every street came through a byte range: the pack index first, 206 throughout, never a whole pack.
    const nycUrl = host.index.packs[host.nyc.cell].url;
    const nycCalls = host.log.filter((c) => c.url === nycUrl);
    expect(nycCalls[0], 'the pack index is read first, in one range').toMatchObject({ range: `bytes=0-${host.nyc.indexBytes - 1}`, status: 206 });
    for (const c of host.log) expect(c, 'every pack request is a byte range answered 206').toMatchObject({ status: 206 });
    const s0 = await status(page);
    expect(s0.indexCells).toBe(Object.keys(host.index.packs).length);
    expect(s0.cells.map((c) => c.cell)).toEqual([host.nyc.cell]);
    expect(s0.cells[0].source).toBe('Geofabrik us/new-york 2026-09-02');
    expect(s0.totalTiles).toBeGreaterThanOrEqual(1);
    expect(s0.indexAgeMs).toBeLessThan(120_000);
    test.info().annotations.push({ type: 'first-route', description: `${s0.totalTiles} tiles, ${s0.totalBytes} B in ${nycCalls.length} requests` });
    const cov = await page.evaluate((c) => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.coverage([c[0] - 0.01, c[1] - 0.01, c[0] + 0.01, c[1] + 0.01]), BEDFORD_N7);
    expect(cov.regions).toEqual([]); // nothing prebuilt
    expect(cov.available).toBeGreaterThanOrEqual(1);
    await closeSheet(page);

    // The second pack (Vancouver, another shard): its first route fetches its own tiles.
    await openRoute(page, VANCOUVER);
    const van = await waitRouted(page);
    await expectNoPrompt(page);
    expect(van[van.length - 1].name).toBe('Direct');
    expect(host.log.some((c) => c.url === host.index.packs[host.van.cell].url && c.status === 206)).toBe(true);
    const s1 = await status(page);
    expect(s1.cells.map((c) => c.cell).sort()).toEqual([host.nyc.cell, host.van.cell].sort());
    await closeSheet(page);

    // Offline: the cached tiles still route (same Direct as online); no pack request is made.
    await context.setOffline(true);
    const requests = host.log.length;
    await openRoute(page, DOMINO_PARK);
    const offline = await waitRouted(page);
    await expectNoPrompt(page);
    expect(offline[offline.length - 1].name).toBe('Direct');
    expect(offline[offline.length - 1].lengthM).toBe(direct.lengthM);
    expect(host.log.length).toBe(requests);
    await closeSheet(page);
    await context.setOffline(false);
    expect(b.errors).toEqual([]);
  });

  test('1b. the streets arrive by themselves: the ring around the map centre at boot, then around a position fix — no click, no route', async ({ page, context }) => {
    const host = await servePacks(context);
    const b = await boot(page);
    // Boot alone: the 5×5 ring around the map centre (Bedford & N 7th) downloads — index first, coalesced ranges.
    const nycTiles = new Set(host.nyc.tiles.map(([x, y]) => `${x}/${y}`));
    const bootRing = [...ring(1206, 1539)].filter((k) => nycTiles.has(k));
    expect(bootRing.length).toBeGreaterThanOrEqual(9);
    await expect.poll(async () => (await status(page)).totalTiles, { timeout: 30_000, message: 'the ring around the map centre is prefetched at boot' }).toBeGreaterThanOrEqual(bootRing.length);
    const s0 = await status(page);
    expect(s0.cells.map((c) => c.cell)).toEqual([host.nyc.cell]);
    const nycUrl = host.index.packs[host.nyc.cell].url;
    const nycCalls = host.log.filter((c) => c.url === nycUrl);
    expect(nycCalls[0]).toMatchObject({ range: `bytes=0-${host.nyc.indexBytes - 1}`, status: 206 });
    expect(nycCalls.length, 'tiles come in coalesced ranges, not one request per tile').toBeLessThan(1 + bootRing.length);
    test.info().annotations.push({ type: 'boot-prefetch', description: `${s0.totalTiles} tiles, ${s0.totalBytes} B in ${nycCalls.length} requests` });
    // A position fix in another tile (Jamaica, Queens) moves the ring: the tiles east of it arrive.
    const jamaicaRing = [...ring(1208, 1540)].filter((k) => nycTiles.has(k) && !ring(1206, 1539).has(k));
    expect(jamaicaRing.length).toBeGreaterThanOrEqual(1);
    await context.setGeolocation({ longitude: JAMAICA.origin[0], latitude: JAMAICA.origin[1], accuracy: 5 });
    await page.getByRole('button', { name: 'My location' }).click();
    await expect.poll(async () => (await status(page)).totalTiles, { timeout: 30_000, message: 'the ring follows a position fix' }).toBeGreaterThanOrEqual(s0.totalTiles + jamaicaRing.length);
    for (const c of host.log) expect(c).toMatchObject({ status: 206 });
    expect(b.errors).toEqual([]);
  });

  test('2. Data → Routing data: automatic, the cached streets by place with sizes, the coverage list age, Clear', async ({ page }) => {
    const host = await servePacks(page.context());
    await boot(page);
    // Let the boot prefetch round finish (the whole ring lands in one round) so Clear is not raced by it.
    const nycTiles = new Set(host.nyc.tiles.map(([x, y]) => `${x}/${y}`));
    const bootRing = [...ring(1206, 1539)].filter((k) => nycTiles.has(k));
    await expect.poll(async () => (await status(page)).totalTiles, { timeout: 30_000 }).toBeGreaterThanOrEqual(bootRing.length);
    await page.getByRole('tab', { name: 'Data' }).click();
    const data = page.locator('#screen-data');
    await expect(data).toContainText('Routing data');
    await expect(data).toContainText('Automatic: the streets around you download as you go (Wi-Fi and mobile; paused on Low Data Mode)');
    const row = data.locator('.packs-cell');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Streets near New York (US)');
    await expect(row).toContainText(/\d+(\.\d+)? (KB|MB) · used today/);
    await expect(data.locator('.packs-total')).toContainText(/\d+(\.\d+)? (KB|MB) of streets on this phone/);
    await expect(data.locator('.packs-age')).toHaveText('Coverage list updated just now.');
    // The prebuilt Regions / Downloaded areas section is still there (empty: nothing prebuilt in this run).
    await expect(data).toContainText('No prebuilt regions published yet');
    await shot(page, 'data');
    await data.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(page.locator('.toast', { hasText: 'Routing data cleared' })).toBeVisible();
    await expect(data.locator('.packs-cell')).toHaveCount(0);
    await expect(data).toContainText('Nothing downloaded yet');
    await expect(data.getByRole('button', { name: 'Clear', exact: true })).toBeHidden();
    expect((await status(page)).totalTiles).toBe(0);
    // It comes back by itself: a route fetches its tiles again and the list fills.
    await openRoute(page, DOMINO_PARK);
    await waitRouted(page);
    await expectNoPrompt(page);
    await closeSheet(page);
    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(data.locator('.packs-cell')).toHaveCount(1, { timeout: 15_000 });
  });

  test('3. a cell whose shard is not deployed (404): the straight-line floor, no error, no prompt; outside every pack the download offer stays', async ({ page }) => {
    const host = await servePacks(page.context());
    const b = await boot(page);
    await openRoute(page, SEA);
    const cands = await waitRouted(page);
    await expectNoPrompt(page);
    expect(cands).toHaveLength(1);
    expect(cands[0].name).toBe('Direct');
    await expect(page.locator('.sheet.route .route-status')).toContainText('as the crow flies');
    expect(host.log.filter((c) => c.status === 404).length).toBeGreaterThanOrEqual(1);
    const floor = await page.evaluate((r) => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.route(r), { from: SEA.origin, to: SEA.lonlat, mode: 'walk', detour: 0.25 });
    expect(floor.graphTiles).toBe(0);
    expect(floor.candidates[0].parts?.map((p) => p.kind)).toEqual(['straight']);
    await closeSheet(page);
    // Paris is in no pack: the pre-existing offer (Download this area / Route anyway), not a silent line.
    await openRoute(page, PARIS);
    const st = page.locator('.sheet.route .route-status');
    await expect(st.locator('.spinner')).toBeHidden({ timeout: 60_000 });
    await expect(st).toContainText('No routing data for this area yet');
    await expect(st.getByRole('button', { name: /Download this area/ })).toBeVisible();
    await expect(st.getByRole('button', { name: /Route anyway/ })).toBeVisible();
    await expect(page.locator('.toast.error')).toHaveCount(0);
    await closeSheet(page);
    expect(b.errors).toEqual([]);
  });
});
