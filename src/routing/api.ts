/**
 * Contract between the main thread and the route worker (Comlink). Fixed in wave 0. The worker
 * (src/routing/route.worker.ts) loads graph tiles (prebuilt regions from `${baseUrl}graph/`,
 * areas downloaded via Overpass and cached in IndexedDB `unfog-graph`, and — beneath both — the
 * published z6 packs of coverage v2, byte-ranged on demand and cached in IndexedDB `unfog-packs`),
 * scores novelty against the cell store (IndexedDB `unfog`, read-only), and searches.
 */
import type { Mode, RegionManifest } from './graph-format';

export type LonLat = [lon: number, lat: number];
export type BBox = [west: number, south: number, east: number, north: number];

export interface RouteRequest {
  from: LonLat;
  to: LonLat;
  mode: Mode;
  /** Detour budget as a fraction of the shortest path, e.g. 0.25 = up to +25 %. */
  detour: number;
  /** Default 3. */
  maxCandidates?: number;
  /**
   * Turn penalty for the alternatives, metres-equivalent per 90° turn (heading changes under 40°
   * are free; scaled by angle). Trades a little novelty for fewer zig-zags. Default per mode
   * (walk / bike 12, drive 0); 0 = off. Never applies to "Direct", which stays the shortest path.
   */
  turnPenaltyM?: number;
}

/**
 * A→B: "Most new" (newest distinct path within the budget), "Balanced" (best new metres per extra
 * metre), "Direct" (the shortest path, always present, always last). When the streets go round
 * something the straight line crosses (Direct's street part > 2.5 × the crow-flies distance
 * between the snaps, ≥ 1 km — a river without a walkway, an inlet the SeaBus crosses), a
 * "Straight across" candidate comes FIRST (`kind: 'gap'`): streets to an exit, a `straight` leg
 * across, streets from the entry. Loops: rank labels only — loops are ranked by pctNew, the first
 * is "Most new" and every other one "Balanced"; there is no "Direct" loop. The app shows loops as
 * "Loop A / B / C" and ignores these names in loop mode.
 */
export type CandidateName = 'Most new' | 'Balanced' | 'Direct' | 'Straight across';

/**
 * A route is a sequence of parts: `street` = on the graph; `offroad` = the straight walk between
 * a pin and the nearest usable street (the ends of every route whose pin is off the network — a
 * park lawn, a pier, a house set back from the road); `straight` = an as-the-crow-flies gap where
 * the street network does not join the two sides (different components, no coverage at one end,
 * or no coverage at all — "Route anyway"). Off-road and straight parts are drawn dashed; each
 * part is scored for novelty like an arc (cells along the line, 6 m samples).
 */
export type RoutePartKind = 'street' | 'offroad' | 'straight';

export interface RoutePart {
  kind: RoutePartKind;
  coords: LonLat[];
  lengthM: number;
  newM: number;
}

export interface RouteCandidate {
  name: CandidateName;
  /**
   * `gap` = the "Straight across" alternative to a Direct that goes round: its middle `straight`
   * part is not ground the route explores (newM 0, pctNew over the walked parts only) and not a
   * walking route for a navigation app. Absent on ordinary candidates.
   */
  kind?: 'gap';
  /** Full geometry: every part concatenated, pin to pin. */
  coords: LonLat[];
  /** Metres, every part included. */
  lengthM: number;
  /** Metres of never-visited ground along the route (Σ nov·len over every part; 0 on a `gap` candidate's straight leg). */
  newM: number;
  /** 0..100 — share of the route on never-visited ground; for `kind: 'gap'` the share of the walked parts. */
  pctNew: number;
  lambda: number;
  /**
   * Walking 4.8 km/h, cycling 15 km/h, driving 30 km/h city average; off-road legs are walked in
   * every mode, a straight gap goes at the mode's speed.
   */
  etaMin: number;
  /** The parts in order (absent from the mock engine and from loops: all street). */
  parts?: RoutePart[];
}

export interface RouteResult {
  candidates: RouteCandidate[];
  shortestM: number;
  budgetM: number;
  /** Diagnostics for the UI/debug panel. */
  graphTiles: number;
  ms: number;
}

export interface LoopRequest {
  from: LonLat;
  mode: Mode;
  /** Target loop length. */
  targetKm: number;
  maxCandidates?: number;
  /**
   * As RouteRequest.turnPenaltyM, applied to every leg. Default 0 (off): straighter legs made
   * loops thinner in the NYC sweep, not better. Opt in to trade loop shape for fewer turns.
   */
  turnPenaltyM?: number;
}

export interface CoverageReport {
  /** Graph tiles needed for the bbox. */
  needed: number;
  /** Tiles available (prebuilt region, cached download, cached pack tile, or in memory). */
  available: number;
  /** Tiles a published pack covers that are not on the device yet (fetched automatically when online). */
  packable: number;
  /** Region ids that cover part of the bbox. */
  regions: string[];
}

/** One z6 cell's worth of cached pack tiles (coverage v2), as the Data screen lists them. */
export interface PackCacheCell {
  /** Cell key "6/<cx>/<cy>". */
  cell: string;
  tiles: number;
  bytes: number;
  /** Most recent use of any tile in the cell (ms epoch). */
  lastUsed: number;
  /** Where the streets came from, e.g. "Geofabrik us/new-york 2026-09-01" (from packs-index.json; absent when the index is gone). */
  source?: string;
  /**
   * The cached tiles grouped by z10 sub-cell (pack-format.ts LABEL_GRID_ZOOM): [x, y, tiles, lastUsed],
   * sorted by key — what src/app/pack-label.ts needs to name the ONE region the cached streets are in.
   */
  sub?: Array<[x: number, y: number, tiles: number, lastUsed: number]>;
}

export interface PackCacheStatus {
  /** Age of the coverage list (packs-index.json) in ms; Infinity when none has been loaded yet. */
  indexAgeMs: number;
  /** Cells in the published coverage list (0 = no list yet). */
  indexCells: number;
  cells: PackCacheCell[];
  totalBytes: number;
  totalTiles: number;
}

/** Outcome of a pack prefetch (mirrors pack-source.ts FetchTilesResult; never rejects for network errors). */
export interface PackFetchResult {
  fetched: number;
  bytes: number;
  /** Tiles no pack covers. */
  uncovered: string[];
  /** Tiles a pack covers but the fetch failed for (network, or a shard not deployed yet). */
  failed: string[];
  alreadyCached: number;
}

export interface DownloadProgress {
  phase: 'fetch' | 'build' | 'store';
  done: number;
  total: number;
  /** Optional status for the UI, e.g. "Overpass is busy (HTTP 504) — retrying in 15 s". */
  note?: string;
}

export interface RouteApi {
  /** `import.meta.env.BASE_URL` of the app, e.g. "/unfog/". Must be called first. */
  init(baseUrl: string): Promise<void>;
  /** Manifests of the prebuilt regions (from `${baseUrl}graph/index.json`). */
  listRegions(): Promise<RegionManifest[]>;
  /** What graph data exists for a bbox, without loading it. */
  coverage(bbox: BBox): Promise<CoverageReport>;
  /** Fetch every tile of a prebuilt region into the SW/graph cache so routing works offline. */
  downloadRegion(regionId: string, onProgress?: (p: DownloadProgress) => void): Promise<{ tiles: number; bytes: number }>;
  /** Overpass → graph tiles → IndexedDB for an arbitrary area (radius ≤ 8 km). */
  downloadArea(center: LonLat, radiusKm: number, onProgress?: (p: DownloadProgress) => void): Promise<{ tiles: number; bytes: number }>;
  /** Downloaded (non-prebuilt) areas kept on device. */
  listDownloads(): Promise<Array<{ id: string; center: LonLat; radiusKm: number; tiles: number; bytes: number; builtAt: string }>>;
  deleteDownload(id: string): Promise<void>;
  /**
   * Always resolves with ≥ 1 candidate (Direct last) when any graph tile covers the request:
   * pins snap to the nearest usable street up to 5 km away (the walk there is an `offroad` part),
   * and ends the network cannot join get a `straight` part between the two sides' nearest nodes
   * instead of an error. Tiles a published pack covers are fetched first when online (coverage
   * v2); when none could be loaded but a pack covers the box (offline with nothing cached, a shard
   * not deployed yet) the result is the straight-line floor (`directLine`), not an error. Rejects,
   * with `name` intact, only on NoCoverageError (no tiles and no pack at all) — `directLine` is the
   * "route anyway" for that case.
   */
  route(req: RouteRequest): Promise<RouteResult>;
  /** The straight line between the pins as one Direct candidate, scored for novelty; needs no graph. */
  directLine(req: RouteRequest): Promise<RouteResult>;
  /**
   * Round trips from `from` of about `targetKm` (each within ±25 %), ranked by pctNew — new metres
   * per metre — with ties (same integer pctNew) broken towards the length closest to the target.
   * May resolve with an empty list when no loop fits. Names are rank labels (see CandidateName).
   */
  loop(req: LoopRequest): Promise<RouteResult>;
  /** The cell store changed (import / recording): drop cached novelty. */
  invalidateCells(version: number): Promise<void>;

  // ---- pack cache (coverage v2). The worker owns IndexedDB `unfog-packs`; the main thread's
  // prefetch driver (src/app/prefetch-driver.ts) and the Data screen go through these.

  /** A pack tile is on the device (memory or IndexedDB). */
  packsHasTile(x: number, y: number): Promise<boolean>;
  /** Fetch + cache the given z12 tiles from their packs (one coalesced round per pack; cached ones skipped). */
  packsFetchTiles(tiles: Array<[x: number, y: number]>): Promise<PackFetchResult>;
  /** Every cached pack tile with size + last use (the prefetcher's eviction input). */
  packsListCached(): Promise<Array<{ key: string; x: number; y: number; cell: string; size: number; lastUsed: number }>>;
  packsEvict(keys: string[]): Promise<void>;
  /** Drop every cached pack tile (the coverage list stays; tiles come back automatically). */
  packsClear(): Promise<void>;
  /** What the pack cache holds, grouped by cell, plus the coverage list's age. */
  packsStatus(): Promise<PackCacheStatus>;
}
