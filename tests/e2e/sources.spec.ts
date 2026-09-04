/**
 * Always-recording sources (AR-1): Data → Sources with the real engines, against doubles for
 * Dropbox (api/content.dropboxapi.com + the OAuth redirect) and for an Overland receiver.
 *
 *   1. Nothing set up: the Fog of World card says "Not set up yet" with the steps (no dead
 *      Connect button); the Overland card offers the URL + token fields.
 *   2. Dropbox: Connect → PKCE redirect → back in the app → the boot pull downloads the two
 *      fixture tiles → 36,983 cells; Pull now with the cursor adds nothing; Disconnect.
 *   3. Overland: paste URL + token → Test OK → Pull now → a day track is listed; a second pull
 *      adds nothing.
 *   4. Help → Always recording describes both; Settings links to Sources.
 *
 * New e2e file (justified in the AR-1 report: a new subsystem with its own network doubles).
 * Hermetic: the only servers are the Vite dev server and page.route.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const shots = path.join(here, 'screenshots');
const FIXTURES = path.join(here, '..', 'fixtures', 'fow');
const TILE_A = '23e4lltkkoke';
const TILE_B = 'cd36lltksiwo';
/** Visited pixels in the two fixture tiles (tests/fixtures/fow/README.md). */
const FOW_CELLS = 36_983;
const APP_KEY = 'e2e-dropbox-app-key';
const RECEIVER = 'https://overland.e2e.test';
const TOKEN = 'e2e-token-0123456789';
const BEDFORD_N7: [number, number] = [-73.9568, 40.7176];

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });

type UnfogWindow = {
  __unfog?: {
    ready: boolean;
    mock: boolean;
    ctx?: {
      engines: { grid: { getStats(): Promise<{ visitedCells: number }>; listTracks(): Promise<Array<{ id: string; source: string; name?: string; points: number }>> } };
      openHelp(section: string): void;
    };
  };
};

async function prepare(page: Page, init?: () => void): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('unfog.installDismissed', String(Date.now()));
    localStorage.setItem('unfog.trackingOffered', String(Date.now()));
  });
  if (init) await page.addInitScript(init);
  return errors;
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as UnfogWindow).__unfog?.ready === true, null, { timeout: 90_000 });
  expect(await page.evaluate(() => (window as unknown as UnfogWindow).__unfog?.mock), 'real engines').toBe(false);
}

const stats = (page: Page) => page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.grid.getStats());
const tracks = (page: Page) => page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.engines.grid.listTracks());

async function openSources(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Data' }).click();
  await expect(page.locator('#screen-data #sources')).toBeVisible();
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, Dropbox-API-Arg',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-expose-headers': 'Dropbox-API-Result',
};

interface DropboxDouble {
  tokenCalls: URLSearchParams[];
  listCalls: Array<{ path?: string; cursor?: string }>;
  downloads: string[];
}

/** api/content.dropboxapi.com + the authorize page (302 straight back with a code). */
async function stubDropbox(page: Page): Promise<DropboxDouble> {
  const d: DropboxDouble = { tokenCalls: [], listCalls: [], downloads: [] };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify(body) });
  await page.route('https://www.dropbox.com/oauth2/authorize**', (route) => {
    const u = new URL(route.request().url());
    expect(u.searchParams.get('client_id')).toBe(APP_KEY);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('token_access_type')).toBe('offline');
    const back = new URL(u.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', 'e2e-code');
    back.searchParams.set('state', u.searchParams.get('state')!);
    return route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await page.route('https://api.dropboxapi.com/**', async (route) => {
    const r = route.request();
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const u = new URL(r.url());
    if (u.pathname === '/oauth2/token') {
      d.tokenCalls.push(new URLSearchParams(r.postData() ?? ''));
      return json(route, { access_token: 'at-e2e-secret', refresh_token: 'rt-e2e-secret', expires_in: 14400, token_type: 'bearer', account_id: 'dbid:e2e', uid: '1' });
    }
    if (u.pathname === '/2/users/get_current_account') return json(route, { account_id: 'dbid:e2e', email: 'jacob@example.com', name: { display_name: 'Jacob' } });
    if (u.pathname === '/2/files/list_folder') {
      const body = JSON.parse(r.postData() ?? '{}') as { path: string };
      d.listCalls.push({ path: body.path });
      const entry = (name: string, tag = 'file') => ({ '.tag': tag, name, path_lower: `/apps/fog of world/sync/${name.toLowerCase()}`, path_display: `/Apps/Fog of World/Sync/${name}`, id: `id:${name}`, rev: 'r1', size: 1000, server_modified: '2026-09-03T10:00:00Z' });
      return json(route, { entries: [entry(TILE_A), entry(TILE_B), entry('FoW-Sync-Lock'), entry('Import', 'folder')], cursor: 'e2e-cursor-1', has_more: false });
    }
    if (u.pathname === '/2/files/list_folder/continue') {
      const body = JSON.parse(r.postData() ?? '{}') as { cursor: string };
      d.listCalls.push({ cursor: body.cursor });
      return json(route, { entries: [], cursor: `${body.cursor}+`, has_more: false });
    }
    return json(route, { error_summary: 'unknown/', error: { '.tag': 'unknown' } }, 409);
  });
  await page.route('https://content.dropboxapi.com/**', async (route) => {
    const r = route.request();
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const arg = JSON.parse(r.headers()['dropbox-api-arg'] ?? '{}') as { path: string };
    const name = arg.path.slice(arg.path.lastIndexOf('/') + 1);
    d.downloads.push(name);
    const file = path.join(FIXTURES, name);
    if (!fs.existsSync(file)) return route.fulfill({ status: 409, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ error_summary: 'path/not_found/', error: { '.tag': 'path', path: { '.tag': 'not_found' } } }) });
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'dropbox-api-result': JSON.stringify({ name }), ...CORS }, body: fs.readFileSync(file) });
  });
  return d;
}

interface ReceiverDouble {
  calls: Array<{ path: string; since: string | null; auth: string | undefined }>;
}

/** A fake Overland receiver with two batches along N 7th St (today), then nothing. */
async function stubReceiver(page: Page): Promise<ReceiverDouble> {
  const d: ReceiverDouble = { calls: [] };
  const now = Date.now();
  const t0 = now - 60 * 60_000;
  const key = (i: number) => `${TOKEN}/${String(t0 + i * 5 * 60_000).padStart(13, '0')}-0000${i}`;
  const walk = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: t0 + (from + i) * 10_000, lon: BEDFORD_N7[0] - (from + i) * 0.0002, lat: BEDFORD_N7[1] + (from + i) * 0.00008, acc: 5, speed: 1.3 }));
  const batches = [
    { key: key(1), received: t0 + 5 * 60_000, points: walk(0, 8) },
    { key: key(2), received: t0 + 10 * 60_000, points: [...walk(8, 6), { t: t0 + 99 * 10_000, lon: BEDFORD_N7[0], lat: BEDFORD_N7[1], acc: 250 }] },
  ];
  await page.route(`${RECEIVER}/**`, async (route) => {
    const r = route.request();
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const u = new URL(r.url());
    const auth = r.headers()['authorization'];
    d.calls.push({ path: u.pathname, since: u.searchParams.get('since'), auth });
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify(body) });
    if (auth !== `Bearer ${TOKEN}`) return json({ result: 'error', error: 'unauthorized' }, 401);
    if (u.pathname === '/status') return json({ result: 'ok', batches: batches.length, latest: batches[1].received });
    if (u.pathname === '/pull') {
      const since = u.searchParams.get('since') ?? '';
      const after = batches.filter((b) => b.key > since);
      return json({ result: 'ok', batches: after, cursor: after.length ? after[after.length - 1].key : since, hasMore: false });
    }
    return json({ result: 'error', error: 'not found' }, 404);
  });
  return d;
}

test.use({ locale: 'en-US' });

test.describe('Always recording — Data → Sources', () => {
  test('1. nothing set up: Fog of World says "Not set up yet" with the steps, no dead button; Overland offers the fields', async ({ page }) => {
    const errors = await prepare(page);
    await page.goto('');
    await waitReady(page);
    await openSources(page);
    const fow = page.locator('.source-card[data-source="fow-dropbox"]');
    await expect(fow).toContainText('Fog of World via Dropbox');
    await expect(fow.locator('.status')).toHaveText('Not set up yet');
    await expect(fow.getByRole('button', { name: 'Connect Dropbox' })).toHaveCount(0);
    await fow.locator('summary', { hasText: 'Steps for the person running Unfog' }).click();
    await expect(fow).toContainText('VITE_DROPBOX_APP_KEY');
    await expect(fow).toContainText('http://localhost:5173/unfog/'); // the exact redirect URI to register
    const ov = page.locator('.source-card[data-source="overland"]');
    await expect(ov.locator('.status')).toHaveText('Not set up yet');
    await expect(ov.getByLabel('Receiver URL')).toBeVisible();
    await expect(ov.getByLabel('Token')).toHaveAttribute('type', 'password');
    await expect(ov.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(ov.getByRole('button', { name: 'Test' })).toHaveCount(0); // nothing to test yet
    // Bad input is refused with a readable message.
    await ov.getByLabel('Receiver URL').fill('http://example.com');
    await ov.getByLabel('Token').fill(TOKEN);
    await ov.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast.error')).toContainText('https://');
    expect(errors).toEqual([]);
  });

  test('2. Dropbox: Connect → PKCE redirect → boot pull imports the changed tiles → 36,983 cells; Pull now with the cursor adds nothing; Disconnect', async ({ page }) => {
    const errors = await prepare(page, () => {
      (window as unknown as { __unfogDropboxAppKey: string }).__unfogDropboxAppKey = 'e2e-dropbox-app-key';
    });
    const dbx = await stubDropbox(page);
    await page.goto('');
    await waitReady(page);
    expect((await stats(page)).visitedCells).toBe(0);
    await openSources(page);
    const fow = page.locator('.source-card[data-source="fow-dropbox"]');
    await expect(fow.locator('.status')).toHaveText('Not connected');
    await expect(fow).toContainText('Settings → Sync → Dropbox');
    await fow.getByRole('button', { name: 'Connect Dropbox' }).click();
    // The authorize double sends the browser straight back with a code; the app finishes the
    // sign-in at boot and lands on Data.
    await expect(page.locator('.toast', { hasText: 'Dropbox connected' })).toBeVisible({ timeout: 60_000 });
    await waitReady(page);
    expect(page.url()).not.toMatch(/[?&]code=/); // the OAuth parameters are gone from the URL
    expect(dbx.tokenCalls).toHaveLength(1);
    expect(dbx.tokenCalls[0].get('grant_type')).toBe('authorization_code');
    expect(dbx.tokenCalls[0].get('code')).toBe('e2e-code');
    expect(dbx.tokenCalls[0].get('code_verifier')).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(dbx.tokenCalls[0].has('client_secret')).toBe(false);
    await expect(page.locator('#screen-data')).toBeVisible();
    await expect(fow.locator('.status')).toHaveText('Connected · jacob@example.com');
    // The boot pull: list → 2 tiles downloaded → cells on the map.
    await expect(fow.locator('.st')).toContainText('2 tiles · 36,983 cells added', { timeout: 60_000 });
    await expect(page.locator('.toast', { hasText: 'Fog of World via Dropbox: 36,983 new cells' })).toBeVisible();
    expect((await stats(page)).visitedCells).toBe(FOW_CELLS);
    expect(dbx.listCalls[0]).toEqual({ path: '/Apps/Fog of World/Sync' });
    expect(dbx.downloads.sort()).toEqual([TILE_A, TILE_B]);
    await expect(fow).toContainText('36,983 cells from Dropbox so far');
    // Tokens are stored but never shown.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('unfog.dropbox') ?? '{}').accessToken)).toBe('at-e2e-secret');
    await expect(page.locator('#screen-data')).not.toContainText('e2e-secret');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('unfog.fowDropbox') ?? '{}').cursor)).toBe('e2e-cursor-1');
    await shot(page, 'ar1-sources');

    // Pull now: continue with the cursor → nothing changed → no downloads, cursor advanced.
    await fow.getByRole('button', { name: 'Pull now' }).click();
    await expect(fow.locator('.st')).toContainText('nothing new', { timeout: 30_000 });
    expect(dbx.listCalls[dbx.listCalls.length - 1]).toEqual({ cursor: 'e2e-cursor-1' });
    expect(dbx.downloads).toHaveLength(2);
    expect((await stats(page)).visitedCells).toBe(FOW_CELLS);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('unfog.fowDropbox') ?? '{}').cursor)).toBe('e2e-cursor-1+');
    // The map shows the imported area (stat chip), like a file import would.
    await page.getByRole('tab', { name: 'Map' }).click();
    await expect(page.locator('.stat-chip .sub')).toHaveText('36,983 cells');
    // Disconnect forgets the sign-in; cells stay.
    await openSources(page);
    await fow.getByRole('button', { name: 'Disconnect' }).click();
    await page.locator('.sheet.modal').getByRole('button', { name: 'Disconnect' }).click();
    await expect(fow.locator('.status')).toHaveText('Not connected');
    expect(await page.evaluate(() => localStorage.getItem('unfog.dropbox'))).toBeNull();
    expect((await stats(page)).visitedCells).toBe(FOW_CELLS);
    expect(errors).toEqual([]);
  });

  test('3. Overland: paste URL + token → Test OK → Pull now → a day track is listed; the second pull adds nothing', async ({ page }) => {
    const errors = await prepare(page);
    const rx = await stubReceiver(page);
    await page.goto('');
    await waitReady(page);
    await openSources(page);
    const ov = page.locator('.source-card[data-source="overland"]');
    await ov.getByLabel('Receiver URL').fill(`${RECEIVER}/`);
    await ov.getByLabel('Token').fill(TOKEN);
    await ov.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast', { hasText: 'Overland receiver saved' })).toBeVisible();
    await expect(ov.locator('.status')).toHaveText(`Receiver overland.e2e.test · token e2e-…6789`);
    await expect(ov).not.toContainText(TOKEN); // masked
    await ov.getByRole('button', { name: 'Test' }).click();
    await expect(page.locator('.toast.success')).toContainText('Receiver OK — 2 batches stored, latest');
    await expect(ov).toContainText('Receiver OK');
    expect(rx.calls[0]).toMatchObject({ path: '/status', auth: `Bearer ${TOKEN}` });

    const before = (await stats(page)).visitedCells;
    await ov.getByRole('button', { name: 'Pull now' }).click();
    await expect(ov.locator('.st').first()).toContainText('2 batches · 14 points', { timeout: 30_000 }); // 15 points, one dropped (250 m accuracy)
    await expect(page.locator('.toast', { hasText: 'Overland: 14 new points on the map' })).toBeVisible();
    const row = ov.locator('.row-item');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/^Overland \d{4}-\d{2}-\d{2}/);
    await expect(row).toContainText('14 points');
    const ts = (await tracks(page)).filter((t) => t.source === 'overland');
    expect(ts).toHaveLength(1);
    expect(ts[0].id).toMatch(/^overland-\d{8}$/);
    expect(ts[0].points).toBe(14);
    const after = (await stats(page)).visitedCells;
    expect(after).toBeGreaterThan(before + 10);
    expect(rx.calls.filter((c) => c.path === '/pull').map((c) => c.since)).toEqual(['']);
    await shot(page, 'ar1-overland');

    // Second pull: the cursor is the last key → nothing new, the track untouched.
    await ov.getByRole('button', { name: 'Pull now' }).click();
    await expect(ov.locator('.st').first()).toContainText('nothing new', { timeout: 30_000 });
    const pulls = rx.calls.filter((c) => c.path === '/pull');
    expect(pulls).toHaveLength(2);
    expect(pulls[1].since).toMatch(new RegExp(`^${TOKEN}/\\d{13}-00002$`));
    expect((await stats(page)).visitedCells).toBe(after);
    expect((await tracks(page)).filter((t) => t.source === 'overland')).toHaveLength(1);
    // Stats lists the source.
    await page.getByRole('tab', { name: 'Stats' }).click();
    await expect(page.locator('#screen-stats')).toContainText('Overland');
    // The settings survive a reload and the boot pull runs again (nothing new).
    await page.reload();
    await waitReady(page);
    await expect.poll(() => rx.calls.filter((c) => c.path === '/pull').length, { timeout: 30_000 }).toBe(3);
    await openSources(page);
    await expect(ov.locator('.status')).toContainText('overland.e2e.test');
    expect(errors).toEqual([]);
  });

  test('4. Help → Always recording explains both paths; Settings links to Sources', async ({ page }) => {
    const errors = await prepare(page);
    await page.goto('');
    await waitReady(page);
    await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.openHelp('always'));
    const always = page.locator('#help-always');
    await expect(always).toHaveAttribute('open', '');
    await expect(always).toContainText('Fog of World via Dropbox');
    await expect(always).toContainText('Overland');
    await expect(always).toContainText('every time you open Unfog');
    await expect(always).not.toContainText('is coming');
    await shot(page, 'ar1-help');
    await page.evaluate(() => (window as unknown as UnfogWindow).__unfog!.ctx!.openHelp('settings'));
    await page.locator('#help-settings').getByRole('button', { name: 'Sources' }).click();
    await expect(page.locator('#screen-data #sources')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
