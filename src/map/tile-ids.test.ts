import { describe, expect, it } from 'vitest';
import { MARGIN_CELLS, overlayTileIdsFor } from './tile-ids';

// src/map had no test; this helper is pure and decides which tiles the live-fog refresh reloads.
describe('overlayTileIdsFor', () => {
  it('covers the z14 tile itself, its parents, its children, and the blur margin neighbours', () => {
    const ids = overlayTileIdsFor([{ tx: 4826, ty: 6156 }]);
    const has = (z: number, x: number, y: number) => ids.some((t) => t.z === z && t.x === x && t.y === y);
    expect(has(14, 4826, 6156)).toBe(true);
    // Parents at every zoom down to 2.
    for (let z = 13; z >= 2; z--) expect(has(z, 4826 >> (14 - z), 6156 >> (14 - z))).toBe(true);
    // Children at z16 (4×4 block) and the margin ring around it (32 cells = half a z16 tile).
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) expect(has(16, 4826 * 4 + dx, 6156 * 4 + dy)).toBe(true);
    expect(has(16, 4826 * 4 - 1, 6156 * 4)).toBe(true);
    expect(has(16, 4826 * 4 + 4, 6156 * 4 + 3)).toBe(true);
    expect(has(16, 4826 * 4 - 2, 6156 * 4)).toBe(false);
    // At z14 the margin reaches the 8 neighbours but no further.
    expect(has(14, 4825, 6155)).toBe(true);
    expect(has(14, 4827, 6157)).toBe(true);
    expect(has(14, 4824, 6156)).toBe(false);
    // No zoom outside the requested range, no duplicates.
    expect(ids.every((t) => t.z >= 2 && t.z <= 18)).toBe(true);
    expect(new Set(ids.map((t) => `${t.z}/${t.x}/${t.y}`)).size).toBe(ids.length);
    expect(MARGIN_CELLS).toBeGreaterThanOrEqual(3 * 6 + 1);
  });

  it('merges neighbouring touched tiles without duplicates and clamps at the world edge', () => {
    const one = overlayTileIdsFor([{ tx: 10, ty: 10 }]).length;
    const two = overlayTileIdsFor([{ tx: 10, ty: 10 }, { tx: 11, ty: 10 }]).length;
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(2 * one);
    const edge = overlayTileIdsFor([{ tx: 0, ty: 0 }], 14, 14);
    expect(edge.every((t) => t.x >= 0 && t.y >= 0)).toBe(true);
    expect(overlayTileIdsFor([], 2, 18)).toEqual([]);
  });
});
