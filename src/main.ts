/**
 * Boot: service worker → settings → engines (real workers or mocks) → map → UI → tracking resume.
 * See docs/BUILD-PLAN.md §2. `?mock=1` forces the in-page mock engines.
 */
import './style.css';
import type { AppContext, Destination } from './app/context';
import { createDataScreen } from './app/data';
import { loadEngines } from './app/engines';
import { fmtArea, fmtInt } from './app/format';
import { createHelpScreen, showInstallCardIfNeeded } from './app/help';
import { startPrefetchDriver } from './app/prefetch-driver';
import { initPwa } from './app/pwa';
import { createRouteSheet } from './app/route-sheet';
import { createSearch } from './app/search';
import { RENDER_KEYS, getSettings, onSettingsChange, renderSettings, updateSettings, type Basemap } from './app/settings';
import { createShell } from './app/shell';
import { createStatsScreen } from './app/stats';
import { createTracking, type TrackingController } from './app/tracking';
import { el, toast } from './app/ui';
import { createSync } from './sync/setup';
import { LocationManager, describeLocationError } from './map/location';
import { DEFAULT_CENTER, UnfogMap, savedCenter } from './map/map';
import { overlayPerf } from './map/overlay';
import { Recorder, type RecorderEvents } from './record/session';

declare global {
  interface Window {
    __unfog?: {
      ready: boolean;
      mock: boolean;
      openRoute?: (d: Destination) => void;
      openLoop?: (from?: [number, number]) => void;
      ctx?: AppContext;
      /** performance.now() when the map first went idle (time to interactive). */
      readyAt?: number;
      /** Overlay tile pipeline counters (src/map/overlay.ts). */
      perf?: typeof overlayPerf;
    };
  }
}

/** Chrome theme per basemap: light on the bright map, dark over the night map and over imagery. */
const chromeTheme = (b: Basemap): 'light' | 'dark' => (b === 'bright' ? 'light' : 'dark');

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
  shell.setTheme(chromeTheme(settings0.basemap));
  shell.setLayer(settings0.layer);

  const map = new UnfogMap({
    container: shell.mapEl,
    grid: engines.grid,
    renderSettings: () => renderSettings(),
    basemap: settings0.basemap,
    layer: settings0.layer,
  });
  const locationMgr = new LocationManager();
  const recordHooks: RecorderEvents = {
    onUpdate() {},
    onWakeLock() {},
    // A checkpoint wrote cells: re-render the touched overlay tiles in view, drop the route
    // worker's novelty scores, and keep the stat chip honest — live, not on Stop.
    onData(r) {
      map.refreshOverlay(r.touched);
      engines.route.invalidateCells(r.stats.version).catch((e: unknown) => console.warn('[unfog] invalidateCells failed', e));
      void refreshStatChip();
    },
  };
  const recorder = new Recorder(engines.grid, locationMgr, recordHooks);

  let routeSheet: ReturnType<typeof createRouteSheet>;
  let statsScreen: ReturnType<typeof createStatsScreen>;
  let helpScreen: ReturnType<typeof createHelpScreen>;
  let tracking: TrackingController;

  async function refreshStatChip(): Promise<void> {
    try {
      const s = await engines.grid.getStats();
      shell.statBig.textContent = fmtArea(s.areaM2, getSettings().units);
      shell.statSub.textContent = `${fmtInt(s.visitedCells)} cells`;
      shell.setEmptyState(s.visitedCells === 0);
    } catch {
      shell.statBig.textContent = '—';
      shell.statSub.textContent = '';
    }
  }

  const ctx: AppContext = {
    engines,
    map,
    shell,
    location: locationMgr,
    recorder,
    get tracking() {
      return tracking;
    },
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
        toast('Location is not available in this browser. Open Unfog in Safari.', { kind: 'error' });
        return false;
      }
      if (window.isSecureContext === false) {
        toast('Location only works over a secure (https) connection. Open Unfog from its https address.', { kind: 'error', duration: 6000 });
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
    openLoop(from) {
      shell.showTab('map');
      routeSheet.openLoop(from);
    },
    openHelp(section) {
      shell.showTab('help');
      helpScreen.show(section);
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
      shell.setTheme(chromeTheme(s.basemap));
      map.setBasemap(s.basemap);
    } else if (changed.some((k) => RENDER_KEYS.includes(k))) {
      map.bumpOverlay();
    }
    if (changed.includes('units')) void refreshStatChip();
  });

  // ---- UI modules
  const search = createSearch(ctx);
  routeSheet = createRouteSheet(ctx);
  tracking = createTracking(ctx, recordHooks);
  // Always recording (src/sync): Fog of World via Dropbox + Overland, pulled on open / rollover / every 15 min.
  const sync = createSync(ctx);
  const dataScreen = createDataScreen(ctx);
  statsScreen = createStatsScreen(ctx);
  helpScreen = createHelpScreen(ctx);
  // Coverage v2: the streets around you download as you go (packs; src/app/prefetch-driver.ts).
  startPrefetchDriver(ctx);

  shell.searchPill.addEventListener('click', () => search.open());
  shell.searchClear.addEventListener('click', () => routeSheet.close());
  map.onLongPress((ll) => ctx.openRoute({ name: 'Dropped pin', locality: `${ll[1].toFixed(5)}, ${ll[0].toFixed(5)}`, lonlat: ll }));
  shell.onTab((tab) => {
    if (tab === 'stats') void statsScreen.refresh();
    if (tab === 'data') void dataScreen.refresh();
    if (tab === 'help') helpScreen.refresh();
  });
  window.addEventListener('resize', () => map.resize());

  // ---- boot-time checks
  void refreshStatChip();
  map.onReady(() => {
    // Save whatever the previous run left, start tracking if the switch is on, then (first run)
    // offer the switch — after the install card on iOS Safari, since installing starts over anyway.
    void tracking.resume().then(() => {
      const installCard = showInstallCardIfNeeded(ctx, () => tracking.offerIfNeeded());
      if (!installCard) tracking.offerIfNeeded();
      // Finish a Dropbox sign-in the app was opened with (if any), then pull the sources.
      void sync.boot();
    });
    window.setTimeout(() => dataScreen.maybeNag(), 4000);
    map.map.once('idle', () => {
      window.__unfog = { ready: true, mock: engines.gridMock || engines.routeMock, openRoute: (d) => ctx.openRoute(d), openLoop: (from) => ctx.openLoop(from), ctx, readyAt: performance.now(), perf: overlayPerf };
    });
  });
  if (engines.gridMock || engines.routeMock) {
    if (forceMock) toast('Mock mode: synthetic data, nothing is saved', { duration: 4000 });
    else toast('The map engines did not start — showing sample data instead. Reload to try again.', { kind: 'error', duration: 8000, action: { label: 'Reload', onClick: () => location.reload() } });
  }
}

boot().catch((e: unknown) => {
  console.error(e);
  const mount = document.getElementById('app');
  if (mount) mount.replaceChildren(el('div', { class: 'boot' }, el('div', { class: 'error', text: `Unfog could not start: ${String((e as Error)?.message ?? e)}. Reload to try again; if it keeps failing, check your connection.` }), el('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Reload')));
});
