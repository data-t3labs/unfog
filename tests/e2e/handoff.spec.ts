/**
 * Google Maps hand-off (feedback-3): the route sheet's Open in Google Maps / Apple Maps / Save GPX
 * on the real NYC graph. Own file (real.spec.ts was being edited by another round at the time):
 * a short route from the device's position, a long one that opens in parts, the loop sheet, and
 * the click itself — the popup's URL is checked with https://www.google.com stubbed by
 * context.route (external HTTPS is not reachable from the test machine).
 */
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const shots = path.join(here, 'screenshots');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `fb3-${name}.png`), fullPage: false });

const BEDFORD_N7: [number, number] = [-73.9568, 40.7176];
const DOMINO_PARK = { name: 'Domino Park', locality: 'Williamsburg, Brooklyn', lonlat: [-73.9678, 40.7142] as [number, number] };
const TIMES_SQ: [number, number] = [-73.9855, 40.758];
const PROSPECT_PARK = { name: 'Prospect Park', locality: 'Brooklyn', lonlat: [-73.969, 40.6602] as [number, number], origin: TIMES_SQ };

/** LAT,LNG at exactly 5 decimals. */
const COORD5 = /^-?\d+\.\d{5},-?\d+\.\d{5}$/;
const GOOGLE_MAX_WAYPOINTS = 9;
const GOOGLE_MAX_URL_LENGTH = 2048;

type UnfogWindow = {
  __unfog?: {
    ready: boolean;
    mock: boolean;
    openRoute?: (d: { name: string; locality?: string; lonlat: [number, number]; origin?: [number, number] }) => void;
    openLoop?: (from?: [number, number]) => void;
  };
};

// ---------------------------------------------------------------- helpers (a minimal copy of real.spec.ts's)

async function boot(page: Page, opts: { share?: 'none' } = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('unfog.installDismissed', String(Date.now()));
    localStorage.setItem('unfog.trackingOffered', String(Date.now()));
  });
  if (opts.share === 'none') {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    });
  }
  await page.goto('');
  await page.waitForFunction(() => (window as unknown as UnfogWindow).__unfog?.ready === true, null, { timeout: 90_000 });
  expect(await page.evaluate(() => (window as unknown as UnfogWindow).__unfog?.mock), 'real engines (not mock mode)').toBe(false);
  expect(errors, 'no uncaught page errors during boot').toEqual([]);
  return errors;
}

async function openRoute(page: Page, dest: { name: string; locality?: string; lonlat: [number, number]; origin?: [number, number] }): Promise<void> {
  await page.evaluate((d) => (window as unknown as UnfogWindow).__unfog!.openRoute!(d), dest);
  await expect(page.locator('.sheet.route')).toBeVisible();
}

/** Wait for a (re)route to finish: the spinner is gone, no error, at least one candidate row. */
async function waitRouted(page: Page): Promise<void> {
  const sheet = page.locator('.sheet.route');
  await expect(sheet.locator('.route-status .spinner')).toBeHidden({ timeout: 90_000 });
  await expect(sheet.locator('.route-status .error')).toHaveCount(0);
  await expect(sheet.locator('.cand').first()).toBeVisible({ timeout: 60_000 });
}

/** Every Google Maps link of the sheet in order: part 1 (or the only one) first. */
const googleLinks = (page: Page) => page.locator('.sheet.route .handoff a.gmaps, .sheet.route .handoff a.part');

/** Parse a Directions URL and check the rules every part must follow; returns the parsed URL. */
function expectDirectionsUrl(href: string): URL {
  expect(href.length).toBeLessThan(GOOGLE_MAX_URL_LENGTH);
  const u = new URL(href);
  expect(u.protocol).toBe('https:');
  expect(u.host).toBe('www.google.com');
  expect(u.pathname).toBe('/maps/dir/');
  expect(u.searchParams.get('api')).toBe('1');
  expect(u.searchParams.get('travelmode')).toBe('walking');
  expect(u.searchParams.get('dir_action')).toBe('navigate');
  expect(u.searchParams.get('destination')).toMatch(COORD5);
  const origin = u.searchParams.get('origin');
  if (origin !== null) expect(origin).toMatch(COORD5);
  const wp = u.searchParams.get('waypoints');
  if (wp !== null) {
    expect(href, 'waypoints are separated by %7C').toContain('%7C');
    const list = wp.split('|');
    expect(list.length).toBeLessThanOrEqual(GOOGLE_MAX_WAYPOINTS);
    for (const w of list) expect(w).toMatch(COORD5);
  }
  return u;
}

/**
 * The repo's touch-target convention for small buttons (src/style.css): a 36 px button whose
 * ::after extends the hit area to 48 px. Assert both the box and the extension.
 */
async function expectTapTarget(link: Locator): Promise<void> {
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  const after = await link.evaluate((e) => parseFloat(getComputedStyle(e, '::after').height));
  expect(after, 'a 44 px+ touch target (::after extension)').toBeGreaterThanOrEqual(44);
}

/** A `LAT,LNG` parameter within ~2 m of a [lon, lat] pin. */
function expectNear(latLng: string, pin: [number, number]): void {
  const [lat, lng] = latLng.split(',').map(Number);
  expect(Math.abs(lat - pin[1]), `${latLng} vs ${pin[1]},${pin[0]}`).toBeLessThan(2e-5);
  expect(Math.abs(lng - pin[0]), `${latLng} vs ${pin[1]},${pin[0]}`).toBeLessThan(2e-5);
}

/** Stub Google so the popup loads something; external HTTPS is unreachable here. */
async function stubGoogle(context: BrowserContext): Promise<string[]> {
  const hits: string[] = [];
  await context.route('https://www.google.com/**', (r) => {
    hits.push(r.request().url());
    return r.fulfill({ body: 'stub', contentType: 'text/html' });
  });
  return hits;
}

// ================================================================ tests

test.use({ locale: 'en-US' });

test.describe('Google Maps hand-off', () => {
  test('short route from the device: Open in Google Maps is a Directions URL without an origin; Apple Maps and Save GPX beside it; the tap opens Google', async ({ page, context }) => {
    const errors = await boot(page, { share: 'none' });
    const hits = await stubGoogle(context);
    await openRoute(page, DOMINO_PARK);
    await waitRouted(page);
    const sheet = page.locator('.sheet.route');
    await expect(sheet.locator('.route-status')).not.toContainText('map centre'); // origin = the user's position
    const handoff = sheet.locator('.handoff');
    await expect(handoff).toBeVisible();

    // The Google Maps link: a Directions URL, in a new tab (iOS hands it to the Google Maps app).
    const gm = handoff.locator('a.gmaps');
    await expect(gm).toBeVisible();
    await expect(gm).toHaveText('Google Maps');
    await expect(gm).toHaveAttribute('target', '_blank');
    await expect(gm).toHaveAttribute('rel', /noopener/);
    await expectTapTarget(gm);
    // One row under Go: Google Maps, Apple Maps, Save GPX — the sheet must not grow past what the map fit can afford.
    await expect(handoff.locator('.row')).toHaveCount(1);
    expect((await handoff.boundingBox())!.height, 'the hand-off adds one compact row').toBeLessThanOrEqual(48);
    const u = expectDirectionsUrl((await gm.getAttribute('href'))!);
    expect(u.searchParams.get('origin'), 'the route starts where the phone is: no origin, Google uses the device').toBeNull();
    expect(u.searchParams.get('waypoints'), 'a 1.3 km Williamsburg route has corners').not.toBeNull();
    await expect(handoff.locator('a.part')).toHaveCount(0); // one part — no part buttons, no note
    await expect(handoff.locator('.note')).toHaveCount(0);

    // Apple Maps: walking directions to the destination only, from the device.
    const am = handoff.locator('a.amaps');
    await expect(am).toBeVisible();
    await expect(am).toHaveAttribute('target', '_blank');
    const a = new URL((await am.getAttribute('href'))!);
    expect(a.host).toBe('maps.apple.com');
    expect(a.searchParams.get('daddr')).toMatch(COORD5);
    expect(a.searchParams.get('daddr')).toBe(`${DOMINO_PARK.lonlat[1].toFixed(5)},${DOMINO_PARK.lonlat[0].toFixed(5)}`);
    expect(a.searchParams.get('dirflg')).toBe('w');
    expect(a.searchParams.get('saddr')).toBeNull();
    await shot(page, 'handoff');

    // Tapping the link opens a new page at Google's Directions URL.
    const [popup] = await Promise.all([context.waitForEvent('page'), gm.click()]);
    await popup.waitForLoadState();
    expect(popup.url()).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\//);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]).toBe(await gm.getAttribute('href'));
    await popup.close();
    await expect(sheet).toBeVisible(); // the sheet is untouched

    // Save GPX (no navigator.share here → <a download>): the route as a GPX track named after the place.
    const [download] = await Promise.all([page.waitForEvent('download'), handoff.getByRole('button', { name: 'Save GPX' }).click()]);
    expect(download.suggestedFilename()).toBe('unfog-route-domino-park.gpx');
    const gpx = fs.readFileSync((await download.path())!, 'utf8');
    expect(gpx).toContain('<gpx version="1.1" creator="Unfog"');
    expect(gpx).toContain('<trk>');
    expect((gpx.match(/<trkpt /g) ?? []).length).toBeGreaterThan(5);
    await expect(page.locator('.toast.success')).toContainText('GPX downloaded');

    // Picking another candidate re-renders the link for that route.
    const before = await gm.getAttribute('href');
    await sheet.locator('.cand').last().click();
    await expect(sheet.locator('.cand.on .name')).toHaveText('Direct');
    await expect(handoff.locator('a.gmaps')).toBeVisible();
    expectDirectionsUrl((await handoff.locator('a.gmaps').getAttribute('href'))!);
    test.info().annotations.push({ type: 'href-changed', description: String(before !== (await handoff.locator('a.gmaps').getAttribute('href'))) });

    // A route planned from the map centre names its origin (Google must not start from the phone).
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
    // Opening the next sheet hides the previous route's links in the same tick (before any routing
    // can resolve), so a stale "Open in Google Maps" never shows while the new route computes.
    const hiddenWhilePending = await page.evaluate((d) => {
      (window as unknown as UnfogWindow).__unfog!.openRoute!(d);
      return (document.querySelector('.sheet.route .handoff') as HTMLElement).hidden;
    }, { ...DOMINO_PARK, origin: BEDFORD_N7 });
    expect(hiddenWhilePending, 'no stale links from the previous route while the new one computes').toBe(true);
    await expect(sheet).toBeVisible();
    await waitRouted(page);
    await expect(sheet.locator('.route-status')).toContainText('map centre');
    const u2 = expectDirectionsUrl((await handoff.locator('a.gmaps').getAttribute('href'))!);
    expect(u2.searchParams.get('origin')).toMatch(COORD5);
    const a2 = new URL((await handoff.locator('a.amaps').getAttribute('href'))!);
    expect(a2.searchParams.get('saddr')).toMatch(COORD5);
    expect(errors).toEqual([]);
  });

  test('long route (Times Square → Prospect Park, ~12 km): opens in ≥ 2 parts whose URLs chain end to start', async ({ page, context }) => {
    const errors = await boot(page);
    await stubGoogle(context);
    await openRoute(page, PROSPECT_PARK);
    await waitRouted(page);
    const sheet = page.locator('.sheet.route');
    const handoff = sheet.locator('.handoff');
    await expect(handoff).toBeVisible();
    const links = googleLinks(page);
    const n = await links.count();
    expect(n, 'a 12 km walk needs more than 9 checkpoints').toBeGreaterThanOrEqual(2);
    await expect(links.first()).toHaveText(new RegExp(`^1 of ${n} · \\d+(\\.\\d)? km$`));
    await expect(links.first()).toHaveAttribute('aria-label', new RegExp(`^Google Maps, Part 1 of ${n}, `));
    await expect(links.nth(1)).toHaveText(new RegExp(`^2 of ${n} · \\d+(\\.\\d)? km$`));
    await expect(handoff.locator('.note')).toHaveText(`Google Maps: ${n} parts (9 checkpoints per trip).`);
    // Two rows (parts; Apple Maps + Save GPX) and a one-line note: the block stays under ~110 px for two parts.
    await expect(handoff.locator('.row')).toHaveCount(2);
    if (n === 2) expect((await handoff.boundingBox())!.height, 'two parts share one line').toBeLessThanOrEqual(110);
    const urls: URL[] = [];
    for (let i = 0; i < n; i++) {
      const link = links.nth(i);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
      await expectTapTarget(link);
      urls.push(expectDirectionsUrl((await link.getAttribute('href'))!));
    }
    // From the map centre (an explicit origin): every part names its origin, and they chain.
    for (let i = 0; i < n; i++) {
      expect(urls[i].searchParams.get('origin'), `part ${i + 1} origin`).toMatch(COORD5);
      if (i > 0) expect(urls[i].searchParams.get('origin'), `part ${i + 1} starts where part ${i} ends`).toBe(urls[i - 1].searchParams.get('destination'));
    }
    // The route's first/last vertices are the pins (to within the engine's ~1 m coordinate rounding).
    expectNear(urls[0].searchParams.get('origin')!, TIMES_SQ);
    expectNear(urls[n - 1].searchParams.get('destination')!, PROSPECT_PARK.lonlat);
    test.info().annotations.push({ type: 'parts', description: urls.map((u) => `${u.searchParams.get('waypoints')?.split('|').length ?? 0} wp, ${u.href.length} chars`).join(' | ') });
    await shot(page, 'parts');

    // Part 2 opens like part 1.
    const [popup] = await Promise.all([context.waitForEvent('page'), links.nth(1).click()]);
    await popup.waitForLoadState();
    expect(popup.url()).toBe(urls[1].href);
    await popup.close();
    expect(errors).toEqual([]);
  });

  test('loop sheet: Google Maps and Save GPX, no Apple Maps (a round trip has no destination)', async ({ page }) => {
    const errors = await boot(page);
    await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.openLoop!());
    const sheet = page.locator('.sheet.route.loop');
    await expect(sheet).toBeVisible();
    await waitRouted(page);
    const handoff = sheet.locator('.handoff');
    await expect(handoff).toBeVisible();
    const links = googleLinks(page);
    expect(await links.count()).toBeGreaterThanOrEqual(1);
    const u = expectDirectionsUrl((await links.first().getAttribute('href'))!);
    expect(u.searchParams.get('origin'), 'a loop from the phone: no origin').toBeNull();
    await expect(handoff.locator('a.amaps')).toHaveCount(0);
    await expect(handoff.getByRole('button', { name: 'Save GPX' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
