import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { cellAreaM2, cellToTile, lonLatToCell, TILE_SIZE } from './cell';
import { CellStore, TILE_CELLS } from './store';
import type { Track } from './types';

let n = 0;
const open: CellStore[] = [];
function store(name = `unfog-test-${Date.now()}-${n++}`, opts: { cacheTiles?: number; flushEvery?: number } = {}): CellStore {
  const s = new CellStore({ dbName: name, ...opts });
  open.push(s);
  return s;
}
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });

const A: [number, number] = [-73.9568, 40.7176];
const B: [number, number] = [-73.954, 40.7176]; // ~236 m east
const [ACX, ACY] = lonLatToCell(A[0], A[1]);
const { tx: ATX, ty: ATY } = cellToTile(ACX, ACY);

function track(id: string, points: Array<[number, number, number?]>, source = 'gpx'): Track {
  return { id, source, points };
}

function mask(cells: Array<[ix: number, iy: number, v?: number]>): Uint8Array {
  const counts = new Uint8Array(TILE_CELLS);
  for (const [ix, iy, v] of cells) counts[iy * TILE_SIZE + ix] = v ?? 1;
  return counts;
}

async function tileOrEmpty(s: CellStore, level: 14 | 10 | 6 | 2, tx: number, ty: number): Promise<Uint8Array> {
  return (await s.getTile(level, tx, ty)) ?? new Uint8Array(TILE_CELLS);
}

describe('CellStore', () => {
  it('starts empty and init is idempotent', async () => {
    const s = store();
    const a = await s.init();
    const b = await s.init();
    expect(a).toEqual({ visitedCells: 0, areaM2: 0, tiles: 0, version: 0, updatedAt: 0 });
    expect(b).toEqual(a);
    expect(await s.getTile(14, ATX, ATY)).toBeNull();
    expect(await s.listBaseTiles()).toEqual([]);
  });

  it('FoW-style max merge is idempotent and never lowers a count', async () => {
    const s = store();
    const payload = { cellTiles: [{ tx: ATX, ty: ATY, counts: mask([[10, 10], [11, 10], [200, 3]]) }], meta: { source: 'fow', items: 1 } };
    const r1 = await s.applyPayload(payload);
    expect(r1.stats.visitedCells).toBe(3);
    expect(r1.stats.tiles).toBe(1);
    expect(r1.touched).toEqual([{ tx: ATX, ty: ATY }]);
    const r2 = await s.applyPayload(payload);
    expect(r2.stats.visitedCells).toBe(3);
    expect(r2.stats.areaM2).toBe(r1.stats.areaM2);
    expect(r2.touched).toEqual([]); // nothing changed
    // a lower value does not overwrite a higher one
    await s.applyPayload({ cellTiles: [{ tx: ATX, ty: ATY, counts: mask([[10, 10, 5]]) }], meta: { source: 'fow', items: 1 } });
    await s.applyPayload({ cellTiles: [{ tx: ATX, ty: ATY, counts: mask([[10, 10, 2]]) }], meta: { source: 'fow', items: 1 } });
    const t = await tileOrEmpty(s, 14, ATX, ATY);
    expect(t[10 * TILE_SIZE + 10]).toBe(5);
    expect(t[10 * TILE_SIZE + 11]).toBe(1);
    expect(await s.listBaseTiles()).toEqual([[ATX, ATY]]);
  });

  it('a track marks each touched cell once, even when it crosses the same cell twice', async () => {
    const s = store();
    const r = await s.markTrack(track('t1', [A, B, A]));
    const t = await tileOrEmpty(s, 14, ATX, ATY);
    let max = 0, nonzero = 0;
    for (let i = 0; i < TILE_CELLS; i++) { if (t[i] > max) max = t[i]; if (t[i]) nonzero++; }
    expect(max).toBe(1);
    expect(nonzero).toBeGreaterThanOrEqual(30);
    expect(r.stats.visitedCells).toBe(nonzero);
    expect(r.touched).toEqual([{ tx: ATX, ty: ATY }]);
  });

  it('two tracks over the same street count 2; re-marking the same track id is a no-op', async () => {
    const s = store();
    await s.markTrack(track('t1', [A, B]));
    const v1 = (await s.getStats()).version;
    const again = await s.markTrack(track('t1', [B, A]));
    expect(again.stats.version).toBe(v1);
    expect(again.touched).toEqual([]);
    await s.markTrack(track('t2', [A, B]));
    const t = await tileOrEmpty(s, 14, ATX, ATY);
    expect(t[ACY % TILE_SIZE * TILE_SIZE + (ACX % TILE_SIZE)]).toBe(2);
    expect((await s.listTracks()).map((x) => x.id).sort()).toEqual(['t1', 't2']);
  });

  it('saturates at 255', async () => {
    const s = store();
    await s.applyPayload({ cellTiles: [{ tx: ATX, ty: ATY, counts: mask([[ACX & 255, ACY & 255, 254]]) }], meta: { source: 'fow', items: 1 } });
    await s.markTrack(track('t1', [A, B]));
    await s.markTrack(track('t2', [A, B]));
    const t = await tileOrEmpty(s, 14, ATX, ATY);
    expect(t[(ACY & 255) * TILE_SIZE + (ACX & 255)]).toBe(255);
    expect((await s.getStats()).visitedCells).toBeGreaterThan(1);
  });

  it('overview levels hold the max of their children', async () => {
    const s = store();
    await s.applyPayload({ cellTiles: [{ tx: ATX, ty: ATY, counts: mask([[5, 5, 3], [6, 5, 9], [250, 250, 4]]) }], meta: { source: 'fow', items: 1 } });
    await s.markTrack(track('t1', [A, B]));
    const base = await tileOrEmpty(s, 14, ATX, ATY);
    // level 10: 16×16 block at ((tx&15)·16, (ty&15)·16), each cell = max of 16×16 base cells
    const l10 = await tileOrEmpty(s, 10, ATX >> 4, ATY >> 4);
    let tileMax = 0;
    for (let by = 0; by < 16; by++) for (let bx = 0; bx < 16; bx++) {
      let m = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) m = Math.max(m, base[(by * 16 + y) * TILE_SIZE + bx * 16 + x]);
      tileMax = Math.max(tileMax, m);
      expect(l10[((ATY & 15) * 16 + by) * TILE_SIZE + (ATX & 15) * 16 + bx]).toBe(m);
    }
    expect(tileMax).toBe(9);
    const l6 = await tileOrEmpty(s, 6, ATX >> 8, ATY >> 8);
    expect(l6[(ATY & 255) * TILE_SIZE + (ATX & 255)]).toBe(9);
    const l2 = await tileOrEmpty(s, 2, ATX >> 12, ATY >> 12);
    expect(l2[((ATY >> 4) & 255) * TILE_SIZE + ((ATX >> 4) & 255)]).toBe(9);
  });

  it('stats: areaM2 ≈ visitedCells × cell area at that latitude, version bumps per mutation', async () => {
    const s = store();
    expect((await s.init()).version).toBe(0);
    const r = await s.markTrack(track('t1', [A, B]));
    expect(r.stats.version).toBe(1);
    const expected = r.stats.visitedCells * cellAreaM2(ACY);
    expect(Math.abs(r.stats.areaM2 - expected) / expected).toBeLessThan(0.01);
    expect(r.stats.tiles).toBe(1);
    expect(r.stats.updatedAt).toBeGreaterThan(0);
    const r2 = await s.applyPayload({ tracks: [track('t2', [A, B])], meta: { source: 'gpx', items: 1 } });
    expect(r2.stats.version).toBe(2);
    expect(r2.stats.visitedCells).toBe(r.stats.visitedCells); // same cells, counts 2
    expect(r2.stats.areaM2).toBeCloseTo(r.stats.areaM2, 6);
    const after = await s.deleteAll();
    expect(after.version).toBe(3);
    expect(after.visitedCells).toBe(0);
    expect(after.areaM2).toBe(0);
    expect(after.tiles).toBe(0);
    expect(await s.getTile(14, ATX, ATY)).toBeNull();
    expect(await s.listTracks()).toEqual([]);
    expect(await s.listBaseTiles()).toEqual([]);
  });

  it('data survives close and reopen (tiles, overviews, stats, tracks)', async () => {
    const name = `unfog-persist-${Date.now()}`;
    const s1 = store(name);
    await s1.applyPayload({ cellTiles: [{ tx: ATX, ty: ATY, counts: mask([[1, 2, 7]]) }], meta: { source: 'fow', items: 1, fileName: 'Sync.zip' } });
    await s1.markTrack(track('t1', [[A[0], A[1], 1_700_000_000_000], [B[0], B[1], 1_700_000_060_000]], 'session'));
    const stats1 = await s1.getStats();
    const base1 = await tileOrEmpty(s1, 14, ATX, ATY);
    await s1.close();
    const s2 = store(name);
    expect(await s2.init()).toEqual(stats1);
    expect(await tileOrEmpty(s2, 14, ATX, ATY)).toEqual(base1);
    expect((await tileOrEmpty(s2, 10, ATX >> 4, ATY >> 4)).some((v) => v > 0)).toBe(true);
    const tracks = await s2.listTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: 't1', source: 'session', points: 2, startMs: 1_700_000_000_000, endMs: 1_700_000_060_000 });
    expect(tracks[0].lengthM).toBeGreaterThan(200);
    expect(tracks[0].lengthM).toBeLessThan(260);
    const t = await s2.getTrack('t1');
    expect(t?.points).toEqual([[A[0], A[1], 1_700_000_000_000], [B[0], B[1], 1_700_000_060_000]]);
    expect(await s2.getTrack('nope')).toBeNull();
  });

  it('deleteTrack removes the record but keeps the counts (documented choice)', async () => {
    const s = store();
    await s.markTrack(track('t1', [A, B]));
    const before = await s.getStats();
    const after = await s.deleteTrack('t1');
    expect(after.visitedCells).toBe(before.visitedCells);
    expect(await s.getTrack('t1')).toBeNull();
    expect(await s.listTracks()).toEqual([]);
    const t = await tileOrEmpty(s, 14, ATX, ATY);
    expect(t[(ACY & 255) * TILE_SIZE + (ACX & 255)]).toBe(1);
  });

  it('bounded cache: many tiles with a tiny LRU + frequent flushes still merge correctly', async () => {
    const s = store(undefined, { cacheTiles: 16, flushEvery: 4 });
    const cellTiles = [];
    for (let i = 0; i < 40; i++) cellTiles.push({ tx: ATX + (i % 8), ty: ATY + (i >> 3), counts: mask([[i, i, 1 + (i % 5)]]) });
    const r = await s.applyPayload({ cellTiles, meta: { source: 'fow', items: 40 } });
    expect(r.stats.visitedCells).toBe(40);
    expect(r.stats.tiles).toBe(40);
    expect(r.touched).toHaveLength(40);
    for (let i = 0; i < 40; i++) {
      const t = await tileOrEmpty(s, 14, ATX + (i % 8), ATY + (i >> 3));
      expect(t[i * TILE_SIZE + i]).toBe(1 + (i % 5));
    }
    expect((await s.listBaseTiles()).length).toBe(40);
    expect((await s.rebuildStats()).visitedCells).toBe(40);
  });

  it('backup export → import reproduces counts exactly and is idempotent', async () => {
    const a = store();
    await a.applyPayload({ cellTiles: [{ tx: ATX, ty: ATY, counts: mask([[3, 3, 200], [4, 4, 1]]) }, { tx: ATX + 1, ty: ATY, counts: mask([[0, 0, 2]]) }], meta: { source: 'fow', items: 2 } });
    await a.markTrack(track('t1', [A, B], 'gpx'));
    const statsA = await a.getStats();
    const bytes = await a.exportBackup();
    expect(bytes.length).toBeGreaterThan(100);
    const b = store();
    const r = await b.importBackup(bytes);
    expect(r.stats.visitedCells).toBe(statsA.visitedCells);
    expect(r.stats.tiles).toBe(statsA.tiles);
    expect(r.stats.areaM2).toBeCloseTo(statsA.areaM2, 3);
    expect(r.touched.map((t) => `${t.tx}/${t.ty}`).sort()).toEqual([`${ATX}/${ATY}`, `${ATX + 1}/${ATY}`]);
    expect(await tileOrEmpty(b, 14, ATX, ATY)).toEqual(await tileOrEmpty(a, 14, ATX, ATY));
    expect(await tileOrEmpty(b, 14, ATX + 1, ATY)).toEqual(await tileOrEmpty(a, 14, ATX + 1, ATY));
    expect(await tileOrEmpty(b, 10, ATX >> 4, ATY >> 4)).toEqual(await tileOrEmpty(a, 10, ATX >> 4, ATY >> 4));
    expect((await b.listTracks()).map((t) => t.id)).toEqual(['t1']);
    const r2 = await b.importBackup(bytes);
    expect(r2.stats.visitedCells).toBe(statsA.visitedCells);
    expect(r2.touched).toEqual([]);
    expect((await b.listTracks()).length).toBe(1);
  });

  it('serialises concurrent mutations', async () => {
    const s = store();
    const [r1, r2, r3] = await Promise.all([
      s.markTrack(track('c1', [A, B])),
      s.markTrack(track('c2', [A, B])),
      s.applyPayload({ cellTiles: [{ tx: ATX, ty: ATY, counts: mask([[9, 9, 1]]) }], meta: { source: 'fow', items: 1 } }),
    ]);
    expect([r1.stats.version, r2.stats.version, r3.stats.version]).toEqual([1, 2, 3]);
    const t = await tileOrEmpty(s, 14, ATX, ATY);
    expect(t[(ACY & 255) * TILE_SIZE + (ACX & 255)]).toBe(2);
    expect(t[9 * TILE_SIZE + 9]).toBe(1);
  });
});
