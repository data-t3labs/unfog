/**
 * Boot: service worker → settings → engines (real workers or mocks) → map → UI → resume checks.
 * See docs/BUILD-PLAN.md §2. `?mock=1` forces the in-page mock engines.
 */
import './style.css';
import type { AppContext, Destination } from './app/context';
import { createDataScreen } from './app/data';
import { loadEngines } from './app/engines';
import { fmtArea, fmtInt } from './app/format';
import { createHelpScreen, showInstallCardIfNeeded } from './app/help';
import { initPwa } from './app/pwa';
import { createRecordUI } from './app/record-ui';
import { createRouteSheet } from './app/route-sheet';
import { createSearch } from './app/search';
import { RENDER_KEYS, getSettings, onSettingsChange, renderSettings, updateSettings } from './app/settings';
import { createShell } from './app/shell';
import { createStatsScreen } from './app/stats';
import { el, toast } from './app/ui';
import { LocationManager, describeLocationError } from './map/location';
import { DEFAULT_CENTER, UnfogMap, savedCenter } from './map/map';
import { Recorder, type RecorderEvents } from './record/session';

declare global {
  interface Window {
    __unfog?: { ready: boolean; mock: boolean; openRoute?: (d: Destination) => void; ctx?: AppContext };
  }
}

async function boot(): Promise<void> {
  const mount = document.getElementById('app');
  if (!mount) throw new Error('#app missing');
  mount.replaceChildren(el('div', { class: 'boot' }, el('span', { class: 'spinner' }), 'Loading Unfog…'));
  initPwa();

  const params = new URLSearchParams(location.search);
  const forceMock = params.get('mock') === '1';
  const settings0 = getSettings();

  const engines = await loadEngines({ forceMock, center: savedCenter() ?? DEFAULT_CENTER, baseUrl: import.meta.env.BASE_URL });
  const shell = createShell(mount);
  shell.setTheme(settings0.basemap === 'dark' ? 'dark' : 'light');
  shell.setLayer(settings0.layer);

  const map = new UnfogMap({
    container: shell.mapEl,
    grid: engines.grid,
    renderSettings: () => renderSettings(),
    basemap: settings0.basemap,
    layer: settings0.layer,
  });
  const locationMgr = new LocationManager();
  const recordHooks: RecorderEvents = { onUpdate() {}, onWakeLock() {} };
  const recorder = new Recorder(engines.grid, locationMgr, recordHooks);

  let routeSheet: ReturnType<typeof createRouteSheet>;
  let statsScreen: ReturnType<typeof createStatsScreen>;

  async function refreshStatChip(): Promise<void> {
    try {
      const s = await engines.grid.getStats();
      shell.statBig.textContent = fmtArea(s.areaM2, getSettings().units);
      shell.statSub.textContent = `explored · ${fmtInt(s.visitedCells)} cells`;
    } catch {
      shell.statBig.textContent = '—';
    }
  }

  const ctx: AppContext = {
    engines,
    map,
    shell,
    location: locationMgr,
    recorder,
    settings: () => getSettings(),
    async dataChanged() {
      map.bumpOverlay();
      try {
        const s = await engines.grid.getStats();
        await engines.route.invalidateCells(s.version);
      } catch (e) {
        console.warn('[unfog] invalidateCells failed', e);
      }
      await refreshStatChip();
      if (shell.currentTab === 'stats') void statsScreen.refresh();
    },
    overlayChanged() {
      map.bumpOverlay();
    },
    async requestLocation() {
      if (!locationMgr.supported) {
        toast('This browser has no location support', { kind: 'error' });
        return false;
      }
      if (window.isSecureContext === false) {
        toast('Location needs HTTPS', { kind: 'error' });
        return false;
      }
      locationMgr.retain('map');
      try {
        const fix = await locationMgr.getOnce(15_000, 30_000);
        map.setUserPosition(fix);
        return true;
      } catch (kind) {
        const k = (typeof kind === 'string' ? kind : 'unavailable') as Parameters<typeof describeLocationError>[0];
        toast(describeLocationError(k), {
          kind: 'error',
          duration: 6000,
          action: k === 'denied' ? { label: 'Help', onClick: () => shell.showTab('help') } : undefined,
        });
        return false;
      }
    },
    openRoute(dest) {
      shell.showTab('map');
      routeSheet.open(dest);
    },
  };

  // ---- location → map
  locationMgr.onFix((fix) => map.setUserPosition(fix));
  locationMgr.onError((kind) => {
    if (kind === 'denied') {
      shell.setLocateActive(false);
      map.setFollow(false);
    }
  });
  map.onFollowChange((on) => shell.setLocateActive(on));
  shell.locateBtn.addEventListener('click', async () => {
    if (map.follow) {
      map.setFollow(false);
      return;
    }
    const ok = await ctx.requestLocation();
    if (ok) map.setFollow(true, Math.max(map.zoom(), 15));
  });

  // ---- layers + settings
  shell.onLayer((layer) => {
    updateSettings({ layer });
    map.setLayer(layer);
  });
  onSettingsChange((s, changed) => {
    if (changed.includes('basemap')) {
      shell.setTheme(s.basemap === 'dark' ? 'dark' : 'light');
      map.setBasemap(s.basemap);
    } else if (changed.some((k) => RENDER_KEYS.includes(k))) {
      map.bumpOverlay();
    }
    if (changed.includes('units')) void refreshStatChip();
  });

  // ---- UI modules
  const search = createSearch(ctx);
  routeSheet = createRouteSheet(ctx);
  const recordUI = createRecordUI(ctx, recordHooks);
  const dataScreen = createDataScreen(ctx);
  statsScreen = createStatsScreen(ctx);
  const helpScreen = createHelpScreen(ctx);

  shell.searchPill.addEventListener('click', () => search.open());
  shell.searchClear.addEventListener('click', () => routeSheet.close());
  shell.recordBtn.addEventListener('click', () => void recordUI.start());
  map.onLongPress((ll) => {
    if (recorder.status === 'recording') return;
    ctx.openRoute({ name: 'Dropped pin', locality: `${ll[1].toFixed(5)}, ${ll[0].toFixed(5)}`, lonlat: ll });
  });
  shell.onTab((tab) => {
    if (tab === 'stats') void statsScreen.refresh();
    if (tab === 'data') void dataScreen.refresh();
    if (tab === 'help') helpScreen.refresh();
  });
  window.addEventListener('resize', () => map.resize());

  // ---- boot-time checks
  void refreshStatChip();
  map.onReady(() => {
    recordUI.offerResume();
    showInstallCardIfNeeded(ctx);
    window.setTimeout(() => dataScreen.maybeNag(), 4000);
    map.map.once('idle', () => {
      window.__unfog = { ready: true, mock: engines.gridMock || engines.routeMock, openRoute: (d) => ctx.openRoute(d), ctx };
    });
  });
  if (engines.gridMock || engines.routeMock) {
    toast(forceMock ? 'Mock mode: synthetic data, nothing is saved' : 'Engines unavailable — showing mock data', { duration: 4000 });
  }
}

boot().catch((e: unknown) => {
  console.error(e);
  const mount = document.getElementById('app');
  if (mount) mount.replaceChildren(el('div', { class: 'boot' }, el('div', { class: 'error', text: `Unfog could not start: ${String((e as Error)?.message ?? e)}` }), el('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Reload')));
});
