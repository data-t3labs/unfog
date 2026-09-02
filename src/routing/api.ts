/**
 * Contract between the main thread and the route worker (Comlink). Fixed in wave 0. The worker
 * (src/routing/route.worker.ts) loads graph tiles (prebuilt regions from `${baseUrl}graph/` or
 * areas downloaded via Overpass and cached in IndexedDB `unfog-graph`), scores novelty against
 * the cell store (IndexedDB `unfog`, read-only), and searches.
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
}

export type CandidateName = 'Most new' | 'Balanced' | 'Direct';

export interface RouteCandidate {
  name: CandidateName;
  coords: LonLat[];
  lengthM: number;
  /** Metres of never-visited road along the route (Σ nov·len). */
  newM: number;
  /** 0..100 */
  pctNew: number;
  lambda: number;
  /** Walking 4.8 km/h, cycling 15 km/h, driving 30 km/h city average. */
  etaMin: number;
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
}

export interface CoverageReport {
  /** Graph tiles needed for the bbox. */
  needed: number;
  /** Tiles available (prebuilt region, cached download, or in memory). */
  available: number;
  /** Region ids that cover part of the bbox. */
  regions: string[];
}

export interface DownloadProgress {
  phase: 'fetch' | 'build' | 'store';
  done: number;
  total: number;
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
   * Always resolves with ≥ 1 candidate (Direct last). Rejects, with `name` intact, on
   * NoCoverageError (no tiles), SnapError (no road for the mode within 300 m of an end) or
   * NoRouteError (ends snapped but no path between them for the mode).
   */
  route(req: RouteRequest): Promise<RouteResult>;
  loop(req: LoopRequest): Promise<RouteResult>;
  /** The cell store changed (import / recording): drop cached novelty. */
  invalidateCells(version: number): Promise<void>;
}
