/**
 * Smoke test in mock mode (`?mock=1`): the app boots, the map renders, the layer toggle works,
 * search opens, a route sheet shows candidates, Data/Help open. Screenshots land in
 * tests/e2e/screenshots/ at the iPhone 15 viewport (393×852, DPR 3) for visual review.
 */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const shots = path.join(path.dirname(new URL(import.meta.url).pathname), 'screenshots');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });

// The app exposes window.__unfog once the map is idle (src/main.ts); the shape is duplicated here
// as a structural type so the spec stays independent of the app's global declaration.
type UnfogWindow = Window & {
  __unfog?: {
    ready: boolean;
    mock: boolean;
    openRoute?: (d: { name: string; locality?: string; lonlat: [number, number] }) => void;
    openLoop?: (from?: [number, number]) => void;
    ctx?: {
      map: {
        map: {
          loaded(): boolean;
          isMoving(): boolean;
          once(ev: 'idle', cb: () => void): unknown;
          getLayoutProperty(layer: string, prop: string): unknown;
          querySourceFeatures(source: string): unknown[];
        };
      };
    };
  };
};

async function boot(page: Page, opts: { installCard?: boolean } = {}): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (!opts.installCard) {
    // The iPhone UA triggers the Safari install card; pre-dismiss it so the map chrome is unobstructed.
    await page.addInitScript(() => localStorage.setItem('unfog.installDismissed', String(Date.now())));
  }
  await page.goto('?mock=1');
  await page.waitForFunction(() => (window as UnfogWindow).__unfog?.ready === true, null, { timeout: 90_000 });
  expect(errors, 'no uncaught page errors during boot').toEqual([]);
}

/** Wait until MapLibre has nothing left to load/render (overlay tiles included). */
async function idle(page: Page): Promise<void> {
  await page.waitForTimeout(400);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = (window as UnfogWindow).__unfog?.ctx?.map.map;
        if (!map) return resolve();
        if (map.loaded() && !map.isMoving()) return resolve();
        map.once('idle', () => resolve());
      }),
  );
  await page.waitForTimeout(150);
}

test.describe('Unfog smoke (mock engines)', () => {
  test('boots with a map, fog overlay and chrome', async ({ page }) => {
    await boot(page);
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search destination' })).toBeVisible();
    await expect(page.locator('.seg button.on')).toHaveText('Fog');
    await expect(page.locator('.stat-chip .val')).not.toHaveText(/—|…/);
    await expect(page.locator('.stat-chip .big')).toContainText('explored');
    await expect(page.locator('.stat-chip .sub')).toContainText(/\d cells$/);
    // Toasts sit above the bottom chrome, never over a button (the mock-mode toast is up at boot).
    const toast = page.locator('.toast');
    if (await toast.count()) {
      const t = await toast.first().boundingBox();
      const chip = await page.locator('.stat-chip').boundingBox();
      const search = await page.locator('.search').boundingBox();
      expect(t!.y + t!.height).toBeLessThanOrEqual(chip!.y);
      expect(t!.y).toBeGreaterThanOrEqual(search!.y + search!.height);
    }
    await idle(page);
    await shot(page, 'fog');
  });

  test('layer toggle: Heat shows the legend, Off hides the overlay', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Heat' }).click();
    await expect(page.locator('.seg button.on')).toHaveText('Heat');
    await expect(page.locator('.legend')).toBeVisible();
    await idle(page);
    await shot(page, 'heat');
    await page.getByRole('button', { name: 'Off' }).click();
    await expect(page.locator('.legend')).toBeHidden();
    const visibility = await page.evaluate(() => (window as UnfogWindow).__unfog?.ctx?.map.map.getLayoutProperty('unfog-overlay', 'visibility'));
    expect(visibility).toBe('none');
    await page.getByRole('button', { name: 'Fog' }).click();
  });

  test('search opens and the route sheet renders candidates', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Search destination' }).click();
    await expect(page.locator('.search-panel')).toBeVisible();
    await expect(page.locator('.search-input')).toBeFocused();
    await expect(page.getByRole('option', { name: /Current location/ })).toBeVisible();
    await shot(page, 'search');
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('.search-panel')).toBeHidden();

    // Destination via the test hook (the same call a Photon result or a long-press makes).
    await page.evaluate(() => (window as UnfogWindow).__unfog?.openRoute?.({ name: 'Domino Park', locality: 'Williamsburg, Brooklyn', lonlat: [-73.9678, 40.7142] }));
    const sheet = page.locator('.sheet.route');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('h2')).toContainText('Domino Park');
    await expect(sheet.locator('.cand')).toHaveCount(3, { timeout: 30_000 });
    await expect(sheet.locator('.cand.on .name')).toHaveText('Most new');
    await expect(sheet.locator('.cand').last().locator('.name')).toHaveText('Direct');
    await expect(sheet.locator('.cand.on .new')).toContainText('% new');
    await expect(page.locator('.search .val')).toHaveText('Domino Park');
    const routeFeatures = await page.evaluate(() => (window as UnfogWindow).__unfog?.ctx?.map.map.querySourceFeatures('unfog-routes').length ?? 0);
    expect(routeFeatures).toBeGreaterThan(0);
    await idle(page);
    await shot(page, 'route');

    // Mode + slider re-route; Go collapses to the follow bar; End restores the chrome.
    await sheet.getByRole('button', { name: 'Bike' }).click();
    await expect(sheet.locator('.cand').first()).toBeVisible({ timeout: 30_000 });
    await sheet.getByRole('button', { name: 'Go' }).click();
    await expect(page.locator('.follow-bar')).toBeVisible();
    await expect(sheet).toBeHidden();
    await page.locator('.follow-bar').getByRole('button', { name: 'End' }).click();
    await expect(page.locator('.follow-bar')).toBeHidden();
    await expect(page.locator('.search .ph')).toHaveText('Where to?');
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
  });

  test('loop mode: "Explore a loop from here" lists loops, chips + slider re-run, Go/End', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Search destination' }).click();
    await page.getByRole('option', { name: /Explore a loop from here/ }).click();
    await expect(page.locator('.search-panel')).toBeHidden();
    const sheet = page.locator('.sheet.route.loop');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('h2')).toContainText('Explore from here');
    await expect(sheet.locator('.chips button')).toHaveCount(4);
    await expect(sheet.locator('.chips button.on')).toHaveText('3 km');
    await expect(sheet.locator('.cand').first()).toBeVisible({ timeout: 30_000 });
    const n = await sheet.locator('.cand').count();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
    await expect(sheet.locator('.cand.on .name')).toHaveText('Loop A');
    const names = await sheet.locator('.cand .name').allTextContents();
    expect(names).toEqual(['Loop A', 'Loop B', 'Loop C'].slice(0, n));
    await expect(sheet.locator('.cand.on .st')).toContainText(/km · \d+ min/);
    await expect(sheet.locator('.cand.on .new')).toContainText('% new');
    await expect(page.locator('.search .val')).toHaveText('Loop from here');
    const routeFeatures = await page.evaluate(() => (window as UnfogWindow).__unfog?.ctx?.map.map.querySourceFeatures('unfog-routes').length ?? 0);
    expect(routeFeatures).toBeGreaterThan(0);
    await idle(page);
    await shot(page, 'loop');

    // A length chip re-runs; the slider follows; the choice persists.
    await sheet.getByRole('button', { name: '5 km' }).click();
    await expect(sheet.locator('.chips button.on')).toHaveText('5 km');
    await expect(sheet.getByLabel('Loop length', { exact: true })).toHaveValue('5');
    await expect(sheet.locator('.cand').first()).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('unfog.routePrefs') ?? '{}'))).toMatchObject({ loopKm: 5 });
    await sheet.getByLabel('Loop length', { exact: true }).fill('8');
    await expect(sheet.locator('.chips button.on')).toHaveText('8 km');
    await sheet.getByLabel('Loop length', { exact: true }).fill('4.5');
    await expect(sheet.locator('.chips button.on')).toHaveCount(0);
    await expect(sheet.locator('.slider-loop')).toContainText('4.5 km');

    // Go collapses to the follow bar naming the loop; End restores the chrome.
    await expect(sheet.locator('.cand').first()).toBeVisible({ timeout: 30_000 });
    await sheet.getByRole('button', { name: 'Go' }).click();
    const bar = page.locator('.follow-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Loop A');
    await expect(bar).toContainText('round trip from here');
    await bar.getByRole('button', { name: 'End' }).click();
    await expect(bar).toBeHidden();
    await expect(page.locator('.search .ph')).toHaveText('Where to?');
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
  });

  test('Data, Stats and Help screens open', async ({ page }) => {
    await boot(page);
    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.locator('#screen-data')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import files' })).toBeVisible();
    await expect(page.locator('#screen-data .row-item').first()).toBeVisible();
    // A toast on this screen must stay below every button (above the tab bar), not over Import files.
    const toast = page.locator('.toast');
    if (await toast.count()) {
      const t = await toast.first().boundingBox();
      const importBtn = await page.getByRole('button', { name: 'Import files' }).boundingBox();
      const tabs = await page.locator('.tabs').boundingBox();
      expect(t!.y).toBeGreaterThan(importBtn!.y + importBtn!.height);
      expect(t!.y + t!.height).toBeLessThanOrEqual(tabs!.y);
    }
    await shot(page, 'data');

    await page.getByRole('tab', { name: 'Stats' }).click();
    await expect(page.locator('#screen-stats .stat.big .v')).not.toHaveText('');
    await shot(page, 'stats');

    await page.getByRole('tab', { name: 'Help' }).click();
    await expect(page.locator('#screen-help')).toBeVisible();
    await page.locator('.help-section summary').first().click();
    await expect(page.locator('#screen-help .steps').first()).toBeVisible();
    await shot(page, 'help');

    await page.getByRole('tab', { name: 'Map' }).click();
    await expect(page.locator('#screen-help')).toBeHidden();
  });

  test('install card shows on iOS Safari (not standalone) and can be dismissed', async ({ page }) => {
    await boot(page, { installCard: true });
    const card = page.locator('.install-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Add to Home Screen');
    // The stat chip and Record must stay reachable above the card.
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
    await idle(page);
    await shot(page, 'install');
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(card).toBeHidden();
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.locator('.rec-banner')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.locator('.record-summary')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Done' }).click();
  });

  test('recording starts and stops with a summary', async ({ page, context }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.locator('.rec-banner')).toBeVisible({ timeout: 20_000 });
    await context.setGeolocation({ longitude: -73.9572, latitude: 40.7179 });
    await page.waitForTimeout(800);
    await context.setGeolocation({ longitude: -73.9578, latitude: 40.7183 });
    await page.waitForTimeout(800);
    await shot(page, 'recording');
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.locator('.record-summary')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.record-summary h2')).toContainText(/recorded/);
    await shot(page, 'summary');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.record-summary')).toBeHidden();
  });
});
