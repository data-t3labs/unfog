/**
 * Auto-prefetch policy for pack tiles (coverage v2): "the app always has the higher-res data of
 * the places you are — automatically, no clicks".
 *
 * Pure planner + a small driver (`Prefetcher`) over a PackSource-like cache:
 *   - when the user's position (or the map centre) enters a new z12 tile, prefetch the
 *     (2·radius+1)² ring around it (5×5 by default), centre first;
 *   - throttled: a ring is planned at most once per `minIntervalMs` unless the centre tile changed;
 *   - position fixes keep priority NEAR the user: for `positionPriorityMs` after a fix, a map
 *     centre within `farPanM` of that fix is a glance around (the fix's own ring covers it) and is
 *     ignored; a pan farther than that — a far city on a phone with a live watch — counts, so its
 *     streets arrive as the user looks (the next fix re-centres the ring on the user again);
 *   - never on cellular data-saver (`navigator.connection?.saveData`) or offline;
 *   - size budget (150 MB default): after fetching, least-recently-used tiles outside the current
 *     ring are evicted until the cache fits.
 * The app drives it: geolocation → notify(lon, lat, 'position'); map idle → notify(c, 'map');
 * a timer / requestIdleCallback → tick(env). Nothing here touches the DOM.
 *
 * Invariant: prefetch NEVER moves the map. It only reads positions and map centres; no code in
 * this file or in src/app/prefetch-driver.ts calls easeTo / flyTo / jumpTo / fitBounds / setCenter.
 */
import { distanceM } from '../grid/cell';
import { GRAPH_ZOOM, lonLatToGraphTile } from './graph-format';

export interface PrefetchConfig {
  /** Ring radius in z12 tiles: 2 → 5×5. */
  radius: number;
  /** Minimum time between two prefetch rounds for the same centre tile. */
  minIntervalMs: number;
  /** After a position fix, ignore map-centre notifications closer than `farPanM` to it for this long. */
  positionPriorityMs: number;
  /** A map centre at least this far (metres) from the last fix counts even while fixes are fresh. */
  farPanM: number;
  /** Cache budget in bytes; LRU eviction above it. */
  budgetBytes: number;
  /** Fetch at most this many tiles per round (the rest waits for the next tick). */
  maxTilesPerRound: number;
  zoom: number;
}

export const DEFAULT_PREFETCH: PrefetchConfig = {
  radius: 2,
  minIntervalMs: 5_000,
  positionPriorityMs: 60_000,
  farPanM: 5_000,
  budgetBytes: 150 * 1024 * 1024,
  maxTilesPerRound: 25,
  zoom: GRAPH_ZOOM,
};

export interface PrefetchEnv {
  online: boolean;
  /** navigator.connection?.saveData === true */
  saveData: boolean;
  now: number;
}

/** Tiles of the ring around (x, y), centre first then by Chebyshev distance (clamped to the grid). */
export function ringTiles(x: number, y: number, radius: number, zoom = GRAPH_ZOOM): Array<[x: number, y: number]> {
  const n = 1 << zoom;
  const out: Array<[number, number]> = [];
  for (let d = 0; d <= radius; d++) {
    for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < n && yy >= 0 && yy < n) out.push([xx, yy]);
    }
  }
  return out;
}

/** Cached tiles to evict so the cache fits the budget: LRU first, never the protected keys. */
export function planEviction(cached: Array<{ key: string; size: number; lastUsed: number }>, budgetBytes: number, protect: Set<string>): string[] {
  let total = cached.reduce((n, t) => n + t.size, 0);
  if (total <= budgetBytes) return [];
  const victims = cached.filter((t) => !protect.has(t.key)).sort((a, b) => a.lastUsed - b.lastUsed);
  const out: string[] = [];
  for (const v of victims) {
    if (total <= budgetBytes) break;
    out.push(v.key);
    total -= v.size;
  }
  return out;
}

export interface PrefetchState {
  centre: [x: number, y: number] | null;
  lastRoundAt: number;
  lastPositionAt: number;
  /** Where the last position fix was (the reference for the far-pan rule). */
  lastPosition: [lon: number, lat: number] | null;
  /** The last round left tiles unfetched (failed / over maxTilesPerRound). */
  pending: boolean;
}

export const initialPrefetchState = (): PrefetchState => ({ centre: null, lastRoundAt: -Infinity, lastPositionAt: -Infinity, lastPosition: null, pending: false });

/**
 * Does a map-centre notification count? Not while a position fix is fresh (< positionPriorityMs)
 * AND the centre is within farPanM of it: the fix's ring already covers a glance around. A far pan
 * (or no recent fix) counts.
 */
export function mapMoveCounts(state: Pick<PrefetchState, 'lastPositionAt' | 'lastPosition'>, lon: number, lat: number, now: number, cfg: Pick<PrefetchConfig, 'positionPriorityMs' | 'farPanM'>): boolean {
  if (now - state.lastPositionAt >= cfg.positionPriorityMs) return true;
  if (!state.lastPosition) return true;
  return distanceM(lon, lat, state.lastPosition[0], state.lastPosition[1]) >= cfg.farPanM;
}

export type PrefetchDecision =
  | { action: 'skip'; reason: 'no-centre' | 'offline' | 'save-data' | 'throttled' | 'unchanged' }
  | { action: 'fetch'; centre: [number, number]; tiles: Array<[number, number]> };

/** Pure decision: what a tick should do given the state and environment. */
export function decidePrefetch(state: PrefetchState, env: PrefetchEnv, cfg: PrefetchConfig = DEFAULT_PREFETCH, lastFetchedCentre: [number, number] | null = null): PrefetchDecision {
  if (!state.centre) return { action: 'skip', reason: 'no-centre' };
  if (!env.online) return { action: 'skip', reason: 'offline' };
  if (env.saveData) return { action: 'skip', reason: 'save-data' };
  const sameCentre = lastFetchedCentre !== null && lastFetchedCentre[0] === state.centre[0] && lastFetchedCentre[1] === state.centre[1];
  if (sameCentre && !state.pending) return { action: 'skip', reason: 'unchanged' };
  if (env.now - state.lastRoundAt < cfg.minIntervalMs) return { action: 'skip', reason: 'throttled' };
  return { action: 'fetch', centre: state.centre, tiles: ringTiles(state.centre[0], state.centre[1], cfg.radius, cfg.zoom) };
}

/** What the driver needs from PackSource (kept minimal so tests mock it in a few lines). */
export interface PrefetchCache {
  hasTile(x: number, y: number): Promise<boolean>;
  fetchTiles(tiles: Array<[x: number, y: number]>): Promise<{ fetched: number; bytes: number; failed: string[]; uncovered: string[] }>;
  listCached(): Promise<Array<{ key: string; size: number; lastUsed: number }>>;
  evict(keys: string[]): Promise<void>;
}

export interface PrefetchRound {
  decision: PrefetchDecision;
  fetched: number;
  bytes: number;
  failed: number;
  uncovered: number;
  evicted: number;
}

export class Prefetcher {
  readonly state = initialPrefetchState();
  private lastFetchedCentre: [number, number] | null = null;
  private running: Promise<PrefetchRound> | null = null;
  readonly stats = { rounds: 0, fetched: 0, bytes: 0, evicted: 0, failed: 0 };

  constructor(private readonly cache: PrefetchCache, readonly cfg: PrefetchConfig = DEFAULT_PREFETCH) {}

  /** New position fix or map centre. Cheap; the work happens in tick(). Returns true when the centre tile changed. */
  notify(lon: number, lat: number, kind: 'position' | 'map', now = Date.now()): boolean {
    if (kind === 'map' && !mapMoveCounts(this.state, lon, lat, now, this.cfg)) return false;
    if (kind === 'position') { this.state.lastPositionAt = now; this.state.lastPosition = [lon, lat]; }
    const c = lonLatToGraphTile(lon, lat, this.cfg.zoom);
    const changed = !this.state.centre || this.state.centre[0] !== c[0] || this.state.centre[1] !== c[1];
    if (changed) { this.state.centre = c; this.state.pending = true; }
    return changed;
  }

  /** One prefetch round (serialised: a tick during a running round returns that round). */
  tick(env: PrefetchEnv): Promise<PrefetchRound> {
    if (this.running) return this.running;
    this.running = this.round(env).finally(() => { this.running = null; });
    return this.running;
  }

  private async round(env: PrefetchEnv): Promise<PrefetchRound> {
    const decision = decidePrefetch(this.state, env, this.cfg, this.lastFetchedCentre);
    const out: PrefetchRound = { decision, fetched: 0, bytes: 0, failed: 0, uncovered: 0, evicted: 0 };
    if (decision.action !== 'fetch') return out;
    this.state.lastRoundAt = env.now;
    this.stats.rounds++;
    const missing: Array<[number, number]> = [];
    for (const [x, y] of decision.tiles) if (!(await this.cache.hasTile(x, y))) missing.push([x, y]);
    const batch = missing.slice(0, this.cfg.maxTilesPerRound);
    if (batch.length) {
      const r = await this.cache.fetchTiles(batch);
      out.fetched = r.fetched; out.bytes = r.bytes; out.failed = r.failed.length; out.uncovered = r.uncovered.length;
      this.stats.fetched += r.fetched; this.stats.bytes += r.bytes; this.stats.failed += r.failed.length;
    }
    this.state.pending = missing.length > batch.length || out.failed > 0;
    this.lastFetchedCentre = decision.centre;
    const protect = new Set(decision.tiles.map(([x, y]) => `${x}/${y}`));
    const victims = planEviction(await this.cache.listCached(), this.cfg.budgetBytes, protect);
    if (victims.length) { await this.cache.evict(victims); out.evicted = victims.length; this.stats.evicted += victims.length; }
    return out;
  }
}

/** Environment from the browser (main thread or worker); pass the result to tick(). */
export function browserEnv(now = Date.now()): PrefetchEnv {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: { saveData?: boolean } }) : undefined;
  return { online: nav ? nav.onLine !== false : true, saveData: nav?.connection?.saveData === true, now };
}
