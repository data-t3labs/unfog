import { describe, expect, it } from 'vitest';
import { WORLD, cellAreaM2, cellToLonLat, cellToTile, cellsAlong, fowToCell, lonLatToCell, metresPerCell, parseTileKey, tileBounds, tileKey } from './cell';

describe('cell math', () => {
  it('matches Fog of World: Vancouver lands in FoW tile (80,175) = id 89680', () => {
    const [cx, cy] = lonLatToCell(-123.12, 49.28);
    expect(cx >> 13).toBe(80);
    expect(cy >> 13).toBe(175);
  });

  it('round-trips lon/lat through a cell centre within one cell', () => {
    const [cx, cy] = lonLatToCell(-73.9568, 40.7176);
    const [lon, lat] = cellToLonLat(cx, cy);
    const [cx2, cy2] = lonLatToCell(lon, lat);
    expect([cx2, cy2]).toEqual([cx, cy]);
    expect(Math.abs(lon + 73.9568)).toBeLessThan(1e-4);
    expect(Math.abs(lat - 40.7176)).toBeLessThan(1e-4);
  });

  it('cell size is 9.55 m at the equator and 7.2 m in NYC', () => {
    expect(metresPerCell(0)).toBeCloseTo(9.554, 2);
    expect(metresPerCell(40.7)).toBeCloseTo(7.24, 1);
    const [, cy] = lonLatToCell(-73.95, 40.7);
    expect(cellAreaM2(cy)).toBeCloseTo(7.24 * 7.24, 0);
  });

  it('splits cells into z14 tiles and back', () => {
    const { tx, ty, ix, iy } = cellToTile(WORLD - 1, 0);
    expect(tx).toBe(16383); expect(ix).toBe(255); expect(ty).toBe(0); expect(iy).toBe(0);
    const k = tileKey(10, 123, 456);
    expect(parseTileKey(k)).toEqual({ level: 10, tx: 123, ty: 456 });
  });

  it('fowToCell composes tile/block/pixel exactly like the FoW format', () => {
    expect(fowToCell(412, 229, 0, 0, 0, 0)).toEqual([412 << 13, 229 << 13]);
    expect(fowToCell(0, 0, 127, 127, 63, 63)).toEqual([8191, 8191]);
  });

  it('tileBounds at level 14 spans exactly 256 cells', () => {
    const [cx, cy] = lonLatToCell(-73.9568, 40.7176);
    const { tx, ty } = cellToTile(cx, cy);
    const b = tileBounds(14, tx, ty);
    const [w] = lonLatToCell(b.west + 1e-9, b.north - 1e-9);
    expect(w).toBe(tx * 256);
  });

  it('cellsAlong samples every cell on a straight segment with no duplicates and honours gaps', () => {
    const a: [number, number] = [-73.9568, 40.7176];
    const b: [number, number] = [-73.9540, 40.7176]; // ~236 m east
    const cells = cellsAlong([a, b]);
    const keys = new Set(cells.map(([x, y]) => `${x},${y}`));
    expect(keys.size).toBe(cells.length);
    expect(cells.length).toBeGreaterThanOrEqual(30); // 236 m / 7.2 m ≈ 33 cells
    const far: [number, number] = [-73.90, 40.7176]; // 4.8 km → gap
    const withGap = cellsAlong([a, b, far]);
    expect(withGap.length).toBe(cells.length + 1);
  });
});
