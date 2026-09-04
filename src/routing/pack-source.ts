/**
 * PackSource — graph tiles from published z6 packs (coverage v2; format in pack-format.ts).
 *
 *   packs-index.json  (cells → pack URL + sizes; cached in IndexedDB with an age)
 *     └─ pack index   (first `indexBytes` of the pack, ONE range request; cached per cell)
 *         └─ tiles    (byte-range requests, coalesced per pack; cached in IndexedDB `unfog-packs`
 *                      store `tiles` keyed "x/y", with size + lastUsed for LRU eviction)
 *
 * Wired (coverage v2): RouteEngine constructs one next to TileSource and installs it as the
 * TileSource fallback (memory → prebuilt region → downloaded area → pack cache); a route request
 * first fetches the box's missing tiles in one coalesced round per pack (engine.ts graphFor), and
 * the main thread's prefetch driver keeps the 5×5 ring around the user warm through RouteApi's
 * `packs*` methods. Own database (`unfog-packs`, not `unfog-graph`) so this file never has to bump
 * the version of the database tiles-source.ts opens at v1.
 *
 * Hosting (measured 2026-09-02): GitHub release assets answer `Range` with 206 but carry NO CORS
 * headers on either hop (github.com 302 → release-assets.githubusercontent.com), so a browser on
 * data-t3labs.github.io cannot read them ("Failed to fetch"). The release is the storage of
 * record; the app reads packs mirrored onto GitHub Pages on ITS OWN ORIGIN
 * (`${baseUrl}graph/packs/`, see tools/build-graph/mirror-packs.mjs), where Range → 206 was
 * verified. packs-index.json carries an absolute URL per pack, so sharding across several Pages
 * sites of the same account (same origin) needs no client change. A server that ignores Range
 * (200 + whole body) still works: the body is sliced (perf.fullBodies).
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { BBox, PackCacheCell, PackCacheStatus } from './api';
import { GRAPH_ZOOM, lonLatToGraphTile, unpackGraphTile, type GraphTile } from './graph-format';
import {
  LABEL_GRID_ZOOM, PACK_ZOOM, cellKey, cellOf, coalesceRanges, parsePackIndex, rangeHeader, sliceEntry,
  type ByteRange, type PackEntry, type PackInfo, type PacksIndex,
} from './pack-format';

export const PACKS_DB = 'unfog-packs';
/** packs-index.json on the app's own origin: `${baseUrl}graph/packs/packs-index.json` (baseUrl = import.meta.env.BASE_URL). */
export const packsIndexUrl = (baseUrl: string): string => `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}graph/packs/packs-index.json`;
/** Where the release-asset copy lives (tools + curl only: not readable from a browser, no CORS). */
export const RELEASE_PACKS_INDEX_URL = 'https://github.com/data-t3labs/unfog/releases/download/graphs-v1/packs-index.json';

export interface CachedTile {
  key: string; // "x/y"
  x: number;
  y: number;
  cell: string;
  /** Packed (deflated) UFG1 bytes. */
  bytes: Uint8Array;
  size: number;
  lastUsed: number;
  builtAt: string;
}

interface IndexRecord { key: 'packs-index'; index: PacksIndex; fetchedAt: number }
interface PackIndexRecord { key: string; builtAt: string; sha256?: string; entries: Array<[tx: number, ty: number, offset: number, length: number]> }

interface PacksDb extends DBSchema {
  meta: { key: string; value: IndexRecord };
  packIndex: { key: string; value: PackIndexRecord };
  tiles: { key: string; value: CachedTile; indexes: { lastUsed: number } };
}

export interface PackSourceOptions {
  indexUrl?: string;
  fetch?: typeof fetch;
  /** Re-fetch packs-index.json when the cached copy is older than this (default 24 h). */
  indexMaxAgeMs?: number;
  /** Decoded tiles kept in memory (default 24). */
  memoryTiles?: number;
  /** Concurrent range requests (default 4). */
  concurrency?: number;
  now?: () => number;
  /** Byte gap below which neighbouring tiles share one range request (default 32 KB). */
  maxGap?: number;
  /** IndexedDB database name (default `unfog-packs`; tests use one per case). */
  dbName?: string;
}

export interface PackSourcePerf {
  memoryHits: number;
  idbHits: number;
  rangeRequests: number;
  /** Servers that answered 200 to a Range request (whole pack downloaded and sliced). */
  fullBodies: number;
  fetchedTiles: number;
  fetchBytes: number;
  fetchMs: number;
  unpackMs: number;
  indexFetches: number;
}

export interface FetchTilesResult {
  fetched: number;
  bytes: number;
  /** Tiles no pack covers. */
  uncovered: string[];
  /** Tiles a pack covers but the fetch failed for (network). */
  failed: string[];
  alreadyCached: number;
}

export const tileKeyOf = (x: number, y: number): string => `${x}/${y}`;

const perfNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** z12 tile keys intersecting a bbox (row-major) — same as tiles-source.ts's graphTilesFor. */
export function tilesInBBox(bbox: BBox, zoom = GRAPH_ZOOM): Array<[x: number, y: number]> {
  const [x0, y0] = lonLatToGraphTile(bbox[0], bbox[3], zoom);
  const [x1, y1] = lonLatToGraphTile(bbox[2], bbox[1], zoom);
  const out: Array<[number, number]> = [];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.push([x, y]);
  return out;
}

export class PackSource {
  readonly perf: PackSourcePerf = { memoryHits: 0, idbHits: 0, rangeRequests: 0, fullBodies: 0, fetchedTiles: 0, fetchBytes: 0, fetchMs: 0, unpackMs: 0, indexFetches: 0 };
  private index: PacksIndex | null = null;
  private indexFetchedAt = 0;
  /** packs-index.json location; the engine sets it from the app's base URL before init(). */
  indexUrl: string;
  private readonly fetchFn: typeof fetch | null;
  private readonly indexMaxAgeMs: number;
  private readonly memoryTiles: number;
  private readonly concurrency: number;
  private readonly maxGap: number;
  private readonly dbName: string;
  private readonly now: () => number;
  private readonly memory = new Map<string, GraphTile>();
  private readonly packIndexes = new Map<string, PackEntry[]>();
  private readonly packIndexLoads = new Map<string, Promise<PackEntry[] | null>>();
  private db: Promise<IDBPDatabase<PacksDb> | null> | null = null;
  private cachedKeys: Set<string> | null = null;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: PackSourceOptions = {}) {
    this.indexUrl = opts.indexUrl ?? packsIndexUrl('/');
    this.fetchFn = opts.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.indexMaxAgeMs = opts.indexMaxAgeMs ?? 24 * 60 * 60 * 1000;
    this.memoryTiles = opts.memoryTiles ?? 24;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.maxGap = opts.maxGap ?? 32 * 1024;
    this.dbName = opts.dbName ?? PACKS_DB;
    this.now = opts.now ?? (() => Date.now());
  }

  // ---- packs-index.json -------------------------------------------------------------------

  /**
   * Load the packs index: IndexedDB copy first, refreshed from the network when older than the max
   * age. Never throws. With `refreshTimeoutMs`, init resolves after that long even if the network
   * refresh is still running (it keeps going and lands the index when it arrives) — the engine's
   * init must not let a slow packs-index.json stall the app's boot.
   */
  async init(opts: { refreshTimeoutMs?: number } = {}): Promise<void> {
    const db = await this.openDb();
    const rec = db ? await db.get('meta', 'packs-index') : undefined;
    if (rec) { this.index = rec.index; this.indexFetchedAt = rec.fetchedAt; }
    if (this.index && this.now() - this.indexFetchedAt <= this.indexMaxAgeMs) return;
    const refresh = this.refreshIndex();
    this.refreshing = refresh;
    if (opts.refreshTimeoutMs === undefined) { await refresh; return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([refresh, new Promise<void>((r) => { timer = setTimeout(r, opts.refreshTimeoutMs); })]);
    clearTimeout(timer);
  }

  /** The index refresh started by init() (resolved or still in flight); tests await it. */
  get indexRefresh(): Promise<boolean> | null { return this.refreshing; }
  private refreshing: Promise<boolean> | null = null;

  /** Fetch packs-index.json now; a failure keeps the cached copy (returns false). */
  async refreshIndex(): Promise<boolean> {
    if (!this.fetchFn) return false;
    try {
      // `no-cache` revalidates the HTTP cache; the service worker's runtime rules leave this path
      // alone (vite.config.ts) so a stale index never comes out of a CacheFirst cache. A hung
      // connection is cut after 30 s so a later init() can try again.
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined;
      const res = await this.fetchFn(this.indexUrl, { cache: 'no-cache', signal });
      if (!res.ok) return false;
      const json = (await res.json()) as PacksIndex;
      if (!json || json.version !== 1 || typeof json.packs !== 'object') return false;
      this.perf.indexFetches++;
      const changed = new Set<string>();
      for (const [k, p] of Object.entries(json.packs)) {
        const old = this.index?.packs[k];
        if (old && (old.sha256 ?? old.builtAt) !== (p.sha256 ?? p.builtAt)) changed.add(k);
      }
      this.index = json;
      this.indexFetchedAt = this.now();
      for (const k of changed) this.packIndexes.delete(k);
      const db = await this.openDb();
      if (db) {
        await db.put('meta', { key: 'packs-index', index: json, fetchedAt: this.indexFetchedAt });
        for (const k of changed) await db.delete('packIndex', k);
      }
      return true;
    } catch {
      return false;
    }
  }

  get packsIndex(): PacksIndex | null { return this.index; }
  get indexAgeMs(): number { return this.index ? this.now() - this.indexFetchedAt : Infinity; }

  /** The pack covering a z12 tile, if any. */
  packFor(x: number, y: number): (PackInfo & { key: string }) | undefined {
    if (!this.index) return undefined;
    const [cx, cy] = cellOf(x, y, this.index.zoom ?? GRAPH_ZOOM, this.index.packZoom ?? PACK_ZOOM);
    const key = cellKey(cx, cy, this.index.packZoom ?? PACK_ZOOM);
    const p = this.index.packs[key];
    return p ? { ...p, key } : undefined;
  }

  /** A published pack covers this z12 tile (it may still be empty there: open water has no entry). */
  covers(x: number, y: number): boolean {
    return this.packFor(x, y) !== undefined;
  }

  /**
   * What the cache holds, grouped by cell, plus the index age (the Data screen's "Routing data").
   * Each cell also lists its tiles by z10 sub-cell (`sub`) so the Data screen can name the one
   * region the cached streets are in (src/app/pack-label.ts) instead of every extract that
   * touched the cell.
   */
  async status(): Promise<PackCacheStatus> {
    const byCell = new Map<string, PackCacheCell>();
    const subs = new Map<string, Map<string, [x: number, y: number, tiles: number, lastUsed: number]>>();
    const shift = GRAPH_ZOOM - LABEL_GRID_ZOOM;
    let totalBytes = 0, totalTiles = 0;
    for (const t of await this.listCached()) {
      let c = byCell.get(t.cell);
      if (!c) { c = { cell: t.cell, tiles: 0, bytes: 0, lastUsed: 0, source: this.index?.packs[t.cell]?.source, sub: [] }; byCell.set(t.cell, c); subs.set(t.cell, new Map()); }
      c.tiles++; c.bytes += t.size; c.lastUsed = Math.max(c.lastUsed, t.lastUsed);
      const sub = subs.get(t.cell)!;
      const sx = t.x >> shift, sy = t.y >> shift, sk = `${sx}/${sy}`;
      const s = sub.get(sk);
      if (s) { s[2]++; s[3] = Math.max(s[3], t.lastUsed); } else sub.set(sk, [sx, sy, 1, t.lastUsed]);
      totalBytes += t.size; totalTiles++;
    }
    for (const [cell, sub] of subs) byCell.get(cell)!.sub = [...sub.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const cells = [...byCell.values()].sort((a, b) => b.lastUsed - a.lastUsed);
    return { indexAgeMs: this.indexAgeMs, indexCells: this.index ? Object.keys(this.index.packs).length : 0, cells, totalBytes, totalTiles };
  }

  // ---- IndexedDB ---------------------------------------------------------------------------

  private openDb(): Promise<IDBPDatabase<PacksDb> | null> {
    if (!this.db) {
      this.db = (async () => {
        if (typeof indexedDB === 'undefined') return null;
        try {
          return await openDB<PacksDb>(this.dbName, 1, {
            upgrade(db) {
              db.createObjectStore('meta', { keyPath: 'key' });
              db.createObjectStore('packIndex', { keyPath: 'key' });
              db.createObjectStore('tiles', { keyPath: 'key' }).createIndex('lastUsed', 'lastUsed');
            },
          });
        } catch {
          return null;
        }
      })();
    }
    return this.db;
  }

  private async keySet(): Promise<Set<string>> {
    if (this.cachedKeys) return this.cachedKeys;
    const db = await this.openDb();
    this.cachedKeys = new Set(db ? await db.getAllKeys('tiles') : []);
    return this.cachedKeys;
  }

  async hasTile(x: number, y: number): Promise<boolean> {
    const k = tileKeyOf(x, y);
    return this.memory.has(k) || (await this.keySet()).has(k);
  }

  /** Every cached tile with its size and last use (for budgets / the Data screen). */
  async listCached(): Promise<Array<{ key: string; x: number; y: number; cell: string; size: number; lastUsed: number; builtAt: string }>> {
    const db = await this.openDb();
    if (!db) return [];
    const out: Array<{ key: string; x: number; y: number; cell: string; size: number; lastUsed: number; builtAt: string }> = [];
    let cur = await db.transaction('tiles').store.openCursor();
    while (cur) {
      const v = cur.value;
      out.push({ key: v.key, x: v.x, y: v.y, cell: v.cell, size: v.size, lastUsed: v.lastUsed, builtAt: v.builtAt });
      cur = await cur.continue();
    }
    return out;
  }

  async cachedBytes(): Promise<number> {
    return (await this.listCached()).reduce((n, t) => n + t.size, 0);
  }

  async evict(keys: string[]): Promise<void> {
    const db = await this.openDb();
    if (!db || !keys.length) return;
    const tx = db.transaction('tiles', 'readwrite');
    for (const k of keys) { await tx.store.delete(k); this.memory.delete(k); this.cachedKeys?.delete(k); }
    await tx.done;
  }

  /** Drop every cached tile and pack index (the packs index itself stays unless `all`). */
  async clear(all = false): Promise<void> {
    const db = await this.openDb();
    if (db) { await db.clear('tiles'); await db.clear('packIndex'); if (all) await db.clear('meta'); }
    this.memory.clear();
    this.packIndexes.clear();
    this.cachedKeys = new Set();
    if (all) { this.index = null; this.indexFetchedAt = 0; }
  }

  // ---- pack index --------------------------------------------------------------------------

  /** Entries of a pack (cached in memory + IndexedDB); null when offline/unavailable. */
  async packIndex(cell: string): Promise<PackEntry[] | null> {
    const hit = this.packIndexes.get(cell);
    if (hit) return hit;
    let load = this.packIndexLoads.get(cell);
    if (!load) {
      load = this.loadPackIndex(cell).finally(() => this.packIndexLoads.delete(cell));
      this.packIndexLoads.set(cell, load);
    }
    return load;
  }

  private async loadPackIndex(cell: string): Promise<PackEntry[] | null> {
    const info = this.index?.packs[cell];
    if (!info) return null;
    const db = await this.openDb();
    const rec = db ? await db.get('packIndex', cell) : undefined;
    if (rec && rec.builtAt === info.builtAt && (rec.sha256 ?? null) === (info.sha256 ?? null)) {
      const entries = rec.entries.map(([tx, ty, offset, length]) => ({ tx, ty, offset, length }));
      this.packIndexes.set(cell, entries);
      return entries;
    }
    if (!this.fetchFn) return null;
    try {
      const body = await this.fetchRange(info.url, { start: 0, end: info.indexBytes }, info.bytes);
      const parsed = parsePackIndex(body);
      this.packIndexes.set(cell, parsed.entries);
      if (db) await db.put('packIndex', { key: cell, builtAt: info.builtAt, sha256: info.sha256, entries: parsed.entries.map((e) => [e.tx, e.ty, e.offset, e.length]) });
      return parsed.entries;
    } catch {
      return null;
    }
  }

  // ---- range fetch -------------------------------------------------------------------------

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.concurrency) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
    try { return await fn(); } finally { this.inFlight--; this.waiters.shift()?.(); }
  }

  /** One range request; tolerates servers that ignore Range (200 + whole body → sliced). */
  private fetchRange(url: string, r: { start: number; end: number }, totalBytes?: number): Promise<Uint8Array> {
    return this.slot(async () => {
      const t0 = perfNow();
      const res = await this.fetchFn!(url, { headers: { Range: rangeHeader(r) } });
      this.perf.rangeRequests++;
      let body: Uint8Array;
      if (res.status === 206) {
        body = new Uint8Array(await res.arrayBuffer());
        const cr = res.headers.get('content-range');
        const m = cr ? /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(cr) : null;
        if (m && Number(m[1]) !== r.start) throw new Error(`range mismatch: asked ${rangeHeader(r)}, got ${cr}`);
      } else if (res.status === 200) {
        const full = new Uint8Array(await res.arrayBuffer());
        this.perf.fullBodies++;
        if (totalBytes !== undefined && full.length !== totalBytes && full.length < r.end) throw new Error(`unexpected body length ${full.length}`);
        body = full.length >= r.end ? full.subarray(r.start, r.end) : full;
      } else {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      this.perf.fetchMs += perfNow() - t0;
      this.perf.fetchBytes += body.length;
      if (body.length < r.end - r.start) throw new Error(`short range body: ${body.length} < ${r.end - r.start}`);
      return body;
    });
  }

  /**
   * Fetch (and cache) the packed bytes of the given tiles that are not cached yet. Tiles are
   * grouped per pack and coalesced into byte ranges. Never throws for network errors: they are
   * reported per tile in `failed`.
   */
  async fetchTiles(wanted: Array<[x: number, y: number]>): Promise<FetchTilesResult> {
    const result: FetchTilesResult = { fetched: 0, bytes: 0, uncovered: [], failed: [], alreadyCached: 0 };
    const cached = await this.keySet();
    const perPack = new Map<string, { info: PackInfo; keys: Set<string> }>();
    for (const [x, y] of wanted) {
      const k = tileKeyOf(x, y);
      if (cached.has(k) || this.memory.has(k)) { result.alreadyCached++; continue; }
      const p = this.packFor(x, y);
      if (!p) { result.uncovered.push(k); continue; }
      let g = perPack.get(p.key);
      if (!g) { g = { info: p, keys: new Set() }; perPack.set(p.key, g); }
      g.keys.add(k);
    }
    if (!this.fetchFn) { for (const g of perPack.values()) result.failed.push(...g.keys); return result; }
    const db = await this.openDb();
    await Promise.all([...perPack].map(async ([cell, g]) => {
      const entries = await this.packIndex(cell);
      if (!entries) { result.failed.push(...g.keys); return; }
      const byKey = new Map(entries.map((e) => [tileKeyOf(e.tx, e.ty), e]));
      const want: PackEntry[] = [];
      for (const k of g.keys) { const e = byKey.get(k); if (e) want.push(e); else result.uncovered.push(k); }
      const ranges = coalesceRanges(want, this.maxGap);
      await Promise.all(ranges.map(async (r: ByteRange) => {
        let body: Uint8Array;
        try { body = await this.fetchRange(g.info.url, r, g.info.bytes); } catch { result.failed.push(...r.entries.map((e) => tileKeyOf(e.tx, e.ty))); return; }
        const now = this.now();
        const records: CachedTile[] = r.entries.map((e) => ({ key: tileKeyOf(e.tx, e.ty), x: e.tx, y: e.ty, cell, bytes: sliceEntry(body, r, e).slice(), size: e.length, lastUsed: now, builtAt: g.info.builtAt }));
        if (db) {
          try {
            const tx = db.transaction('tiles', 'readwrite');
            for (const rec of records) await tx.store.put(rec);
            await tx.done;
          } catch {
            // IndexedDB refused (quota, a closed connection): these tiles are not on the device —
            // report them failed like a network error, so a route uses what is cached instead of throwing.
            result.failed.push(...records.map((rec) => rec.key));
            return;
          }
        }
        for (const rec of records) { cached.add(rec.key); result.fetched++; result.bytes += rec.size; this.perf.fetchedTiles++; }
      }));
    }));
    return result;
  }

  // ---- decoded tiles -----------------------------------------------------------------------

  /** Decoded tile: memory → IndexedDB → (when `network`, default true) the pack. */
  async getTile(x: number, y: number, opts: { network?: boolean } = {}): Promise<GraphTile | null> {
    const k = tileKeyOf(x, y);
    const hit = this.memory.get(k);
    if (hit) { this.memory.delete(k); this.memory.set(k, hit); this.perf.memoryHits++; return hit; }
    let rec = await this.readRecord(k);
    if (!rec && opts.network !== false) {
      await this.fetchTiles([[x, y]]);
      rec = await this.readRecord(k);
    }
    if (!rec) return null;
    const t0 = perfNow();
    let tile: GraphTile;
    try { tile = unpackGraphTile(rec.bytes); } catch { await this.evict([k]); return null; }
    this.perf.unpackMs += perfNow() - t0;
    this.memory.set(k, tile);
    while (this.memory.size > this.memoryTiles) this.memory.delete(this.memory.keys().next().value as string);
    return tile;
  }

  private async readRecord(k: string): Promise<CachedTile | undefined> {
    const db = await this.openDb();
    if (!db) return undefined;
    const rec = await db.get('tiles', k);
    if (rec) {
      this.perf.idbHits++;
      const now = this.now();
      if (now - rec.lastUsed > 60_000) { rec.lastUsed = now; db.put('tiles', rec).catch(() => {}); }
    }
    return rec;
  }

  /** Decoded tiles for a bbox (like TileSource.tilesFor); `missing` lists tiles with no data. */
  async tilesFor(bbox: BBox, opts: { network?: boolean } = {}): Promise<{ tiles: GraphTile[]; keys: string[]; missing: string[] }> {
    const wanted = tilesInBBox(bbox);
    if (opts.network !== false) await this.fetchTiles(wanted); // one coalesced round per pack
    const got = await Promise.all(wanted.map(([x, y]) => this.getTile(x, y, { network: false })));
    const tiles: GraphTile[] = [], keys: string[] = [], missing: string[] = [];
    wanted.forEach(([x, y], i) => { const t = got[i], k = tileKeyOf(x, y); if (t) { tiles.push(t); keys.push(k); } else missing.push(k); });
    return { tiles, keys, missing };
  }

  /** What exists for a bbox without fetching tiles: cached locally vs. available from a pack. */
  async coverage(bbox: BBox): Promise<{ needed: number; cached: number; packable: number; cells: string[] }> {
    const wanted = tilesInBBox(bbox);
    const cached = await this.keySet();
    const cells = new Set<string>();
    let c = 0, p = 0;
    for (const [x, y] of wanted) {
      const k = tileKeyOf(x, y);
      if (cached.has(k) || this.memory.has(k)) c++;
      const pack = this.packFor(x, y);
      if (pack) { p++; cells.add(pack.key); }
    }
    return { needed: wanted.length, cached: c, packable: p, cells: [...cells] };
  }

  clearMemory(): void { this.memory.clear(); }

  async close(): Promise<void> {
    const db = this.db ? await this.db : null;
    db?.close();
    this.db = null;
    this.cachedKeys = null;
  }
}
