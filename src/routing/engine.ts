/**
 * RouteApi implementation (runs inside route.worker.ts; also usable directly in Node for tests).
 * Holds the tile source, the read-only cell lookup and a small cache of merged graphs keyed by
 * their tile set (with the spatial index, novelty cache and search workspace that go with it).
 */
import { distanceM } from '../grid/cell';
import type {
  BBox, CoverageReport, DownloadProgress, LonLat, LoopRequest, PackCacheStatus, PackFetchResult, RouteApi, RouteRequest, RouteResult,
} from './api';
import { findCandidates, now, straightLineResult } from './candidates';
import type { CellLookup } from './cells';
import { IdbCellLookup } from './cells-idb';
import { Graph } from './graph';
import type { RegionManifest } from './graph-format';
import { findLoops } from './loop';
import { NoveltyScorer } from './novelty';
import { PackSource, packsIndexUrl, type PackSourceOptions, type PackSourcePerf } from './pack-source';
import { Searcher } from './search';
import { SpatialIndex } from './spatial';
import { TileSource, type TileSourceOptions, type TileSourcePerf } from './tiles-source';

const DEG = Math.PI / 180;
export const MAX_AREA_RADIUS_KM = 8;
/** Boot waits at most this long for a fresh packs-index.json (a late one still lands in the background). */
const PACKS_INDEX_BOOT_MS = 5_000;
/** A pack byte-range that has not answered by then is a failed tile, not a hung route request. */
const PACK_FETCH_DEADLINE_MS = 60_000;
/**
 * Retry sleeps of the Overpass fetch, per endpoint (research §1a: back off ≥ 30 s on 429).
 * Passed explicitly so the progress note can say how long the wait is.
 */
const OVERPASS_RETRY_DELAYS_MS = [15_000, 30_000, 60_000];

/** No connection: said up front instead of after the retry loop's minutes of sleeping. */
export class OfflineError extends Error {
  constructor() {
    super('No internet connection');
    this.name = 'OfflineError';
  }
}

/**
 * Overpass answered but had no routable way in the box (open water, or a regional mirror that
 * does not cover the area): nothing is stored, and the message is not about the connection.
 */
export class EmptyAreaError extends Error {
  constructor() {
    super('No streets found in this area. Zoom in on a town and try again.');
    this.name = 'EmptyAreaError';
  }
}

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Server-side Overpass budget (`[timeout:90]`) plus slack for the transfer. */
const OVERPASS_TIMEOUT_S = 90;
const OVERPASS_DEADLINE_MS = (OVERPASS_TIMEOUT_S + 30) * 1000;

/**
 * `fetch` with a deadline. An overloaded overpass-api.de dispatcher holds the connection open
 * without ever answering (seen 2026-09-02: 4 min and counting), which the retry ladder never
 * gets to see. A deadline rejection is an ordinary (retryable) error; an abort of `outer`
 * (offline) is re-thrown as that abort so the ladder stops.
 */
export function fetchWithDeadline(ms: number, outer?: AbortSignal, base: typeof fetch = fetch, who = 'Overpass'): typeof fetch {
  return async (input, init) => {
    const ctrl = new AbortController();
    const onOuter = () => ctrl.abort(outer?.reason);
    if (outer?.aborted) onOuter();
    else outer?.addEventListener('abort', onOuter, { once: true });
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await base(input, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (outer?.aborted) throw outer.reason instanceof Error ? outer.reason : e;
      if (ctrl.signal.aborted) throw new Error(`${who} did not answer within ${Math.round(ms / 1000)} s`);
      throw e;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  };
}

/** One failed Overpass attempt as a status line: what went wrong and what happens next. */
function describeAttempt(error: unknown, delayMs: number | undefined, lastOnEndpoint: boolean, lastEndpoint: boolean): string {
  const status = (error as { status?: number } | null)?.status;
  const what = typeof status === 'number' ? `Overpass is busy (HTTP ${status})` : 'Overpass did not answer';
  if (lastOnEndpoint) return lastEndpoint ? `${what} — giving up` : `${what} — trying another server`;
  return `${what} — retrying in ${Math.round((delayMs ?? 0) / 1000)} s`;
}

/**
 * No graph tile has data for the request. Crosses Comlink with name + message intact.
 * `packable` > 0 means a published pack covers the box but nothing could be loaded (offline with
 * nothing cached, or a shard not deployed yet): route() answers that with the straight-line floor.
 */
export class NoCoverageError extends Error {
  constructor(public missingTiles: number, public packable = 0) {
    super(`No graph coverage here (${missingTiles} tile${missingTiles === 1 ? '' : 's'} without data) — download this area first`);
    this.name = 'NoCoverageError';
  }
}

interface CachedGraph {
  key: string;
  graph: Graph;
  spatial: SpatialIndex;
  scorer: NoveltyScorer;
  searcher: Searcher;
  mergeMs: number;
}

export interface EngineOptions {
  tiles?: TileSourceOptions;
  /** Pack source (coverage v2) options — tests inject a fake fetch / index URL / database name. */
  packs?: PackSourceOptions;
  /** Override the cell lookup (tests). Must implement prepare()/invalidate() if IdbCellLookup-like. */
  cells?: CellLookup & { prepare?(bbox: BBox): Promise<number>; invalidate?(): void };
  /** Merged graphs kept alive. Default 2. */
  graphCache?: number;
}

/** BBox around two points padded by max(1 km, 0.6 · distance). */
export function routeBBox(from: LonLat, to: LonLat): BBox {
  const d = distanceM(from[0], from[1], to[0], to[1]);
  return padBBox([Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.max(from[0], to[0]), Math.max(from[1], to[1])], Math.max(1000, 0.6 * d));
}

export function padBBox(b: BBox, padM: number): BBox {
  const lat = (b[1] + b[3]) / 2;
  const dLat = padM / 110_574, dLon = padM / (111_320 * Math.cos(lat * DEG));
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

export function circleBBox(center: LonLat, radiusKm: number): BBox {
  return padBBox([center[0], center[1], center[0], center[1]], radiusKm * 1000);
}

/** Phase timings of the last route()/loop() call (diagnostics: `await remote.perf` from the page). */
export interface RoutePerf {
  /** Fetch/inflate/decode of the request's tiles (0 when every tile came from memory). */
  tilesMs: number;
  /** Graph merge; 0 on a graph-cache hit. */
  mergeMs: number;
  /** Spatial index build; 0 on a graph-cache hit. */
  spatialMs: number;
  graphHit: boolean;
  /** IdbCellLookup.prepare over the merged graph's bbox. */
  prepareMs: number;
  preparedTiles: number;
  /** snap + λ sweep + candidate assembly. */
  searchMs: number;
  totalMs: number;
  tiles: number;
  nodes: number;
  arcs: number;
  /** Arcs novelty-scored so far on this graph (cumulative over its cached life). */
  scored: number;
  source: TileSourcePerf;
  /** Pack cache counters (coverage v2): range requests, bytes, IndexedDB hits. */
  packs: PackSourcePerf;
}

export class RouteEngine implements RouteApi {
  readonly tiles: TileSource;
  /** Published z6 packs (coverage v2): the layer beneath prebuilt regions and downloads. */
  readonly packs: PackSource;
  readonly cells: CellLookup & { prepare?(bbox: BBox): Promise<number>; invalidate?(): void };
  private readonly graphs: CachedGraph[] = [];
  private readonly graphCacheSize: number;
  private readonly packsIndexUrlFixed: boolean;
  cellVersion = 0;
  perf: RoutePerf | null = null;
  private lastGraphPhase = { tilesMs: 0, mergeMs: 0, spatialMs: 0, hit: false };

  constructor(opts: EngineOptions = {}) {
    this.tiles = new TileSource(opts.tiles);
    // Decoded tiles live in TileSource's LRU only (memoryTiles 0); a hung byte-range is cut so a
    // route request fails a tile instead of hanging. Tests pass their own fetch / index URL / db.
    const deadlineFetch = typeof fetch === 'function' ? fetchWithDeadline(PACK_FETCH_DEADLINE_MS, undefined, fetch.bind(globalThis), 'The map server') : undefined;
    this.packs = new PackSource({ memoryTiles: 0, fetch: deadlineFetch, ...opts.packs });
    this.packsIndexUrlFixed = opts.packs?.indexUrl !== undefined;
    this.tiles.fallback = {
      getTile: (x, y) => this.packs.getTile(x, y, { network: false }),
      hasTile: (x, y) => this.packs.hasTile(x, y),
      covers: (x, y) => this.packs.covers(x, y),
    };
    this.cells = opts.cells ?? new IdbCellLookup();
    this.graphCacheSize = opts.graphCache ?? 2;
  }

  async init(baseUrl: string): Promise<void> {
    if (!this.packsIndexUrlFixed) this.packs.indexUrl = packsIndexUrl(baseUrl);
    // Both never throw: a missing packs-index (dev, e2e) just means no packs; the refresh is
    // bounded so a slow network cannot push route.init past the app's boot timeout.
    await Promise.all([this.tiles.init(baseUrl), this.packs.init({ refreshTimeoutMs: PACKS_INDEX_BOOT_MS })]);
  }

  async listRegions(): Promise<RegionManifest[]> {
    return this.tiles.listRegions();
  }

  coverage(bbox: BBox): Promise<CoverageReport> {
    return this.tiles.coverage(bbox);
  }

  downloadRegion(regionId: string, onProgress?: (p: DownloadProgress) => void): Promise<{ tiles: number; bytes: number }> {
    return this.tiles.downloadRegion(regionId, onProgress);
  }

  async downloadArea(center: LonLat, radiusKm: number, onProgress?: (p: DownloadProgress) => void): Promise<{ tiles: number; bytes: number }> {
    if (!(radiusKm > 0) || radiusKm > MAX_AREA_RADIUS_KM) throw new Error(`Radius must be 0–${MAX_AREA_RADIUS_KM} km`);
    if (isOffline()) throw new OfflineError();
    // Agent D's modules (wave 1): imported lazily so the worker boots without them and tests do not depend on them.
    const [{ fetchOverpassWays, DEFAULT_OVERPASS_ENDPOINT, ALTERNATE_OVERPASS_ENDPOINTS }, { buildGraphTiles }] = await Promise.all([import('./overpass'), import('./graph-build')]);
    const bbox = circleBBox(center, radiusKm);
    onProgress?.({ phase: 'fetch', done: 0, total: 1 });
    // Losing the connection mid-download aborts the retry loop at once instead of sleeping through it.
    const abort = new AbortController();
    const onOffline = () => abort.abort(new OfflineError());
    const scope = globalThis as { addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void };
    scope.addEventListener?.('offline', onOffline);
    const endpoints = [DEFAULT_OVERPASS_ENDPOINT, ...ALTERNATE_OVERPASS_ENDPOINTS];
    let ways;
    try {
      ways = await fetchOverpassWays(bbox, {
        signal: abort.signal,
        timeoutS: OVERPASS_TIMEOUT_S,
        fetch: fetchWithDeadline(OVERPASS_DEADLINE_MS, abort.signal),
        retryDelaysMs: OVERPASS_RETRY_DELAYS_MS,
        // Each failed attempt becomes a progress note so the sheet can say "busy — retrying in 15 s".
        onAttempt: ({ endpoint, attempt, error }) => {
          if (!error) return;
          const lastOnEndpoint = attempt >= OVERPASS_RETRY_DELAYS_MS.length;
          const lastEndpoint = endpoint === endpoints[endpoints.length - 1];
          onProgress?.({ phase: 'fetch', done: 0, total: 1, note: describeAttempt(error, OVERPASS_RETRY_DELAYS_MS[attempt - 1], lastOnEndpoint, lastEndpoint) });
        },
      });
    } finally {
      scope.removeEventListener?.('offline', onOffline);
    }
    onProgress?.({ phase: 'fetch', done: 1, total: 1 });
    onProgress?.({ phase: 'build', done: 0, total: 1 });
    const built = buildGraphTiles(ways);
    onProgress?.({ phase: 'build', done: 1, total: 1 });
    // An empty area would be stored, listed on Data, and still route to "no coverage" — say so instead.
    if (built.tiles.size === 0) throw new EmptyAreaError();
    const id = `${center[0].toFixed(4)},${center[1].toFixed(4)},${radiusKm}km`;
    const rec = await this.tiles.storeArea({ id, center, radiusKm }, built.tiles, onProgress);
    this.graphs.length = 0;
    return { tiles: rec.tiles, bytes: rec.bytes };
  }

  listDownloads(): Promise<Array<{ id: string; center: LonLat; radiusKm: number; tiles: number; bytes: number; builtAt: string }>> {
    return this.tiles.listDownloads();
  }

  async deleteDownload(id: string): Promise<void> {
    await this.tiles.deleteDownload(id);
    this.graphs.length = 0;
  }

  /**
   * Merged graph for a bbox (cached by tile set). Throws when no tile has data. Online, the tiles
   * nothing local holds are fetched from their packs first — one coalesced byte-range round per
   * pack, so a first route in a new city costs a couple of requests, not one per tile.
   */
  async graphFor(bbox: BBox): Promise<CachedGraph> {
    const tStart = now();
    if (!isOffline()) {
      const want = await this.tiles.missingLocally(bbox);
      if (want.length) await this.packs.fetchTiles(want);
    }
    const { tiles, keys, missing } = await this.tiles.tilesFor(bbox);
    const tilesMs = now() - tStart;
    if (tiles.length === 0) throw new NoCoverageError(missing.length, (await this.tiles.coverage(bbox)).packable);
    const key = keys.join(',');
    const i = this.graphs.findIndex((c) => c.key === key);
    if (i >= 0) {
      const c = this.graphs.splice(i, 1)[0];
      this.graphs.push(c);
      this.lastGraphPhase = { tilesMs, mergeMs: 0, spatialMs: 0, hit: true };
      return c;
    }
    const t0 = now();
    const graph = new Graph(tiles);
    const t1 = now();
    const spatial = new SpatialIndex(graph);
    const t2 = now();
    const scorer = new NoveltyScorer(graph, this.cells);
    const searcher = new Searcher(graph, scorer);
    this.lastGraphPhase = { tilesMs, mergeMs: t1 - t0, spatialMs: t2 - t1, hit: false };
    const c: CachedGraph = { key, graph, spatial, scorer, searcher, mergeMs: now() - t0 };
    this.graphs.push(c);
    while (this.graphs.length > this.graphCacheSize) this.graphs.shift();
    return c;
  }

  /**
   * Cells must be ready for the WHOLE merged graph, not just the request bbox: the search brushes
   * past arcs well outside the ellipse (every relaxed arc is scored, and the merged tiles reach
   * ~7 km beyond the request), and the novelty cache keeps a score for as long as the graph lives —
   * a score taken while its cells were unloaded would be stale for every later request.
   */
  private prepareCells(c: CachedGraph): Promise<number> | undefined {
    return this.cells.prepare?.(c.graph.bbox);
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const t0 = now();
    const bbox = routeBBox(req.from, req.to);
    let c: CachedGraph;
    try {
      c = await this.graphFor(bbox);
    } catch (e) {
      // A pack covers this box but nothing loaded (offline with nothing cached, a shard not
      // deployed yet): the straight-line floor, no prompt. Outside every pack the error stands
      // and the sheet offers a download.
      if (e instanceof NoCoverageError && e.packable > 0) return this.directLine(req);
      throw e;
    }
    const t1 = now();
    const prepared = (await this.prepareCells(c)) ?? 0;
    const t2 = now();
    const res = findCandidates(c.graph, this.cells, req, { spatial: c.spatial, scorer: c.scorer, searcher: c.searcher, graphTiles: c.graph.tileKeys.length });
    res.ms = Math.round(now() - t0);
    this.recordPerf(c, t2 - t1, prepared, now() - t2, res.ms);
    return res;
  }

  /** "Route anyway" without graph coverage: the straight line, scored against the cells along it. */
  async directLine(req: RouteRequest): Promise<RouteResult> {
    const t0 = now();
    await this.cells.prepare?.(routeBBox(req.from, req.to));
    const res = straightLineResult(req, this.cells);
    res.ms = Math.round(now() - t0);
    return res;
  }

  async loop(req: LoopRequest): Promise<RouteResult> {
    const t0 = now();
    const bbox = padBBox([req.from[0], req.from[1], req.from[0], req.from[1]], Math.max(1000, req.targetKm * 500));
    const c = await this.graphFor(bbox);
    const t1 = now();
    const prepared = (await this.prepareCells(c)) ?? 0;
    const t2 = now();
    const res = findLoops(c.graph, this.cells, req, { spatial: c.spatial, scorer: c.scorer, searcher: c.searcher, graphTiles: c.graph.tileKeys.length });
    res.ms = Math.round(now() - t0);
    this.recordPerf(c, t2 - t1, prepared, now() - t2, res.ms);
    return res;
  }

  private recordPerf(c: CachedGraph, prepareMs: number, preparedTiles: number, searchMs: number, totalMs: number): void {
    const g = this.lastGraphPhase;
    this.perf = {
      tilesMs: Math.round(g.tilesMs * 10) / 10,
      mergeMs: Math.round(g.mergeMs * 10) / 10,
      spatialMs: Math.round(g.spatialMs * 10) / 10,
      graphHit: g.hit,
      prepareMs: Math.round(prepareMs * 10) / 10,
      preparedTiles,
      searchMs: Math.round(searchMs * 10) / 10,
      totalMs: Math.round(totalMs * 10) / 10,
      tiles: c.graph.tileKeys.length,
      nodes: c.graph.nodeCount,
      arcs: c.graph.arcCount,
      scored: c.scorer.scoredCount,
      source: { ...this.tiles.perf },
      packs: { ...this.packs.perf },
    };
  }

  async invalidateCells(version: number): Promise<void> {
    this.cellVersion = version;
    this.cells.invalidate?.();
    for (const c of this.graphs) c.scorer.invalidate();
  }

  // ---- pack cache (coverage v2), for the main thread's prefetch driver and the Data screen

  packsHasTile(x: number, y: number): Promise<boolean> {
    return this.packs.hasTile(x, y);
  }

  packsFetchTiles(tiles: Array<[x: number, y: number]>): Promise<PackFetchResult> {
    return this.packs.fetchTiles(tiles);
  }

  packsListCached(): Promise<Array<{ key: string; x: number; y: number; cell: string; size: number; lastUsed: number }>> {
    return this.packs.listCached();
  }

  packsEvict(keys: string[]): Promise<void> {
    return this.packs.evict(keys);
  }

  /** Drop every cached pack tile, plus the decoded copies and merged graphs built from them, so the next route fetches afresh. */
  async packsClear(): Promise<void> {
    await this.packs.clear();
    this.tiles.clearMemory();
    this.graphs.length = 0;
  }

  packsStatus(): Promise<PackCacheStatus> {
    return this.packs.status();
  }
}
