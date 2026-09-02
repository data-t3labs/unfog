/**
 * Where graph tiles come from:
 *   1. an in-memory LRU of decoded tiles,
 *   2. prebuilt regions served from `${baseUrl}graph/<region>/12/<x>/<y>.ufg` (the service worker
 *      caches them; `downloadRegion` pre-fills that cache so a region works offline),
 *   3. areas the user downloaded via Overpass, packed and kept in IndexedDB `unfog-graph`
 *      (store `tiles` key "<x>/<y>", store `areas`).
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { BBox, CoverageReport, DownloadProgress, LonLat } from './api';
import {
  GRAPH_ZOOM, graphTilePath, lonLatToGraphTile, packGraphTile, unpackGraphTile,
  type GraphTile, type GraphTileInput, type RegionManifest,
} from './graph-format';

export const GRAPH_DB = 'unfog-graph';
export const GRAPH_CACHE = 'graph';

export interface DownloadedTile {
  key: string; // "x/y"
  x: number;
  y: number;
  /** Packed (deflated) UFG1 bytes. */
  bytes: Uint8Array;
  areaId: string;
}

export interface AreaRecord {
  id: string;
  center: LonLat;
  radiusKm: number;
  tiles: number;
  bytes: number;
  builtAt: string;
}

interface GraphDb extends DBSchema {
  tiles: { key: string; value: DownloadedTile };
  areas: { key: string; value: AreaRecord };
}

export const tileKeyOf = (x: number, y: number): string => `${x}/${y}`;

/** z12 tile keys intersecting a bbox (row-major). */
export function graphTilesFor(bbox: BBox): Array<[x: number, y: number]> {
  const [x0, y0] = lonLatToGraphTile(bbox[0], bbox[3]);
  const [x1, y1] = lonLatToGraphTile(bbox[2], bbox[1]);
  const out: Array<[number, number]> = [];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.push([x, y]);
  return out;
}

export interface TileSourceOptions {
  /** Decoded tiles kept in memory. Default 24 (a dense city tile decodes to ~2 MB). */
  memoryTiles?: number;
  fetch?: typeof fetch;
}

export class TileSource {
  baseUrl = '/';
  private regions: RegionManifest[] = [];
  private readonly prebuilt = new Map<string, { region: string; bytes: number }>();
  private readonly memory = new Map<string, GraphTile>();
  private readonly memoryTiles: number;
  private readonly fetchFn: typeof fetch | null;
  private db: Promise<IDBPDatabase<GraphDb> | null> | null = null;
  private downloadedKeys: Set<string> | null = null;

  constructor(opts: TileSourceOptions = {}) {
    this.memoryTiles = opts.memoryTiles ?? 24;
    this.fetchFn = opts.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  }

  /** Load the prebuilt region index. Missing index = no prebuilt regions (not an error). */
  async init(baseUrl: string): Promise<void> {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.regions = [];
    this.prebuilt.clear();
    if (!this.fetchFn) return;
    let ids: string[] = [];
    let inline: RegionManifest[] = [];
    try {
      const res = await this.fetchFn(`${this.baseUrl}graph/index.json`);
      if (!res.ok) return;
      const json = (await res.json()) as unknown;
      const list = Array.isArray(json) ? json : (json as { regions?: unknown[] })?.regions ?? [];
      for (const item of list) {
        if (typeof item === 'string') ids.push(item);
        else if (item && typeof item === 'object' && 'tiles' in item) inline.push(item as RegionManifest);
        else if (item && typeof item === 'object' && 'id' in item) ids.push(String((item as { id: unknown }).id));
      }
    } catch {
      return;
    }
    const manifests = await Promise.all(ids.map(async (id) => {
      try {
        const res = await this.fetchFn!(`${this.baseUrl}graph/${id}/manifest.json`);
        return res.ok ? ((await res.json()) as RegionManifest) : null;
      } catch {
        return null;
      }
    }));
    for (const m of [...inline, ...manifests]) if (m) this.addRegion(m);
  }

  /** Register a region manifest (init does this; tests/tools may add more). */
  addRegion(m: RegionManifest): void {
    this.regions = this.regions.filter((r) => r.id !== m.id).concat(m);
    for (const [x, y, bytes] of m.tiles) this.prebuilt.set(tileKeyOf(x, y), { region: m.id, bytes });
  }

  listRegions(): RegionManifest[] {
    return this.regions.slice();
  }

  regionOf(x: number, y: number): string | undefined {
    return this.prebuilt.get(tileKeyOf(x, y))?.region;
  }

  private openDb(): Promise<IDBPDatabase<GraphDb> | null> {
    if (!this.db) {
      this.db = (async () => {
        if (typeof indexedDB === 'undefined') return null;
        try {
          return await openDB<GraphDb>(GRAPH_DB, 1, {
            upgrade(db) {
              db.createObjectStore('tiles', { keyPath: 'key' });
              db.createObjectStore('areas', { keyPath: 'id' });
            },
          });
        } catch {
          return null;
        }
      })();
    }
    return this.db;
  }

  private async downloadedKeySet(): Promise<Set<string>> {
    if (this.downloadedKeys) return this.downloadedKeys;
    const db = await this.openDb();
    const keys = db ? await db.getAllKeys('tiles') : [];
    this.downloadedKeys = new Set(keys);
    return this.downloadedKeys;
  }

  async coverage(bbox: BBox): Promise<CoverageReport> {
    const wanted = graphTilesFor(bbox);
    const downloaded = await this.downloadedKeySet();
    const regions = new Set<string>();
    let available = 0;
    for (const [x, y] of wanted) {
      const k = tileKeyOf(x, y);
      const p = this.prebuilt.get(k);
      if (p) { regions.add(p.region); available++; } else if (downloaded.has(k) || this.memory.has(k)) available++;
    }
    return { needed: wanted.length, available, regions: [...regions] };
  }

  /** Decoded tiles for a bbox; tiles with no data are listed in `missing`. */
  async tilesFor(bbox: BBox): Promise<{ tiles: GraphTile[]; keys: string[]; missing: string[] }> {
    const wanted = graphTilesFor(bbox);
    const tiles: GraphTile[] = [], keys: string[] = [], missing: string[] = [];
    for (const [x, y] of wanted) {
      const t = await this.getTile(x, y);
      const k = tileKeyOf(x, y);
      if (t) { tiles.push(t); keys.push(k); } else missing.push(k);
    }
    return { tiles, keys, missing };
  }

  /** One decoded tile from memory → prebuilt → downloads, or null. */
  async getTile(x: number, y: number): Promise<GraphTile | null> {
    const k = tileKeyOf(x, y);
    const cached = this.memory.get(k);
    if (cached) { this.memory.delete(k); this.memory.set(k, cached); return cached; }
    let tile: GraphTile | null = null;
    const p = this.prebuilt.get(k);
    if (p && this.fetchFn) {
      try {
        const res = await this.fetchFn(this.tileUrl(p.region, x, y));
        if (res.ok) tile = unpackGraphTile(new Uint8Array(await res.arrayBuffer()));
      } catch {
        tile = null;
      }
    }
    if (!tile) {
      const db = await this.openDb();
      const rec = db ? await db.get('tiles', k) : undefined;
      if (rec) {
        try { tile = unpackGraphTile(rec.bytes); } catch { tile = null; }
      }
    }
    if (tile) this.remember(k, tile);
    return tile;
  }

  private remember(k: string, tile: GraphTile): void {
    this.memory.set(k, tile);
    while (this.memory.size > this.memoryTiles) {
      const oldest = this.memory.keys().next().value as string;
      this.memory.delete(oldest);
    }
  }

  tileUrl(region: string, x: number, y: number): string {
    return `${this.baseUrl}graph/${region}/${graphTilePath(x, y, GRAPH_ZOOM)}`;
  }

  /** Fetch every tile of a prebuilt region into the graph cache (Cache API when available). */
  async downloadRegion(regionId: string, onProgress?: (p: DownloadProgress) => void): Promise<{ tiles: number; bytes: number }> {
    const m = this.regions.find((r) => r.id === regionId);
    if (!m) throw new Error(`Unknown region ${regionId}`);
    if (!this.fetchFn) throw new Error('fetch unavailable');
    const cache = typeof caches !== 'undefined' ? await caches.open(GRAPH_CACHE).catch(() => null) : null;
    const total = m.tiles.length;
    let bytes = 0, done = 0;
    onProgress?.({ phase: 'fetch', done, total });
    for (const [x, y, size] of m.tiles) {
      const url = this.tileUrl(regionId, x, y);
      let hit = cache ? await cache.match(url) : undefined;
      if (!hit) {
        const res = await this.fetchFn(url);
        if (!res.ok) throw new Error(`Tile ${x}/${y} of ${regionId}: HTTP ${res.status}`);
        if (cache) await cache.put(url, res.clone());
        hit = res;
        bytes += size || Number(res.headers.get('content-length')) || 0;
      } else {
        bytes += size;
      }
      done++;
      onProgress?.({ phase: 'fetch', done, total });
    }
    return { tiles: total, bytes };
  }

  /** Pack and store a built area (replaces an area with the same id). */
  async storeArea(
    area: Omit<AreaRecord, 'tiles' | 'bytes' | 'builtAt'>,
    tiles: Map<string, GraphTileInput>,
    onProgress?: (p: DownloadProgress) => void,
  ): Promise<AreaRecord> {
    const db = await this.openDb();
    if (!db) throw new Error('IndexedDB unavailable: cannot store downloaded areas');
    await this.deleteDownload(area.id);
    const total = tiles.size;
    let bytes = 0, done = 0;
    onProgress?.({ phase: 'store', done, total });
    const packed: DownloadedTile[] = [];
    for (const [key, t] of tiles) {
      const data = packGraphTile(t);
      bytes += data.length;
      packed.push({ key: tileKeyOf(t.tx, t.ty), x: t.tx, y: t.ty, bytes: data, areaId: area.id });
      void key;
      done++;
      onProgress?.({ phase: 'store', done, total });
    }
    const rec: AreaRecord = { ...area, tiles: total, bytes, builtAt: new Date().toISOString() };
    const tx = db.transaction(['tiles', 'areas'], 'readwrite');
    for (const p of packed) { await tx.objectStore('tiles').put(p); this.memory.delete(p.key); }
    await tx.objectStore('areas').put(rec);
    await tx.done;
    this.downloadedKeys = null;
    return rec;
  }

  async listDownloads(): Promise<AreaRecord[]> {
    const db = await this.openDb();
    return db ? db.getAll('areas') : [];
  }

  async deleteDownload(id: string): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    const tx = db.transaction(['tiles', 'areas'], 'readwrite');
    const tiles = tx.objectStore('tiles');
    for (const rec of await tiles.getAll()) {
      if (rec.areaId === id) { await tiles.delete(rec.key); this.memory.delete(rec.key); }
    }
    await tx.objectStore('areas').delete(id);
    await tx.done;
    this.downloadedKeys = null;
  }

  /** Drop decoded tiles from memory (tests / memory pressure). */
  clearMemory(): void {
    this.memory.clear();
  }

  async close(): Promise<void> {
    const db = this.db ? await this.db : null;
    db?.close();
    this.db = null;
    this.downloadedKeys = null;
  }
}
