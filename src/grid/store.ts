/**
 * CellStore — the storage half of GridApi. Owns every write to the `unfog` database (db.ts),
 * keeps an LRU of decoded tiles (base + overview levels) and maintains the overview pyramid and
 * the aggregate stats write-through.
 *
 * Semantics (docs/BUILD-PLAN.md §2.1):
 * - FoW / backup cell tiles merge with MAX (idempotent).
 * - A track increments each touched base cell ONCE (rasteriser dedupes), saturating at 255.
 *   Re-marking an id that already exists MERGES: the stored polyline is re-rasterised and only
 *   cells it did not touch get +1, then the record is replaced by the new points. So the recorder
 *   can checkpoint a running session under one id every minute and finish with the full track
 *   without double counting, and importers with stable ids get idempotent re-imports.
 * - Overview levels 10/6/2 hold the max of their children, recomputed for the cells a changed
 *   base tile covers (16×16 level-10 cells, one level-6 cell, one level-2 cell).
 * - `deleteTrack` removes the record only; counts are NOT decremented. Counts are the union of
 *   FoW imports (which have no track record) and tracks, so a per-track undo would either be
 *   wrong (cells also covered by FoW/other tracks) or need a full replay that FoW data cannot
 *   provide. A visit happened whether or not its record is kept; "wipe everything" is the reset.
 * - Every public mutation bumps `stats.version` once and flushes before returning; mid-operation
 *   the dirty set is flushed every `flushEvery` tiles so a 10 000-tile import never holds more
 *   than ~128 decoded tiles.
 *
 * Concurrency: mutations are serialised through a promise chain (the recorder's markTrack may
 * arrive while an import runs). Reads (getTile) interleave freely; a tile loading from IndexedDB
 * never overwrites a cache entry created meanwhile by a mutation.
 */
import { deflateSync, inflateSync } from 'fflate';
import type { ApplyResult, TrackSummary } from './api';
import { cellAreaM2, distanceM, parseTileKey, tileId, tileKey, TILE_SIZE } from './cell';
import { levelKeyRange, openGridDb, type GridDb, type ImportRecord, type TileRecord, type TrackRecord } from './db';
import { DEFAULT_RASTER, rasterizeTrack, subtractRaster } from './raster';
import type { CellCounts, CellTileProvider, GridStats, ImportPayload, Level, Track } from './types';
import { decodeBackup, encodeBackup, type BackupTile } from './backup';

export const TILE_CELLS = TILE_SIZE * TILE_SIZE; // 65 536
const DEFLATE_LEVEL = 6;

export interface CellStoreOptions {
  /** Database name; tests pass a unique one. Default 'unfog'. */
  dbName?: string;
  /** Decoded tiles kept in memory (all levels, empty tiles included). Default 256 (≈16 MB). */
  cacheTiles?: number;
  /** Auto-flush when this many dirty tiles accumulate inside one operation. Default 128. */
  flushEvery?: number;
}

interface Entry {
  level: Level;
  tx: number;
  ty: number;
  /** null = known empty (negative cache). */
  counts: Uint8Array | null;
  dirty: boolean;
}

function defaultStats(): GridStats {
  return { visitedCells: 0, areaM2: 0, tiles: 0, version: 0, updatedAt: 0 };
}

export function countNonZero(u8: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < u8.length; i++) if (u8[i] !== 0) n++;
  return n;
}

/** Build the persisted track record (parallel Float64Arrays, length, time range). */
export function trackToRecord(track: Track, gapM = DEFAULT_RASTER.gapM): TrackRecord {
  const n = track.points.length;
  const lon = new Float64Array(n), lat = new Float64Array(n), t = new Float64Array(n);
  let lengthM = 0, startMs = Infinity, endMs = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = track.points[i];
    lon[i] = p[0]; lat[i] = p[1];
    const ti = p[2];
    t[i] = typeof ti === 'number' && Number.isFinite(ti) ? ti : NaN;
    if (!Number.isNaN(t[i])) { if (t[i] < startMs) startMs = t[i]; if (t[i] > endMs) endMs = t[i]; }
    if (i > 0) {
      const d = distanceM(lon[i - 1], lat[i - 1], lon[i], lat[i]);
      if (d <= gapM) lengthM += d; // a gap is a break, not distance travelled
    }
  }
  const rec: TrackRecord = { id: track.id, source: track.source, lon, lat, t, lengthM };
  if (track.name !== undefined) rec.name = track.name;
  if (startMs !== Infinity) { rec.startMs = startMs; rec.endMs = endMs; }
  return rec;
}

export function recordToTrack(rec: TrackRecord): Track {
  const points: Track['points'] = new Array(rec.lon.length);
  for (let i = 0; i < rec.lon.length; i++) {
    const ti = rec.t[i];
    points[i] = Number.isNaN(ti) ? [rec.lon[i], rec.lat[i]] : [rec.lon[i], rec.lat[i], ti];
  }
  const track: Track = { id: rec.id, source: rec.source, points };
  if (rec.name !== undefined) track.name = rec.name;
  return track;
}

export function recordToSummary(rec: TrackRecord): TrackSummary {
  const s: TrackSummary = { id: rec.id, source: rec.source, points: rec.lon.length, lengthM: rec.lengthM };
  if (rec.name !== undefined) s.name = rec.name;
  if (rec.startMs !== undefined) { s.startMs = rec.startMs; s.endMs = rec.endMs; }
  return s;
}

export class CellStore implements CellTileProvider {
  private db: GridDb | undefined;
  private stats: GridStats = defaultStats();
  private readonly dbName: string;
  private readonly cacheTiles: number;
  private readonly flushEvery: number;
  /** LRU: Map insertion order = age (oldest first); touching re-inserts. */
  private readonly cache = new Map<string, Entry>();
  private readonly dirty = new Set<string>();
  private readonly loading = new Map<string, Promise<Entry>>();
  private pendingTracks: TrackRecord[] = [];
  private pendingImports: ImportRecord[] = [];
  /** Last provenance row per source|fileName (chunked archives fold into it). */
  private readonly lastImport = new Map<string, ImportRecord>();
  private statsDirty = false;
  /** Bumped by deleteAll so in-flight tile loads from before the wipe are not cached. */
  private epoch = 0;
  /** Per-row cell areas (m²) by base tile row ty — Σ area over visited cells needs one per row. */
  private readonly rowAreas = new Map<number, Float64Array>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: CellStoreOptions = {}) {
    this.dbName = opts.dbName ?? 'unfog';
    this.cacheTiles = Math.max(16, opts.cacheTiles ?? 256);
    this.flushEvery = Math.max(1, opts.flushEvery ?? 128);
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<GridStats> {
    if (!this.db) {
      const db = await openGridDb(this.dbName);
      this.db = db;
      const saved = (await db.get('meta', 'stats')) as GridStats | undefined;
      this.stats = saved ? { ...defaultStats(), ...saved } : defaultStats();
    }
    return { ...this.stats };
  }

  /** Flush pending writes and close the connection (tests reopen; the worker never closes). */
  async close(): Promise<void> {
    await this.serialized(async () => {
      if (!this.db) return;
      await this.flush();
      this.db.close();
      this.db = undefined;
      this.cache.clear();
      this.loading.clear();
    });
  }

  async getStats(): Promise<GridStats> {
    await this.init();
    return { ...this.stats };
  }

  // ---------------------------------------------------------------- reads

  /**
   * CellTileProvider. Returns the cached array itself (no copy) — callers must treat it as
   * read-only. `null` = no data at that tile.
   */
  async getTile(level: Level, tx: number, ty: number): Promise<CellCounts | null> {
    await this.init();
    const e = await this.load(level, tx, ty);
    return e.counts;
  }

  async listBaseTiles(): Promise<Array<[number, number]>> {
    const db = await this.ready();
    const keys = await db.getAllKeys('tiles', levelKeyRange(14));
    const out: Array<[number, number]> = [];
    for (const id of keys) {
      const [, tx, ty] = id.split('/');
      out.push([Number(tx), Number(ty)]);
    }
    return out;
  }

  async listTracks(): Promise<TrackSummary[]> {
    const db = await this.ready();
    const recs = await db.getAll('tracks');
    return recs.map(recordToSummary);
  }

  async getTrack(id: string): Promise<Track | null> {
    const db = await this.ready();
    const rec = await db.get('tracks', id);
    return rec ? recordToTrack(rec) : null;
  }

  // ---------------------------------------------------------------- mutations

  applyPayload(payload: ImportPayload): Promise<ApplyResult> {
    return this.serialized(async () => {
      await this.init();
      const touched = new Map<number, { tx: number; ty: number }>();
      for (const ct of payload.cellTiles ?? []) {
        if (ct.counts.length !== TILE_CELLS) throw new Error(`cell tile ${ct.tx}/${ct.ty}: expected ${TILE_CELLS} counts, got ${ct.counts.length}`);
        await this.mergeBase(ct.tx, ct.ty, ct.counts, touched);
      }
      for (const track of payload.tracks ?? []) await this.markTrackInternal(track, touched);
      this.logImport(payload.meta);
      this.bumpVersion();
      await this.flush();
      return { stats: { ...this.stats }, touched: [...touched.values()] };
    });
  }

  markTrack(track: Track): Promise<ApplyResult> {
    return this.serialized(async () => {
      await this.init();
      const touched = new Map<number, { tx: number; ty: number }>();
      const marked = await this.markTrackInternal(track, touched);
      if (marked) this.bumpVersion(); // map tiles refresh only when cells changed
      await this.flush(); // the track record is (re)written either way
      return { stats: { ...this.stats }, touched: [...touched.values()] };
    });
  }

  deleteTrack(id: string): Promise<GridStats> {
    return this.serialized(async () => {
      const db = await this.ready();
      await db.delete('tracks', id);
      // Counts are intentionally untouched — see the header comment.
      return { ...this.stats };
    });
  }

  deleteAll(): Promise<GridStats> {
    return this.serialized(async () => {
      const db = await this.ready();
      this.epoch++;
      this.cache.clear();
      this.dirty.clear();
      this.pendingTracks = [];
      this.pendingImports = [];
      this.lastImport.clear();
      const tx = db.transaction(['tiles', 'tracks', 'imports', 'meta'], 'readwrite');
      tx.objectStore('tiles').clear();
      tx.objectStore('tracks').clear();
      tx.objectStore('imports').clear();
      // version keeps counting so every cache keyed by it invalidates.
      this.stats = { ...defaultStats(), version: this.stats.version + 1, updatedAt: Date.now() };
      tx.objectStore('meta').put(this.stats, 'stats');
      await tx.done;
      this.statsDirty = false;
      return { ...this.stats };
    });
  }

  // ---------------------------------------------------------------- backup

  /** Consistent snapshot: runs inside the mutation chain so nothing changes underneath it. */
  exportBackup(): Promise<Uint8Array> {
    return this.serialized(async () => {
      const db = await this.ready();
      await this.flush();
      const tracks = await db.getAll('tracks');
      return encodeBackup({ stats: { ...this.stats }, tiles: this.iterateBaseTiles(), tracks });
    });
  }

  importBackup(bytes: Uint8Array): Promise<ApplyResult> {
    return this.serialized(async () => {
      const db = await this.ready();
      const backup = decodeBackup(bytes);
      const touched = new Map<number, { tx: number; ty: number }>();
      let tiles = 0;
      for (const t of backup.tiles) {
        await this.mergeBase(t.tx, t.ty, t.counts, touched);
        tiles++;
      }
      // Tracks are records only: the backup's counts already include them, so they are NOT
      // re-rasterised. Existing ids win (idempotent re-import).
      let newTracks = 0;
      for (const rec of backup.tracks) {
        if (await db.get('tracks', rec.id)) continue;
        this.pendingTracks.push(rec);
        newTracks++;
      }
      this.logImport({ source: 'backup', items: tiles, note: `${tiles} tiles, ${newTracks} new tracks, exported ${new Date(backup.meta.exportedAt).toISOString()}` });
      this.bumpVersion();
      await this.flush();
      return { stats: { ...this.stats }, touched: [...touched.values()] };
    });
  }

  /** Base tiles straight from IndexedDB in key batches (bounded memory; no long-lived cursor). */
  private async *iterateBaseTiles(): AsyncGenerator<BackupTile> {
    const db = await this.ready();
    const keys = await db.getAllKeys('tiles', levelKeyRange(14));
    const BATCH = 64;
    for (let i = 0; i < keys.length; i += BATCH) {
      const last = keys[Math.min(i + BATCH, keys.length) - 1];
      const recs = await db.getAll('tiles', IDBKeyRange.bound(keys[i], last));
      for (const rec of recs) {
        if (rec.level !== 14 || rec.n === 0) continue;
        yield { tx: rec.tx, ty: rec.ty, counts: inflateSync(rec.data) };
      }
    }
  }

  // ---------------------------------------------------------------- maintenance

  /**
   * Recompute visitedCells / areaM2 / tiles from the base tiles on disk (integrity repair; the
   * incremental path is the normal one). Bumps the version.
   */
  rebuildStats(): Promise<GridStats> {
    return this.serialized(async () => {
      await this.flush();
      let visited = 0, area = 0, tiles = 0;
      for await (const t of this.iterateBaseTiles()) {
        const areas = this.areasForRow(t.ty);
        let n = 0;
        for (let i = 0; i < TILE_CELLS; i++) if (t.counts[i] !== 0) { n++; area += areas[i >> 8]; }
        if (n) { tiles++; visited += n; }
      }
      this.stats = { ...this.stats, visitedCells: visited, areaM2: area, tiles };
      this.bumpVersion();
      await this.flush();
      return { ...this.stats };
    });
  }

  /**
   * Write dirty tiles, pending tracks/imports and the stats in one transaction. Called by every
   * mutation; public so tests and the worker can force persistence.
   */
  async flush(): Promise<void> {
    const db = await this.ready();
    if (!this.dirty.size && !this.pendingTracks.length && !this.pendingImports.length && !this.statsDirty) return;
    const now = Date.now();
    // Compress outside the transaction: IDB auto-commits if we yield, and deflate is sync anyway.
    const puts: TileRecord[] = [];
    const dels: string[] = [];
    for (const id of this.dirty) {
      const e = this.cache.get(id);
      if (!e) continue;
      if (!e.counts) { dels.push(id); e.dirty = false; continue; }
      const n = countNonZero(e.counts);
      if (n === 0) { dels.push(id); e.counts = null; }
      else puts.push({ id, level: e.level, tx: e.tx, ty: e.ty, data: deflateSync(e.counts, { level: DEFLATE_LEVEL }), n, updated: now });
      e.dirty = false;
    }
    const tracks = this.pendingTracks, imports = this.pendingImports;
    this.pendingTracks = [];
    this.pendingImports = [];
    this.dirty.clear();
    try {
      const tx = db.transaction(['tiles', 'tracks', 'imports', 'meta'], 'readwrite');
      const reqs: Promise<unknown>[] = [];
      const tilesStore = tx.objectStore('tiles');
      for (const rec of puts) reqs.push(tilesStore.put(rec));
      for (const id of dels) reqs.push(tilesStore.delete(id));
      const trackStore = tx.objectStore('tracks');
      for (const rec of tracks) reqs.push(trackStore.put(rec));
      const importStore = tx.objectStore('imports');
      for (const rec of imports) reqs.push(importStore.put(rec));
      reqs.push(tx.objectStore('meta').put(this.stats, 'stats'));
      // every request promise is awaited so an aborted transaction never leaves unhandled rejections
      await Promise.all([...reqs, tx.done]);
    } catch (e) {
      // The transaction did not commit (quota, abort, closed database): memory is now ahead of
      // disk. Put everything back on the dirty lists so the next flush retries it, then rethrow.
      for (const rec of puts) this.redirty(rec.id);
      for (const id of dels) this.redirty(id);
      this.pendingTracks = tracks.concat(this.pendingTracks);
      this.pendingImports = imports.concat(this.pendingImports);
      this.statsDirty = true;
      throw e;
    }
    this.statsDirty = false;
    this.evict();
  }

  // ---------------------------------------------------------------- internals

  private async ready(): Promise<GridDb> {
    await this.init();
    return this.db as GridDb;
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private bumpVersion(): void {
    this.stats.version++;
    this.stats.updatedAt = Date.now();
    this.statsDirty = true;
  }

  /**
   * One provenance row per applyPayload — except for the chunks of one big archive (the FoW
   * importer streams a 10 000-base-tile Sync folder as payloads whose `meta.note` starts with
   * "part "): those fold into the row of the previous chunk of the same source + fileName, so
   * the Data screen shows one import, with `items` summed and the last chunk's note.
   */
  private logImport(meta: ImportPayload['meta']): void {
    const now = Date.now();
    const key = `${meta.source}|${meta.fileName ?? ''}`;
    const prev = this.lastImport.get(key);
    if (prev && meta.note?.startsWith('part ') && now - prev.at < 10 * 60_000) {
      const rec: ImportRecord = { ...prev, items: prev.items + meta.items, note: meta.note };
      this.lastImport.set(key, rec);
      const i = this.pendingImports.findIndex((r) => r.id === rec.id);
      if (i >= 0) this.pendingImports[i] = rec; else this.pendingImports.push(rec); // put replaces by id
      return;
    }
    const rec: ImportRecord = {
      id: `imp-${now.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`,
      at: now,
      source: meta.source,
      items: meta.items,
    };
    if (meta.fileName !== undefined) rec.fileName = meta.fileName;
    if (meta.note !== undefined) rec.note = meta.note;
    this.pendingImports.push(rec);
    if (this.lastImport.size > 64) this.lastImport.clear();
    this.lastImport.set(key, rec);
  }

  private areasForRow(ty: number): Float64Array {
    let a = this.rowAreas.get(ty);
    if (!a) {
      if (this.rowAreas.size > 512) this.rowAreas.clear();
      a = new Float64Array(TILE_SIZE);
      for (let iy = 0; iy < TILE_SIZE; iy++) a[iy] = cellAreaM2(ty * TILE_SIZE + iy);
      this.rowAreas.set(ty, a);
    }
    return a;
  }

  private touch(id: string, e: Entry): void {
    this.cache.delete(id);
    this.cache.set(id, e);
  }

  /** Cached entry for a tile, loading (and negative-caching) from IndexedDB on a miss. */
  private load(level: Level, tx: number, ty: number): Promise<Entry> {
    const id = tileId(level, tx, ty);
    const hit = this.cache.get(id);
    if (hit) { this.touch(id, hit); return Promise.resolve(hit); }
    const inflight = this.loading.get(id);
    if (inflight) return inflight;
    const epoch = this.epoch;
    const p = (async () => {
      const db = this.db as GridDb;
      const rec = await db.get('tiles', id);
      // A mutation may have created the entry while we awaited — never clobber it.
      const raced = this.cache.get(id);
      if (raced) return raced;
      // deleteAll ran meanwhile: what we read is stale — hand it back but do not cache it.
      const stale = epoch !== this.epoch;
      const e: Entry = { level, tx, ty, counts: rec && rec.n > 0 && !stale ? inflateSync(rec.data) : null, dirty: false };
      if (!stale) { this.cache.set(id, e); this.evict(); }
      return e;
    })();
    this.loading.set(id, p);
    p.finally(() => this.loading.delete(id)).catch(() => undefined);
    return p;
  }

  /** Like load, but guarantees `counts` is allocated (a zero tile if the tile was empty). */
  private async ensure(level: Level, tx: number, ty: number): Promise<Entry & { counts: Uint8Array }> {
    const e = await this.load(level, tx, ty);
    if (!e.counts) e.counts = new Uint8Array(TILE_CELLS);
    return e as Entry & { counts: Uint8Array };
  }

  private markDirty(e: Entry): void {
    if (!e.dirty) {
      e.dirty = true;
      this.dirty.add(tileId(e.level, e.tx, e.ty));
    }
  }

  /** Re-mark a cached tile dirty after a failed flush (entries are pinned while dirty, so it is still cached). */
  private redirty(id: string): void {
    const e = this.cache.get(id);
    if (e) { e.dirty = true; this.dirty.add(id); }
  }

  /** Evict clean entries beyond the cache size (oldest first; dirty entries are pinned). */
  private evict(): void {
    if (this.cache.size <= this.cacheTiles) return;
    for (const [id, e] of this.cache) {
      if (e.dirty) continue;
      this.cache.delete(id);
      if (this.cache.size <= this.cacheTiles) break;
    }
  }

  private async maybeFlush(): Promise<void> {
    if (this.dirty.size >= this.flushEvery) await this.flush();
  }

  /** Merge `src` into base tile (tx, ty) with max; updates stats, overviews, touched. */
  private async mergeBase(tx: number, ty: number, src: Uint8Array, touched: Map<number, { tx: number; ty: number }>): Promise<boolean> {
    const e = await this.ensure(14, tx, ty);
    const dst = e.counts;
    const areas = this.areasForRow(ty);
    let changed = false, newly = 0, area = 0;
    for (let i = 0; i < TILE_CELLS; i++) {
      const v = src[i];
      const c = dst[i];
      if (v > c) {
        if (c === 0) { newly++; area += areas[i >> 8]; }
        dst[i] = v;
        changed = true;
      }
    }
    if (changed) await this.commitBaseChange(e, newly, area, touched);
    return changed;
  }

  /**
   * Rasterise + mark a track. If the id already exists (in the database or pending in this
   * operation) only the cells the stored polyline did not touch are counted — see the header.
   * Returns true when any cell changed.
   */
  private async markTrackInternal(track: Track, touched: Map<number, { tx: number; ty: number }>): Promise<boolean> {
    const db = this.db as GridDb;
    const pendingIdx = this.pendingTracks.findIndex((r) => r.id === track.id);
    const previous = pendingIdx >= 0 ? this.pendingTracks[pendingIdx] : await db.get('tracks', track.id);
    let raster = rasterizeTrack(track.points);
    if (previous) {
      // What the earlier version already counted; re-rasterising is deterministic and cheap.
      raster = subtractRaster(raster, rasterizeTrack(recordToTrack(previous).points));
    }
    let changed = false;
    for (const [key, idx] of raster) {
      const { tx, ty } = parseTileKey(key);
      const e = await this.ensure(14, tx, ty);
      const dst = e.counts;
      const areas = this.areasForRow(ty);
      let newly = 0, area = 0, tileChanged = false;
      for (let j = 0; j < idx.length; j++) {
        const i = idx[j];
        const c = dst[i];
        if (c === 0) { newly++; area += areas[i >> 8]; }
        if (c < 255) { dst[i] = c + 1; tileChanged = true; }
      }
      if (tileChanged) { changed = true; await this.commitBaseChange(e, newly, area, touched); }
    }
    const rec = trackToRecord(track);
    if (pendingIdx >= 0) this.pendingTracks[pendingIdx] = rec; else this.pendingTracks.push(rec);
    return changed;
  }

  /** Bookkeeping after a base tile changed: stats, dirty, overview pyramid, auto-flush. */
  private async commitBaseChange(e: Entry & { counts: Uint8Array }, newly: number, area: number, touched: Map<number, { tx: number; ty: number }>): Promise<void> {
    if (newly > 0 && !(await this.baseTileHadData(e))) this.stats.tiles++;
    this.stats.visitedCells += newly;
    this.stats.areaM2 += area;
    this.statsDirty = true;
    this.markDirty(e);
    touched.set(tileKey(14, e.tx, e.ty), { tx: e.tx, ty: e.ty });
    await this.updateOverviews(e.tx, e.ty, e.counts);
    await this.maybeFlush();
  }

  /**
   * Whether the base tile had any data before the change now in memory. The level-6 overview cell
   * is exactly max(base tile) as of the last updateOverviews, i.e. BEFORE this change (for the
   * "tiles" stat only).
   */
  private async baseTileHadData(e: Entry & { counts: Uint8Array }): Promise<boolean> {
    const l6 = await this.load(6, e.tx >> 8, e.ty >> 8);
    if (!l6.counts) return false;
    return l6.counts[(e.ty & 255) * TILE_SIZE + (e.tx & 255)] !== 0;
  }

  /**
   * Write-through overview maintenance for a changed base tile. Exact recompute from children:
   *   level 10: the 16×16 block of level-10 cells covering the base tile (each = max of 16×16 base cells)
   *   level 6 : the one cell = max of the base tile (= max of that level-10 block)
   *   level 2 : the one cell = max of the 16×16 level-6 cells it covers (16×16 base tiles)
   */
  private async updateOverviews(tx: number, ty: number, base: Uint8Array): Promise<void> {
    // ---- level 10
    const l10 = await this.ensure(10, tx >> 4, ty >> 4);
    const bx0 = (tx & 15) << 4, by0 = (ty & 15) << 4;
    let tileMax = 0;
    for (let by = 0; by < 16; by++) {
      for (let bx = 0; bx < 16; bx++) {
        let m = 0;
        const y0 = by << 4, x0 = bx << 4;
        for (let y = y0; y < y0 + 16; y++) {
          const row = y * TILE_SIZE;
          for (let x = x0; x < x0 + 16; x++) { const v = base[row + x]; if (v > m) m = v; }
        }
        if (m > tileMax) tileMax = m;
        const oi = (by0 + by) * TILE_SIZE + (bx0 + bx);
        if (l10.counts[oi] !== m) { l10.counts[oi] = m; this.markDirty(l10); }
      }
    }
    // ---- level 6
    const l6 = await this.ensure(6, tx >> 8, ty >> 8);
    const i6 = (ty & 255) * TILE_SIZE + (tx & 255);
    if (l6.counts[i6] !== tileMax) { l6.counts[i6] = tileMax; this.markDirty(l6); }
    // ---- level 2: max over the 16×16 level-6 block that holds this base tile's cell
    const l2 = await this.ensure(2, tx >> 12, ty >> 12);
    const sx0 = (tx & 255) & ~15, sy0 = (ty & 255) & ~15;
    let m2 = 0;
    for (let y = sy0; y < sy0 + 16; y++) {
      const row = y * TILE_SIZE;
      for (let x = sx0; x < sx0 + 16; x++) { const v = l6.counts[row + x]; if (v > m2) m2 = v; }
    }
    const i2 = ((ty >> 4) & 255) * TILE_SIZE + ((tx >> 4) & 255);
    if (l2.counts[i2] !== m2) { l2.counts[i2] = m2; this.markDirty(l2); }
  }
}
