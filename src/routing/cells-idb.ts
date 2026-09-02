/**
 * CellLookup over the grid worker's IndexedDB (`unfog`, store `tiles`, key "14/<tx>/<ty>",
 * value { data: fflate-deflated Uint8Array(65536), ... }). Opened READ-ONLY: the database is
 * never created or upgraded from here, and the connection closes itself on `versionchange` so
 * the grid worker's upgrades are never blocked. Tiles are decoded once and kept in an LRU
 * (default 512 ≈ 32 MB); `invalidate()` drops everything (called on invalidateCells).
 *
 * `prepare(bbox)` must be awaited before a search that may touch the area: `get` is synchronous
 * and answers 0 for tiles that were not preloaded.
 */
import { inflateSync } from 'fflate';
import { TILE_SHIFT, TILE_SIZE, lonLatToCell, tileId } from '../grid/cell';
import type { BBox } from './api';
import { TileCellLookup } from './cells';

const DB_NAME = 'unfog';
const STORE = 'tiles';

interface TileRecord {
  id: string;
  level: number;
  tx: number;
  ty: number;
  data: Uint8Array;
  n?: number;
  updated?: number;
}

/** Open an existing database without creating it. Resolves null when it does not exist. */
export async function openExistingDb(name: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  if (typeof indexedDB.databases === 'function') {
    try {
      const list = await indexedDB.databases();
      if (!list.some((d) => d.name === name)) return null;
    } catch {
      /* fall through to the abort guard */
    }
  }
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      // Only fires when the database did not exist (oldVersion 0): abort so nothing is created.
      try { req.transaction?.abort(); } catch { /* ignore */ }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** z14 tile range covering a lon/lat bbox, padded by `margin` tiles. */
export function baseTilesFor(bbox: BBox, margin = 1): { x0: number; y0: number; x1: number; y1: number } {
  const [ax, ay] = lonLatToCell(bbox[0], bbox[3]);
  const [bx, by] = lonLatToCell(bbox[2], bbox[1]);
  const max = (1 << 14) - 1;
  return {
    x0: Math.max(0, (Math.min(ax, bx) >> TILE_SHIFT) - margin),
    y0: Math.max(0, (Math.min(ay, by) >> TILE_SHIFT) - margin),
    x1: Math.min(max, (Math.max(ax, bx) >> TILE_SHIFT) + margin),
    y1: Math.min(max, (Math.max(ay, by) >> TILE_SHIFT) + margin),
  };
}

export class IdbCellLookup extends TileCellLookup {
  private db: IDBDatabase | null | undefined;
  private opening: Promise<IDBDatabase | null> | null = null;
  /** Bumped by invalidate(); prepare() calls started before a bump discard their results. */
  private generation = 0;

  constructor(maxTiles = 512, private readonly dbName = DB_NAME) {
    super(maxTiles);
  }

  private async open(): Promise<IDBDatabase | null> {
    if (this.db !== undefined) return this.db;
    if (!this.opening) {
      this.opening = openExistingDb(this.dbName).then((db) => {
        if (db) {
          db.onversionchange = () => { db.close(); this.db = undefined; this.opening = null; };
          db.onclose = () => { this.db = undefined; this.opening = null; };
          if (!db.objectStoreNames.contains(STORE)) { db.close(); return null; }
        }
        this.db = db;
        return db;
      });
    }
    return this.opening;
  }

  /** Load every base tile intersecting `bbox` (+margin) that is not cached yet. Returns tiles loaded. */
  async prepare(bbox: BBox, margin = 1): Promise<number> {
    const r = baseTilesFor(bbox, margin);
    const wanted: Array<[number, number]> = [];
    for (let ty = r.y0; ty <= r.y1; ty++) for (let tx = r.x0; tx <= r.x1; tx++) if (!this.has(tx, ty)) wanted.push([tx, ty]);
    if (wanted.length === 0) return 0;
    const gen = this.generation;
    const db = await this.open();
    if (!db) {
      // No store yet: everything is unvisited. Remember that so we do not retry per request
      // (invalidate() clears it and the next prepare reopens).
      for (const [tx, ty] of wanted) this.setTile(tx, ty, null);
      this.db = undefined; this.opening = null;
      return 0;
    }
    const records = await new Promise<Array<TileRecord | undefined>>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(STORE, 'readonly'); } catch (e) { reject(e); return; }
      const store = tx.objectStore(STORE);
      const out: Array<TileRecord | undefined> = new Array(wanted.length);
      wanted.forEach(([x, y], i) => {
        const req = store.get(tileId(14, x, y));
        req.onsuccess = () => { out[i] = req.result as TileRecord | undefined; };
      });
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }).catch(() => new Array<TileRecord | undefined>(wanted.length));
    if (gen !== this.generation) return 0;
    let loaded = 0;
    for (let i = 0; i < wanted.length; i++) {
      const [tx, ty] = wanted[i];
      const rec = records[i];
      let counts: Uint8Array | null = null;
      if (rec && rec.data && rec.data.length) {
        try {
          const raw = inflateSync(rec.data);
          if (raw.length === TILE_SIZE * TILE_SIZE) { counts = raw; loaded++; }
        } catch { counts = null; }
      }
      this.setTile(tx, ty, counts);
    }
    return loaded;
  }

  /** Drop every cached tile (the cell store changed). */
  invalidate(): void {
    this.generation++;
    this.clear();
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.opening = null;
  }
}
