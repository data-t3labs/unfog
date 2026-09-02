/**
 * IndexedDB schema for the visited-cell grid — database `unfog`, version 1.
 *
 * THIS SCHEMA IS SHARED. The grid worker (src/grid/store.ts) is the only writer; the routing
 * worker opens the same database READ-ONLY to score novelty (it reads `tiles` by id and
 * `meta/'stats'` for the version). Any change here is a change for both — bump the version and
 * write an upgrade path.
 *
 * Stores
 * ------
 * `tiles`   keyPath `id` = "level/tx/ty" (see cell.ts `tileId`).
 *           { id, level, tx, ty, data, n, updated }
 *           `data`  = fflate `deflateSync` (raw DEFLATE, no zlib header) of the 65 536-byte
 *                     Uint8Array of visit counts, row-major (iy·256 + ix), 0 = never, 255 = cap.
 *                     Decode with fflate `inflateSync(data)`.
 *           `n`     = number of cells with count > 0 (0 ⇒ the record may be absent instead).
 *           `updated` = Date.now() of the last write.
 *           Levels: 14 = base (z22 cells); 10/6/2 = max-pooled overviews (types.ts LEVELS).
 *           Base tiles of one level sort together: ids "14/…" form the key range
 *           ["14/", "14/￿"] — no index needed.
 * `meta`    out-of-line string keys: 'stats' → GridStats (types.ts), 'settings' → app settings
 *           (opaque to the store).
 * `tracks`  keyPath `id`. Imported / recorded tracks kept for stats, GPX export and the Data
 *           screen. Coordinates as parallel Float64Arrays; `t` in ms since epoch, NaN when the
 *           source had no timestamp.
 * `imports` keyPath `id`. Provenance log, one row per applyPayload / importBackup.
 *
 * In Node tests `import 'fake-indexeddb/auto'` (before this module is used) provides the
 * globals; pass a unique `name` per test to isolate databases.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { GridStats } from './types';

export const DB_NAME = 'unfog';
export const DB_VERSION = 1;

export interface TileRecord {
  /** "level/tx/ty" */
  id: string;
  level: number;
  tx: number;
  ty: number;
  /** Raw-DEFLATE of the 65 536 Uint8 counts. */
  data: Uint8Array;
  /** Cells with count > 0. */
  n: number;
  /** Date.now() of the last write. */
  updated: number;
}

export interface TrackRecord {
  id: string;
  /** 'gpx' | 'timeline' | 'session' | 'fow' | … */
  source: string;
  name?: string;
  lon: Float64Array;
  lat: Float64Array;
  /** ms since epoch per point, NaN when unknown. */
  t: Float64Array;
  startMs?: number;
  endMs?: number;
  /** Polyline length in metres (segments longer than the gap threshold are not counted). */
  lengthM: number;
}

export interface ImportRecord {
  id: string;
  /** Date.now() */
  at: number;
  source: string;
  fileName?: string;
  items: number;
  note?: string;
}

export interface UnfogDB extends DBSchema {
  tiles: { key: string; value: TileRecord };
  meta: { key: string; value: GridStats | unknown };
  tracks: { key: string; value: TrackRecord };
  imports: { key: string; value: ImportRecord };
}

export type GridDb = IDBPDatabase<UnfogDB>;

/** Key range selecting every tile of one level (ids are "level/tx/ty"). */
export function levelKeyRange(level: number): IDBKeyRange {
  return IDBKeyRange.bound(`${level}/`, `${level}/￿`);
}

/**
 * Open (creating/upgrading as needed) the grid database. `name` defaults to `unfog`; tests pass
 * a unique name. `indexedDB` is taken from the global scope, so `fake-indexeddb/auto` works.
 */
export function openGridDb(name: string = DB_NAME): Promise<GridDb> {
  return openDB<UnfogDB>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('tiles', { keyPath: 'id' });
        db.createObjectStore('meta');
        db.createObjectStore('tracks', { keyPath: 'id' });
        db.createObjectStore('imports', { keyPath: 'id' });
      }
    },
    blocking(_cur, _blocked, ev) {
      // Another connection wants to upgrade: close so it can proceed.
      (ev.target as IDBDatabase | null)?.close?.();
    },
  });
}
