/**
 * RouteApi implementation (runs inside route.worker.ts; also usable directly in Node for tests).
 * Holds the tile source, the read-only cell lookup and a small cache of merged graphs keyed by
 * their tile set (with the spatial index, novelty cache and search workspace that go with it).
 */
import { distanceM } from '../grid/cell';
import type {
  BBox, CoverageReport, DownloadProgress, LonLat, LoopRequest, RouteApi, RouteRequest, RouteResult,
} from './api';
import { findCandidates, now } from './candidates';
import type { CellLookup } from './cells';
import { IdbCellLookup } from './cells-idb';
import { Graph } from './graph';
import type { RegionManifest } from './graph-format';
import { findLoops } from './loop';
import { NoveltyScorer } from './novelty';
import { Searcher } from './search';
import { SpatialIndex } from './spatial';
import { TileSource, type TileSourceOptions, type TileSourcePerf } from './tiles-source';

const DEG = Math.PI / 180;
export const MAX_AREA_RADIUS_KM = 8;

/** No graph tile has data for the request. Crosses Comlink with name + message intact. */
export class NoCoverageError extends Error {
  constructor(public missingTiles: number) {
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
}

export class RouteEngine implements RouteApi {
  readonly tiles: TileSource;
  readonly cells: CellLookup & { prepare?(bbox: BBox): Promise<number>; invalidate?(): void };
  private readonly graphs: CachedGraph[] = [];
  private readonly graphCacheSize: number;
  cellVersion = 0;
  perf: RoutePerf | null = null;
  private lastGraphPhase = { tilesMs: 0, mergeMs: 0, spatialMs: 0, hit: false };

  constructor(opts: EngineOptions = {}) {
    this.tiles = new TileSource(opts.tiles);
    this.cells = opts.cells ?? new IdbCellLookup();
    this.graphCacheSize = opts.graphCache ?? 2;
  }

  async init(baseUrl: string): Promise<void> {
    await this.tiles.init(baseUrl);
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
    // Agent D's modules (wave 1): imported lazily so the worker boots without them and tests do not depend on them.
    const [{ fetchOverpassWays }, { buildGraphTiles }] = await Promise.all([import('./overpass'), import('./graph-build')]);
    const bbox = circleBBox(center, radiusKm);
    onProgress?.({ phase: 'fetch', done: 0, total: 1 });
    const ways = await fetchOverpassWays(bbox);
    onProgress?.({ phase: 'fetch', done: 1, total: 1 });
    onProgress?.({ phase: 'build', done: 0, total: 1 });
    const built = buildGraphTiles(ways);
    onProgress?.({ phase: 'build', done: 1, total: 1 });
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

  /** Merged graph for a bbox (cached by tile set). Throws when no tile has data. */
  async graphFor(bbox: BBox): Promise<CachedGraph> {
    const tStart = now();
    const { tiles, keys, missing } = await this.tiles.tilesFor(bbox);
    const tilesMs = now() - tStart;
    if (tiles.length === 0) throw new NoCoverageError(missing.length);
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
    const c = await this.graphFor(bbox);
    const t1 = now();
    const prepared = (await this.prepareCells(c)) ?? 0;
    const t2 = now();
    const res = findCandidates(c.graph, this.cells, req, { spatial: c.spatial, scorer: c.scorer, searcher: c.searcher, graphTiles: c.graph.tileKeys.length });
    res.ms = Math.round(now() - t0);
    this.recordPerf(c, t2 - t1, prepared, now() - t2, res.ms);
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
    };
  }

  async invalidateCells(version: number): Promise<void> {
    this.cellVersion = version;
    this.cells.invalidate?.();
    for (const c of this.graphs) c.scorer.invalidate();
  }
}
