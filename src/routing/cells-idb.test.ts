import 'fake-indexeddb/auto';
import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { TILE_SIZE, cellIndex, cellToTile, lonLatToCell, tileId } from '../grid/cell';
import { IdbCellLookup, baseTilesFor, openExistingDb } from './cells-idb';

const HOME: [number, number] = [-73.9568, 40.7176];
const BBOX: [number, number, number, number] = [HOME[0] - 0.01, HOME[1] - 0.01, HOME[0] + 0.01, HOME[1] + 0.01];

function createStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('unfog', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('tiles', { keyPath: 'id' }); };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function putTile(tx: number, ty: number, counts: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('unfog');
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction('tiles', 'readwrite');
      t.objectStore('tiles').put({ id: tileId(14, tx, ty), level: 14, tx, ty, data: deflateSync(counts), n: 1, updated: Date.now() });
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe('IdbCellLookup', () => {
  it('treats a missing database as unvisited and never creates it', async () => {
    const lookup = new IdbCellLookup();
    expect(await lookup.prepare(BBOX)).toBe(0);
    const [cx, cy] = lonLatToCell(HOME[0], HOME[1]);
    expect(lookup.get(cx, cy)).toBe(0);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('unfog');
    expect(await openExistingDb('unfog')).toBeNull();
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('unfog');
  });

  it('reads deflated base tiles read-only, caches them, and drops them on invalidate', async () => {
    await createStore();
    const [cx, cy] = lonLatToCell(HOME[0], HOME[1]);
    const { tx, ty, ix, iy } = cellToTile(cx, cy);
    const counts = new Uint8Array(TILE_SIZE * TILE_SIZE);
    counts[cellIndex(ix, iy)] = 3;
    await putTile(tx, ty, counts);
    const lookup = new IdbCellLookup();
    const r = baseTilesFor(BBOX);
    expect(tx).toBeGreaterThanOrEqual(r.x0); expect(tx).toBeLessThanOrEqual(r.x1);
    expect(await lookup.prepare(BBOX)).toBe(1);
    expect(lookup.get(cx, cy)).toBe(3);
    expect(lookup.get(cx + 1, cy)).toBe(0);
    expect(lookup.tileCount).toBe((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1));
    // Cached: a second prepare loads nothing.
    expect(await lookup.prepare(BBOX)).toBe(0);
    lookup.invalidate();
    expect(lookup.get(cx, cy)).toBe(0);
    expect(await lookup.prepare(BBOX)).toBe(1);
    expect(lookup.get(cx, cy)).toBe(3);
    // An upgrade by the grid worker is not blocked by our open connection.
    const upgraded = await new Promise<number>((resolve, reject) => {
      const req = indexedDB.open('unfog', 2);
      const timer = setTimeout(() => reject(new Error('upgrade blocked')), 2000);
      req.onupgradeneeded = () => { req.result.createObjectStore('meta'); };
      req.onsuccess = () => { clearTimeout(timer); const v = req.result.version; req.result.close(); resolve(v); };
      req.onerror = () => { clearTimeout(timer); reject(req.error); };
    });
    expect(upgraded).toBe(2);
    lookup.invalidate();
    expect(await lookup.prepare(BBOX)).toBe(1); // reopens after the version change
    lookup.close();
  });
});
