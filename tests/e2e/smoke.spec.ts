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

  // ux-1 review (first-run UX + accessibility): touch targets, state for assistive tech, a visible
  // selection in the light-theme segmented controls, Dynamic-Type-ready type scale, reduced motion.
  test('accessibility: 44 px targets, aria state, light-theme settings contrast, rem type scale', async ({ page }) => {
    await boot(page, { installCard: true });
    // Overlay toggle and tabs expose their state; the map tab controls no panel, the others do.
    await expect(page.locator('.seg button[aria-pressed="true"]')).toHaveText('Fog');
    await page.getByRole('button', { name: 'Heat' }).click();
    await expect(page.locator('.seg button[aria-pressed="true"]')).toHaveText('Heat');
    await page.getByRole('button', { name: 'Fog' }).click();
    await expect(page.getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-controls', 'screen-data');
    await expect(page.locator('#screen-data')).toHaveAttribute('role', 'tabpanel');
    // Every visible control is at least 44 px tall to the finger: the small pills extend their hit box with a
    // pseudo-element, so probe with elementFromPoint 20 px above/below the visual centre instead of the box.
    const probe = (sel: string) =>
      page.locator(sel).evaluateAll((els) =>
        els
          .filter((el) => el.getClientRects().length > 0 && !el.closest('[hidden]'))
          .map((el) => {
            const b = el.getBoundingClientRect();
            const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
            const at = (y: number) => document.elementFromPoint(cx, y);
            const hit = (y: number) => { const t = at(y); return Boolean(t && (t === el || el.contains(t))); };
            const desc = (t: Element | null) => (t ? `${t.tagName.toLowerCase()}.${t.className.toString().slice(0, 20)}` : 'nothing');
            return {
              name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
              ok: hit(cy - 21) && hit(cy + 21),
              why: `box ${Math.round(b.top)}–${Math.round(b.bottom)}, above → ${desc(at(cy - 21))}, below → ${desc(at(cy + 21))}`,
            };
          }),
      );
    for (const sel of ['.seg button', '.fab', '.record', '.search', '.tab', '.install-card .card-close', '.install-card .btn']) {
      const r = await probe(sel);
      expect(r.length, sel).toBeGreaterThan(0);
      for (const x of r) expect(x.ok, `${sel} "${x.name}" is ≥ 44 px tall to the finger (${x.why})`).toBe(true);
    }
    await page.locator('.install-card .card-close').click();
    await page.evaluate(() => (window as UnfogWindow).__unfog?.openRoute?.({ name: 'Domino Park', locality: 'Williamsburg, Brooklyn', lonlat: [-73.9678, 40.7142] }));
    const sheet = page.locator('.sheet.route');
    await expect(sheet.locator('.cand').first()).toBeVisible({ timeout: 30_000 });
    for (const sel of ['.sheet.route .modes button', '.sheet.route .sheet-close', '.sheet.route .cand', '.sheet.route .go', '.sheet.route .range']) {
      for (const x of await probe(sel)) expect(x.ok, `${sel} "${x.name}" is ≥ 44 px tall to the finger (${x.why})`).toBe(true);
    }
    await expect(sheet.locator('.modes button[aria-pressed="true"]')).toHaveText('Walk');
    await expect(sheet.locator('.cand[aria-pressed="true"] .name')).toHaveText('Most new');
    await sheet.locator('.cand').last().click();
    await expect(sheet.locator('.cand[aria-pressed="true"] .name')).toHaveText('Direct');
    await sheet.getByRole('button', { name: 'Go' }).click();
    for (const x of await probe('.follow-bar .btn')) expect(x.ok, `End "${x.name}" is ≥ 44 px tall to the finger (${x.why})`).toBe(true);
    await page.locator('.follow-bar').getByRole('button', { name: 'End' }).click();

    // Light theme (the default): the chosen option in Help → Settings must be visible — dark pill, light text,
    // ≥ 4.5:1 against its own background and distinct from the unselected option.
    await page.getByRole('tab', { name: 'Help' }).click();
    await page.locator('#help-settings summary').click();
    const contrast = await page.locator('#help-settings .seg.inline').first().evaluate((seg) => {
      const rgb = (s: string) => (s.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const on = seg.querySelector('button.on') as HTMLElement;
      const off = seg.querySelector('button:not(.on)') as HTMLElement;
      const so = getComputedStyle(on), sf = getComputedStyle(off);
      return { selected: ratio(rgb(so.color), rgb(so.backgroundColor)), bgDiffers: so.backgroundColor !== sf.backgroundColor, pressed: on.getAttribute('aria-pressed') };
    });
    expect(contrast.selected, 'selected option text vs its pill').toBeGreaterThanOrEqual(4.5);
    expect(contrast.bgDiffers, 'selected pill differs from the unselected one').toBe(true);
    expect(contrast.pressed).toBe('true');
    for (const x of await probe('#help-settings .seg.inline button')) expect(x.ok, `setting "${x.name}" is ≥ 44 px tall to the finger (${x.why})`).toBe(true);
    for (const x of await probe('#help-settings .range')) expect(x.ok, `slider "${x.name}" is ≥ 44 px tall to the finger (${x.why})`).toBe(true);

    // Type scale: rem on a 17 px root (Dynamic Type on iOS), no px font sizes on body copy; 11 px tab labels.
    const type = await page.evaluate(() => ({
      root: getComputedStyle(document.documentElement).fontSize,
      body: getComputedStyle(document.body).fontSize,
      tab: getComputedStyle(document.querySelector('.tab')!).fontSize,
      pxRules: [...document.styleSheets]
        .filter((s) => (s.href ?? '').includes('style.css') || !s.href)
        .flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
        // The 17 px root is the rem base itself; MapLibre's chrome and the pre-bundle boot text are not app copy.
        .filter((r): r is CSSStyleRule => r instanceof CSSStyleRule && /^\d+px$/.test(r.style.fontSize) && !/^html$|maplibregl|boot|attrib/.test(r.selectorText))
        .map((r) => `${r.selectorText}: ${r.style.fontSize}`),
      reducedMotion: [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }).some((r) => r instanceof CSSMediaRule && /reduced-motion/.test(r.media.mediaText) && /\.spinner|\.rec-main/.test(r.cssText)),
    }));
    expect(type.root).toBe('17px');
    expect(parseFloat(type.body)).toBeGreaterThanOrEqual(14.9);
    expect(parseFloat(type.tab)).toBeGreaterThanOrEqual(10.9);
    expect(type.pxRules, 'no fixed-px font sizes on app text').toEqual([]);
    expect(type.reducedMotion, 'reduced-motion rule for the pulse/spinner').toBe(true);
  });
});
