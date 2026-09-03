/**
 * Feedback round 1 (data's first real walks with Unfog, 2026-09-02):
 *
 *   1. The fog (and heat) must follow a recording live — no Stop, no Fog/Heat/Off toggle — and
 *      must redraw after an import while the map is already showing the area.
 *   2. No "no street within 300 m" error: a pin off the network snaps to the nearest street at
 *      any distance and the route starts with a straight off-road leg.
 *   3. Ends the street network cannot join get a straight-line gap instead of NoRouteError; no
 *      coverage offers "Route anyway" next to the download.
 *   4. A Satellite basemap (Esri World Imagery + OpenFreeMap labels) with the fog on top.
 *
 * Real engines throughout (grid + route workers, the prebuilt NYC graph). Helpers mirror
 * tests/e2e/real.spec.ts; kept local so the specs stay independent.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const here = path.dirname(new URL(import.meta.url).pathname);
const shots = path.join(here, 'screenshots');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `fb1-${name}.png`), fullPage: false });

/** Bedford Av & N 7th St, Williamsburg. */
const BEDFORD_N7: [number, number] = [-73.9568, 40.7176];
/** ~19 m per fix along N 7th St towards the river. */
const N7_STEP: [number, number] = [-0.0002, 0.00008];

type UnfogWindow = {
  __unfog?: {
    ready: boolean;
    mock: boolean;
    perf?: { requested: number; done: number };
    openRoute?: (d: { name: string; locality?: string; lonlat: [number, number]; origin?: [number, number] }) => void;
    ctx?: {
      engines: {
        grid: { getStats(): Promise<{ visitedCells: number; version: number }> };
        route: {
          route(req: { from: [number, number]; to: [number, number]; mode: string; detour: number }): Promise<{ candidates: Array<{ name: string; coords: Array<[number, number]>; lengthM: number; parts?: Array<{ kind: string; lengthM: number }> }>; shortestM: number }>;
        };
      };
      map: {
        lastFix: { lon: number; lat: number } | null;
        setFollow(on: boolean, zoomTo?: number): void;
        map: {
          loaded(): boolean;
          isMoving(): boolean;
          once(ev: 'idle', cb: () => void): unknown;
          jumpTo(o: { center: [number, number]; zoom: number }): unknown;
          getSource(id: string): { tiles?: string[] } | undefined;
          getLayer(id: string): unknown;
          getStyle(): { name?: string; layers: Array<{ id: string; type: string }>; sources: Record<string, { type: string; tiles?: string[]; attribution?: string }> };
          setLayoutProperty(id: string, prop: string, value: string): unknown;
          areTilesLoaded(): boolean;
          project(ll: [number, number]): { x: number; y: number };
          getZoom(): number;
        };
      };
    };
  };
};

async function boot(page: Page, init?: () => void): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Pre-dismiss the install card and the first-run tracking offer so the chrome is unobstructed.
  await page.addInitScript(() => {
    localStorage.setItem('unfog.installDismissed', String(Date.now()));
    localStorage.setItem('unfog.trackingOffered', String(Date.now()));
  });
  if (init) await page.addInitScript(init);
  await page.goto('');
  await page.waitForFunction(() => (window as unknown as UnfogWindow).__unfog?.ready === true, null, { timeout: 90_000 });
  expect(await page.evaluate(() => (window as unknown as UnfogWindow).__unfog?.mock), 'real engines').toBe(false);
  return { errors };
}

/**
 * Hide the basemap's symbol layers for pixel probes. Street names are drawn ABOVE the fog, along the
 * street centreline — exactly where a walk's fixes are — so a 1-px luma sample can land on a dark
 * glyph and read "still foggy" on a cleared street (feedback-2 diagnosis: the second-stretch probe
 * read 112–118 on "North 7th Street" letters where the fog tile itself was fully transparent).
 * The tests here are about the fog tiles, not the labels.
 */
async function hideLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
    for (const l of map.getStyle().layers) if (l.type === 'symbol') map.setLayoutProperty(l.id, 'visibility', 'none');
  });
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

async function tilesSettled(page: Page): Promise<void> {
  await idle(page);
  await page.waitForFunction(() => {
    const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
    return map.loaded() && map.areTilesLoaded();
  }, null, { timeout: 60_000 });
  await idle(page);
}

function pngPixel(png: Buffer): [number, number, number, number] {
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
  const px = zlib.inflateSync(Buffer.concat(idat)).subarray(1);
  if (colorType === 6) return [px[0], px[1], px[2], px[3]];
  if (colorType === 2) return [px[0], px[1], px[2], 255];
  return [px[0], px[0], px[0], 255];
}

/** Luminance of the composited page pixel at CSS coordinates. */
async function pixelLuma(page: Page, x: number, y: number): Promise<number> {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 }, scale: 'css' });
  const [r, g, b] = pngPixel(png);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Screen position (CSS px) of a lon/lat. */
const project = (page: Page, ll: [number, number]) =>
  page.evaluate((c) => {
    const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
    const p = map.project(c);
    const r = document.querySelector('#map')!.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, ll);

const perfRequested = (page: Page) => page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.perf!.requested);
const overlayUrl = (page: Page) => page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.getSource('unfog-overlay')?.tiles?.[0]);
const isMoving = (page: Page) => page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.isMoving());

async function walk(context: BrowserContext, page: Page, from: [number, number], step: [number, number], n: number, everyMs = 300): Promise<[number, number]> {
  let cur = from;
  for (let i = 0; i < n; i++) {
    cur = [cur[0] + step[0], cur[1] + step[1]];
    await context.setGeolocation({ longitude: cur[0], latitude: cur[1], accuracy: 5 });
    await page.waitForTimeout(everyMs);
  }
  return cur;
}

async function importFiles(page: Page, files: string[]): Promise<string> {
  await page.getByRole('tab', { name: 'Data' }).click();
  await expect(page.locator('#screen-data')).toBeVisible();
  await page.locator('#screen-data input[type=file]').setInputFiles(files);
  await expect(page.locator('#screen-data .import-result .name')).toBeVisible({ timeout: 60_000 });
  return (await page.locator('#screen-data .import-result .name').textContent()) ?? '';
}

function gpxFile(name: string, points: Array<[number, number]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfog-fb1-'));
  const t0 = Date.parse('2026-09-02T14:00:00Z');
  const trkpts = points.map((p, i) => `<trkpt lat="${p[1]}" lon="${p[0]}"><time>${new Date(t0 + i * 15_000).toISOString()}</time></trkpt>`).join('');
  const file = path.join(dir, name);
  fs.writeFileSync(file, `<?xml version="1.0"?><gpx version="1.1" creator="fb1"><trk><name>${name}</name><trkseg>${trkpts}</trkseg></trk></gpx>`);
  return file;
}

test.use({ locale: 'en-US' });

// ================================================================ 1. live fog

for (const layer of ['fog', 'heat'] as const) {
  test(`1. ${layer} follows a recording live: the trail clears within seconds, without Stop or a layer toggle`, async ({ page, context }) => {
    const b = await boot(page, layer === 'heat' ? () => localStorage.setItem('unfog.settings', JSON.stringify({ layer: 'heat' })) : undefined);
    await expect(page.locator('.top .seg button.on')).toHaveText(layer === 'heat' ? 'Heat' : 'Fog');
    await context.setGeolocation({ longitude: BEDFORD_N7[0], latitude: BEDFORD_N7[1], accuracy: 5 });
    await hideLabels(page);
    await setTracking(page, true);
    await expect(page.locator('.track-pill')).toHaveText(/^Tracking/, { timeout: 20_000 });
    // Six fixes along N 7th St (~115 m); follow mode keeps the walker centred at zoom 16, so the
    // start point ends up ~130 px from the centre — on screen, away from the user dot.
    await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.map.setFollow(true, 16));
    await walk(context, page, BEDFORD_N7, N7_STEP, 6);
    await tilesSettled(page);
    expect(await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.getZoom()), 'follow zoom reached 16 (a fix mid-ease no longer cuts the zoom short)').toBeCloseTo(16, 1);
    const url0 = await overlayUrl(page);
    expect(url0).toMatch(new RegExp(`^${layer}://`));
    const start = await project(page, BEDFORD_N7);
    const dot = await project(page, [BEDFORD_N7[0] + 6 * N7_STEP[0], BEDFORD_N7[1] + 6 * N7_STEP[1]]);
    expect(Math.hypot(start.x - dot.x, start.y - dot.y), 'start point is clear of the user dot').toBeGreaterThan(60);
    // A never-visited reference 150 px west of the start (still N 7th St's block), and the start itself.
    const ref = { x: start.x - 150, y: start.y };
    const lumaRef = await pixelLuma(page, ref.x, ref.y);
    const luma0 = await pixelLuma(page, start.x, start.y);
    const req0 = await perfRequested(page);
    test.info().annotations.push({ type: `${layer}-before`, description: `start ${luma0.toFixed(0)} ref ${lumaRef.toFixed(0)} requested ${req0}` });

    // The checkpoint (≤ 5 s) marks the trail and the overlay re-renders the touched tiles in place:
    // the trail pixel changes (fog lifts / heat glows) while the map is not moving and no control
    // was touched. The layer control stays where it is.
    await expect
      .poll(async () => Math.abs((await pixelLuma(page, start.x, start.y)) - luma0), { timeout: 15_000, message: 'trail pixel changes after a checkpoint' })
      .toBeGreaterThan(25);
    const luma1 = await pixelLuma(page, start.x, start.y);
    const lumaRef1 = await pixelLuma(page, ref.x, ref.y);
    test.info().annotations.push({ type: `${layer}-after`, description: `start ${luma1.toFixed(0)} ref ${lumaRef1.toFixed(0)} requested ${await perfRequested(page)}` });
    if (layer === 'fog') expect(luma1, 'the walked start point is lighter (fog lifted)').toBeGreaterThan(luma0 + 25);
    else expect(luma1, 'the walked start point glows (heat)').toBeGreaterThan(luma0 + 25);
    expect(Math.abs(lumaRef1 - lumaRef), 'an unvisited pixel on the same block is unchanged').toBeLessThan(12);
    expect(await perfRequested(page), 'overlay tiles were re-requested').toBeGreaterThan(req0);
    expect(await isMoving(page)).toBe(false);
    expect(await overlayUrl(page), 'a partial refresh, not a full reload (same tile URL)').toBe(url0);
    await expect(page.locator('.top .seg button.on')).toHaveText(layer === 'heat' ? 'Heat' : 'Fog');
    await shot(page, `live-${layer}`);

    // Keep walking: the next checkpoint clears the next stretch too. Sample a point 3 fixes ahead
    // while it is still untouched, walk past it, and expect it to clear to the same degree as
    // the first stretch (same threshold as above, then within a step of the first stretch's level).
    const mid: [number, number] = [BEDFORD_N7[0] + 6 * N7_STEP[0], BEDFORD_N7[1] + 6 * N7_STEP[1]];
    const ahead: [number, number] = [mid[0] + 3 * N7_STEP[0], mid[1] + 3 * N7_STEP[1]];
    const pA = await project(page, ahead);
    const lumaA0 = await pixelLuma(page, pA.x, pA.y);
    await walk(context, page, mid, N7_STEP, 5);
    await tilesSettled(page);
    const pA2 = await project(page, ahead);
    await expect.poll(async () => Math.abs((await pixelLuma(page, pA2.x, pA2.y)) - lumaA0), { timeout: 15_000, message: 'second stretch changes too' }).toBeGreaterThan(25);
    const lumaA1 = await pixelLuma(page, pA2.x, pA2.y);
    test.info().annotations.push({ type: `${layer}-second-stretch`, description: `ahead ${lumaA0.toFixed(0)} → ${lumaA1.toFixed(0)} (first stretch ${luma0.toFixed(0)} → ${luma1.toFixed(0)})` });
    if (layer === 'fog') expect(lumaA1, 'the second stretch is cleared like the first (not a halo)').toBeGreaterThan(luma1 - 25);
    else expect(lumaA1, 'the second stretch glows like the first').toBeGreaterThan(luma1 - 25);
    // Off: the session is saved quietly (no summary sheet), the pill goes.
    await setTracking(page, false);
    await expect(page.locator('.track-pill')).toBeHidden();
    await expect(page.locator('.sheet.modal')).toHaveCount(0);
    expect(b.errors).toEqual([]);
  });
}

test('1b. fog redraws after an import while the map already shows the area (no toggle, no camera move)', async ({ page }) => {
  const b = await boot(page);
  await page.evaluate((c) => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.jumpTo({ center: c, zoom: 16 }), BEDFORD_N7);
  await tilesSettled(page);
  const centre = await project(page, BEDFORD_N7);
  const luma0 = await pixelLuma(page, centre.x, centre.y);
  // A GPX walk along N 7th St through the map centre.
  const pts: Array<[number, number]> = [];
  for (let i = -6; i <= 6; i++) pts.push([BEDFORD_N7[0] + i * N7_STEP[0], BEDFORD_N7[1] + i * N7_STEP[1]]);
  const summary = await importFiles(page, [gpxFile('n7.gpx', pts)]);
  expect(summary).toMatch(/new cells/);
  await page.getByRole('tab', { name: 'Map' }).click();
  await expect.poll(() => pixelLuma(page, centre.x, centre.y), { timeout: 15_000, message: 'the imported street is cleared' }).toBeGreaterThan(luma0 + 25);
  await expect(page.locator('.top .seg button.on')).toHaveText('Fog');
  await shot(page, 'import-redraw');
  expect(b.errors).toEqual([]);
});

// ================================================================ 2 + 3. off-road legs, straight gaps, route anyway

const DOMINO_PARK = { name: 'Domino Park', locality: 'Williamsburg, Brooklyn', lonlat: [-73.9678, 40.7142] as [number, number] };
/** Mid-East River, ≈450 m from Kent Av and from the FDR greenway: no street within 300 m. */
const EAST_RIVER = { name: 'East River', lonlat: [-73.97, 40.7205] as [number, number], origin: BEDFORD_N7 };
/** Governors Island: paths, but no bridge — a separate component of the walk network. */
const GOVERNORS = { name: 'Governors Island', lonlat: [-74.0169, 40.6895] as [number, number], origin: BEDFORD_N7 };
/** Nelson, BC: no prebuilt region, nothing downloaded → NoCoverageError. */
const NELSON = { name: 'Mill Street', locality: 'Nelson, BC', lonlat: [-117.2831, 49.492] as [number, number], origin: [-117.2964, 49.4927] as [number, number] };

async function openRoute(page: Page, dest: { name: string; locality?: string; lonlat: [number, number]; origin?: [number, number] }): Promise<void> {
  await page.evaluate((d) => (window as unknown as UnfogWindow).__unfog!.openRoute!(d), dest);
  await expect(page.locator('.sheet.route')).toBeVisible();
}

async function waitRouted(page: Page): Promise<Array<{ name: string; st: string }>> {
  const sheet = page.locator('.sheet.route');
  await expect(sheet.locator('.route-status .spinner')).toBeHidden({ timeout: 60_000 });
  await expect(sheet.locator('.route-status .error')).toHaveCount(0);
  await expect(sheet.locator('.cand').first()).toBeVisible({ timeout: 60_000 });
  return sheet.locator('.cand').evaluateAll((rows) => rows.map((r) => ({ name: r.querySelector('.name')?.textContent ?? '', st: r.querySelector('.st')?.textContent ?? '' })));
}

/** Route features on the map by their `dash` property (off-road / straight parts are dashed). */
const routeFeatures = (page: Page) =>
  page.evaluate(() => {
    const map = (window as unknown as { __unfog: { ctx: { map: { map: { querySourceFeatures(s: string): Array<{ properties: { dash: boolean } }> } } } } }).__unfog.ctx.map.map;
    const f = map.querySourceFeatures('unfog-routes');
    return { total: f.length, dashed: f.filter((x) => x.properties.dash).length };
  });

test('2. a pin in the river: no "no street within 300 m" — the route snaps to the shore and ends with a dashed off-path leg', async ({ page }) => {
  const b = await boot(page);
  const res = await page.evaluate((req) => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.route(req), { from: BEDFORD_N7, to: EAST_RIVER.lonlat, mode: 'walk', detour: 0.25 });
  const direct = res.candidates[res.candidates.length - 1];
  const last = direct.parts![direct.parts!.length - 1];
  test.info().annotations.push({ type: 'east-river', description: direct.parts!.map((p) => `${p.kind} ${Math.round(p.lengthM)} m`).join(' | ') });
  expect(last.kind).toBe('offroad');
  expect(last.lengthM).toBeGreaterThan(300);
  expect(last.lengthM).toBeLessThan(1500);
  expect(direct.coords[direct.coords.length - 1]).toEqual(EAST_RIVER.lonlat);
  for (const c of res.candidates) expect(c.parts![c.parts!.length - 1].kind).toBe('offroad');

  await openRoute(page, EAST_RIVER);
  const sheet = page.locator('.sheet.route');
  const cands = await waitRouted(page);
  expect(cands[cands.length - 1].name).toBe('Direct');
  const status = sheet.locator('.route-status');
  await expect(status).toContainText(/[Ee]nds with \d[\d.,]* (m|km) off-path/); // "off-path" since feedback-2 (paths, not roads)
  await expect(status.locator('.error')).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Go' })).toBeEnabled();
  await expect.poll(async () => (await routeFeatures(page)).dashed).toBeGreaterThan(0);
  await idle(page);
  await shot(page, 'offroad-river');
  expect(b.errors).toEqual([]);
});

test('3a. no street network can join the ends (Governors Island): one Direct with a dashed straight gap, never an error', async ({ page }) => {
  const b = await boot(page);
  const res = await page.evaluate((req) => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.route.route(req), { from: BEDFORD_N7, to: GOVERNORS.lonlat, mode: 'walk', detour: 0.25 });
  const kinds = res.candidates[0].parts!.map((p) => p.kind);
  test.info().annotations.push({ type: 'governors', description: res.candidates.map((c) => `${c.name} ${c.lengthM} m: ${c.parts!.map((p) => `${p.kind} ${Math.round(p.lengthM)}`).join(' | ')}`).join(' ; ') });
  expect(res.candidates.map((c) => c.name)).toEqual(['Direct']);
  expect(kinds).toContain('straight');
  expect(kinds).toContain('street');
  expect(res.candidates[0].coords[0]).toEqual(BEDFORD_N7);
  // The pin sits ~11 m from an island path: under OFFROAD_MIN_M, so the route ends on the path itself.
  const end = res.candidates[0].coords[res.candidates[0].coords.length - 1];
  expect(Math.hypot((end[0] - GOVERNORS.lonlat[0]) * 84_300, (end[1] - GOVERNORS.lonlat[1]) * 111_000)).toBeLessThan(13);

  await openRoute(page, GOVERNORS);
  const cands = await waitRouted(page);
  expect(cands.map((c) => c.name)).toEqual(['Direct']);
  await expect(page.locator('.sheet.route .route-status')).toContainText(/straight across a gap/);
  await expect.poll(async () => (await routeFeatures(page)).dashed).toBeGreaterThan(0);
  await idle(page);
  await shot(page, 'gap-governors');
  expect(b.errors).toEqual([]);
});

test('3b. no coverage at all: the download offer also has "Route anyway", which draws the straight line', async ({ page }) => {
  const b = await boot(page);
  await openRoute(page, NELSON);
  const sheet = page.locator('.sheet.route');
  const status = sheet.locator('.route-status');
  await expect(status.locator('.spinner')).toBeHidden({ timeout: 60_000 });
  await expect(status).toContainText('No routing data for this area yet');
  await expect(status.getByRole('button', { name: /Download this area/ })).toBeVisible();
  const anyway = status.getByRole('button', { name: 'Route anyway (straight line)' });
  await expect(anyway).toBeVisible();
  await shot(page, 'no-coverage-offer');
  await anyway.click();
  const cands = await waitRouted(page);
  expect(cands.map((c) => c.name)).toEqual(['Direct']);
  await expect(status).toContainText(/as the crow flies/);
  await expect(sheet.getByRole('button', { name: 'Go' })).toBeEnabled();
  const f = await routeFeatures(page);
  expect(f.dashed).toBeGreaterThan(0);
  expect(f.total).toBe(f.dashed);
  await idle(page);
  await shot(page, 'route-anyway');
  expect(b.errors).toEqual([]);
});

// ================================================================ 4. satellite

/** Walks along Williamsburg streets (same seed as real.spec.ts / the landing capture) for a lived-in fog. */
function williamsburgWalks(seed = 7): Array<{ id: string; source: string; name?: string; points: Array<[number, number]> }> {
  const gz = fs.readFileSync(path.join(here, '..', 'fixtures', 'osm', 'williamsburg.json.gz'));
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
  const tracks: Array<{ id: string; source: string; name?: string; points: Array<[number, number]> }> = [];
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

test('4. Satellite basemap: Esri imagery with OpenFreeMap labels, fog/heat/routes above the photo, dark chrome, persisted', async ({ page }) => {
  const esriRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith('https://server.arcgisonline.com/')) esriRequests.push(r.url());
  });
  const b = await boot(page);
  const tracks = williamsburgWalks();
  await page.evaluate(async (tracks) => {
    const ctx = (window as unknown as { __unfog: { ctx: { engines: { grid: { applyPayload(p: unknown): Promise<{ stats: { version: number } }> }; route: { invalidateCells(v: number): Promise<void> } }; dataChanged(): Promise<void> } } }).__unfog.ctx;
    const r = await ctx.engines.grid.applyPayload({ tracks, meta: { source: 'gpx', fileName: 'walks', items: tracks.length } });
    await ctx.engines.route.invalidateCells(r.stats.version);
    await ctx.dataChanged();
  }, tracks);

  await page.getByRole('tab', { name: 'Help' }).click();
  const settings = page.locator('.help-section', { has: page.locator('summary', { hasText: /^Settings$/ }) });
  await settings.locator('summary').click();
  const basemap = settings.getByRole('group', { name: 'Basemap' });
  await expect(basemap.getByRole('button', { name: 'Map' })).toHaveAttribute('aria-pressed', 'true');
  await basemap.getByRole('button', { name: 'Satellite' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#17181d');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('unfog.settings') ?? '{}'))).toMatchObject({ basemap: 'satellite' });
  await page.getByRole('tab', { name: 'Map' }).click();

  // Imagery source with Esri's credit, labels from the bright style, fog between them.
  await page.waitForFunction(() => {
    const map = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map;
    const st = map.getStyle();
    return st.name === 'unfog-satellite' && Boolean(st.sources.openmaptiles) && Boolean(map.getLayer('unfog-overlay')) && Boolean(map.getSource('unfog-routes'));
  }, null, { timeout: 30_000 });
  const style = await page.evaluate(() => {
    const st = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.getStyle();
    const ids = st.layers.map((l) => l.id);
    return {
      imagery: st.sources['esri-imagery'],
      overlay: ids.indexOf('unfog-overlay'),
      imageryLayer: ids.indexOf('esri-imagery'),
      firstLabel: st.layers.findIndex((l) => l.type === 'symbol'),
      labels: st.layers.filter((l) => l.type === 'symbol').map((l) => l.id),
      fills: st.layers.filter((l) => l.type === 'fill' || l.type === 'line').length,
      routes: ids.indexOf('unfog-routes-sel'),
    };
  });
  test.info().annotations.push({ type: 'satellite-style', description: JSON.stringify({ ...style, labels: style.labels.length }) });
  expect(style.imagery?.type).toBe('raster');
  expect(style.imagery?.tiles?.[0]).toContain('server.arcgisonline.com/ArcGIS/rest/services/World_Imagery');
  expect(style.imagery?.attribution).toContain('Esri');
  expect(style.imagery?.attribution).toContain('Maxar');
  expect(style.labels).toContain('highway-name-minor');
  expect(style.labels).toContain('label_town');
  expect(style.labels.some((id) => /^poi/.test(id))).toBe(false);
  expect(style.fills, 'no vector fills or lines over the photo (route lines excepted)').toBeLessThanOrEqual(7);
  expect(style.overlay).toBeGreaterThan(style.imageryLayer);
  expect(style.overlay).toBeLessThan(style.firstLabel);
  expect(style.routes).toBeGreaterThan(style.overlay);

  // Fog over the photo at Bedford & N 7th; wait for the imagery (the first Esri tile took 4 s here).
  await page.evaluate((c) => (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.jumpTo({ center: c, zoom: 15.3 }), BEDFORD_N7);
  await tilesSettled(page);
  expect(esriRequests.length, 'imagery tiles were requested').toBeGreaterThan(0);
  await shot(page, 'satellite-fog');
  await page.locator('.seg button[data-layer="heat"]').click();
  await tilesSettled(page);
  await shot(page, 'satellite-heat');
  await page.locator('.seg button[data-layer="fog"]').click();
  await openRoute(page, { ...DOMINO_PARK, origin: BEDFORD_N7 });
  const cands = await waitRouted(page);
  expect(cands.length).toBeGreaterThanOrEqual(1);
  await tilesSettled(page);
  await shot(page, 'satellite-route');
  await page.getByRole('button', { name: 'Clear destination' }).click();

  // Survives a reload (imagery + labels again), and Map restores the light chrome.
  await page.reload();
  await page.waitForFunction(() => (window as unknown as UnfogWindow).__unfog?.ready === true, null, { timeout: 90_000 });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.waitForFunction(() => {
    const st = (window as unknown as UnfogWindow).__unfog!.ctx!.map.map.getStyle();
    return st.name === 'unfog-satellite' && Boolean(st.sources.openmaptiles);
  }, null, { timeout: 30_000 });
  await page.getByRole('tab', { name: 'Help' }).click();
  await settings.locator('summary').click();
  await basemap.getByRole('button', { name: 'Map' }).click();
  await expect(page.locator('html')).toHaveClass(/light/);
  expect(b.errors).toEqual([]);
});
