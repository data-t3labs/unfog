import { describe, expect, it } from 'vitest';
import { cellToTile, lonLatToCell, parseTileKey, tileKey } from './cell';
import { rasterizeTrack, subtractRaster } from './raster';

const A: [number, number] = [-73.9568, 40.7176];
const B: [number, number] = [-73.954, 40.7176]; // ~236 m east
const FAR: [number, number] = [-73.9, 40.7176]; // ~4.8 km east → gap

function totalCells(m: Map<number, Uint32Array>): number {
  let n = 0;
  for (const v of m.values()) n += v.length;
  return n;
}

describe('rasterizeTrack', () => {
  it('groups distinct cells by base tile with sorted indices', () => {
    const r = rasterizeTrack([A, B]);
    const [cx, cy] = lonLatToCell(A[0], A[1]);
    const { tx, ty } = cellToTile(cx, cy);
    expect([...r.keys()].map(parseTileKey).every((k) => k.level === 14)).toBe(true);
    expect(r.has(tileKey(14, tx, ty))).toBe(true);
    for (const idx of r.values()) {
      for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    }
    expect(totalCells(r)).toBeGreaterThanOrEqual(30); // 236 m / 7.2 m
  });

  it('a track that crosses the same cells twice marks them once', () => {
    const once = rasterizeTrack([A, B]);
    const twice = rasterizeTrack([A, B, A, B]);
    expect(totalCells(twice)).toBe(totalCells(once));
    for (const [k, v] of once) expect(twice.get(k)).toEqual(v);
  });

  it('honours the gap rule: nothing is marked between fixes further apart than gapM', () => {
    const withGap = rasterizeTrack([A, B, FAR]);
    const noGap = rasterizeTrack([A, B]);
    expect(totalCells(withGap)).toBe(totalCells(noGap) + 1);
    const joined = rasterizeTrack([A, B, FAR], { gapM: 10_000 });
    expect(totalCells(joined)).toBeGreaterThan(totalCells(noGap) + 500);
  });

  it('accepts [lon, lat, t] points and ignores t', () => {
    const r = rasterizeTrack([[A[0], A[1], 1e12], [B[0], B[1], 1e12 + 1000]]);
    expect(totalCells(r)).toBe(totalCells(rasterizeTrack([A, B])));
  });

  it('subtractRaster keeps only cells the earlier polyline did not touch (checkpoint merges)', () => {
    const C: [number, number] = [-73.954, 40.7196]; // ~220 m north of B
    const old = rasterizeTrack([A, B]);
    const full = rasterizeTrack([A, B, C]);
    const diff = subtractRaster(full, old);
    expect(totalCells(diff)).toBe(totalCells(full) - totalCells(old));
    for (const [k, cells] of diff) {
      const o = old.get(k);
      for (const c of cells) expect(o ? o.includes(c) : false).toBe(false);
      for (let i = 1; i < cells.length; i++) expect(cells[i]).toBeGreaterThan(cells[i - 1]);
    }
    expect(totalCells(subtractRaster(old, old))).toBe(0);
    expect(subtractRaster(old, new Map())).toEqual(old);
  });
});
