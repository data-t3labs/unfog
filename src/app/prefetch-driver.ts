/**
 * Prefetch driver (coverage v2): keeps the published pack tiles around the user on the device so
 * routing "just works" anywhere with no clicks — data's ruling: the app always has the low-res
 * data of the whole world (the straight-line floor) and gets the high-res streets of the places
 * you are automatically.
 *
 * Owns the `Prefetcher` (src/routing/prefetch.ts — the pure policy: 5×5 ring, throttle, budget,
 * LRU eviction) and feeds it:
 *   - every accepted geolocation fix → `notify(lon, lat, 'position')`;
 *   - the map centre after a pan/zoom while no tracking session runs → `notify(centre, 'map')`
 *     (the policy ignores map moves for 60 s after a fix, so navigating never steals the ring);
 *   - the map centre once at start (the saved camera is where the user was);
 *   - a `tick(env)` every 10 s, on `online`, and right after the centre tile changes.
 * The environment (`browserEnv`) says offline / `navigator.connection.saveData` — nothing is
 * fetched then. The pack cache itself lives in the route worker (IndexedDB `unfog-packs`) behind
 * RouteApi's `packs*` methods. One call from main.ts: `startPrefetchDriver(ctx)`.
 */
import type { LonLat } from '../routing/api';
import { Prefetcher, browserEnv, type PrefetchCache, type PrefetchConfig, type PrefetchEnv, type PrefetchRound } from '../routing/prefetch';
import type { AppContext } from './context';

export const PREFETCH_TICK_MS = 10_000;

/** The `packs*` part of RouteApi the driver uses (structural, so tests fake it in a few lines). */
export interface PrefetchRouteApi {
  packsHasTile: PrefetchCache['hasTile'];
  packsFetchTiles: PrefetchCache['fetchTiles'];
  packsListCached: PrefetchCache['listCached'];
  packsEvict: PrefetchCache['evict'];
}

export interface PrefetchDriverDeps {
  route: PrefetchRouteApi;
  /** Subscribe to accepted geolocation fixes; returns the unsubscribe. */
  onFix(cb: (lon: number, lat: number) => void): () => void;
  /** Subscribe to the end of a map move; returns the unsubscribe. */
  onMapMove(cb: () => void): () => void;
  mapCentre(): LonLat;
  /** A tracking session is running: map pans are then a glance around, not a new place. */
  tracking(): boolean;
  env?: () => PrefetchEnv;
  tickMs?: number;
  config?: PrefetchConfig;
  /** Where the `online` event arrives (default `window`; null = none). */
  onlineTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

export interface PrefetchDriver {
  readonly prefetcher: Prefetcher;
  /** Run a round now (the timer, the `online` event and tests call this). */
  tick(): Promise<PrefetchRound>;
  stop(): void;
}

export function createPrefetchDriver(deps: PrefetchDriverDeps): PrefetchDriver {
  const prefetcher = new Prefetcher(
    {
      hasTile: (x, y) => deps.route.packsHasTile(x, y),
      fetchTiles: (tiles) => deps.route.packsFetchTiles(tiles),
      listCached: () => deps.route.packsListCached(),
      evict: (keys) => deps.route.packsEvict(keys),
    },
    deps.config,
  );
  const env = deps.env ?? (() => browserEnv());
  let stopped = false;

  const tick = (): Promise<PrefetchRound> =>
    prefetcher.tick(env()).catch((e: unknown) => {
      // A worker gone away mid-round is not worth a toast; the next tick tries again.
      console.warn('[unfog] prefetch round failed', e);
      return { decision: { action: 'skip', reason: 'no-centre' }, fetched: 0, bytes: 0, failed: 0, uncovered: 0, evicted: 0 } as PrefetchRound;
    });
  /** A notification that moved the centre tile is followed by a round at once (not in ≤ 10 s). */
  const notify = (ll: LonLat, kind: 'position' | 'map'): void => {
    if (stopped) return;
    if (prefetcher.notify(ll[0], ll[1], kind)) void tick();
  };

  const offFix = deps.onFix((lon, lat) => notify([lon, lat], 'position'));
  const offMove = deps.onMapMove(() => {
    if (!deps.tracking()) notify(deps.mapCentre(), 'map');
  });
  const onOnline = () => void tick();
  const target = deps.onlineTarget === undefined ? (typeof window !== 'undefined' ? window : null) : deps.onlineTarget;
  target?.addEventListener('online', onOnline);
  const timer = setInterval(() => void tick(), deps.tickMs ?? PREFETCH_TICK_MS);
  notify(deps.mapCentre(), 'map');

  return {
    prefetcher,
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
      offFix();
      offMove();
      target?.removeEventListener('online', onOnline);
    },
  };
}

/** The app wiring (main.ts calls this once after the UI modules exist). No-op in mock mode. */
export function startPrefetchDriver(ctx: AppContext): PrefetchDriver | null {
  if (ctx.engines.routeMock) return null;
  return createPrefetchDriver({
    route: ctx.engines.route,
    onFix: (cb) => ctx.location.onFix((fix) => cb(fix.lon, fix.lat)),
    onMapMove: (cb) => {
      ctx.map.map.on('moveend', cb);
      return () => ctx.map.map.off('moveend', cb);
    },
    mapCentre: () => ctx.map.center(),
    tracking: () => Boolean(ctx.tracking?.active),
  });
}
