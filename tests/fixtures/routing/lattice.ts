/**
 * TEST-ONLY synthetic street lattice: `size` × `size` nodes spaced `spacingM` metres, every edge
 * a two-way street WALK|BIKE|DRIVE (optionally some oneways). Placed so it straddles a z12 tile
 * boundary (x = 1205/1206 at −73.9453125°) unless told otherwise, to exercise merge + foreign nodes.
 */
import { ArcFlag, type GraphTileInput } from '../../../src/routing/graph-format';
import { buildTestTiles, type TestWay } from './tile-builder';

export const ALL_MODES = ArcFlag.WALK | ArcFlag.BIKE | ArcFlag.DRIVE;

export interface LatticeOptions {
  size?: number;
  spacingM?: number;
  /** Lon/lat of node (0,0) — the north-west corner. */
  origin?: [number, number];
  /** Rows that are oneway west→east for vehicles (walk still both ways). */
  onewayRows?: number[];
  /** Extra ways built into the same tiles (node ids ≥ 100000 are free; lattice node (c, r) is `id(c, r)`). */
  extraWays?: TestWay[];
}

export interface Lattice {
  size: number;
  spacingM: number;
  tiles: Map<string, GraphTileInput>;
  /** Lon/lat of lattice node (col, row). */
  at(col: number, row: number): [number, number];
  /** OSM-style node id of (col, row). */
  id(col: number, row: number): number;
}

export function makeLattice(opts: LatticeOptions = {}): Lattice {
  const size = opts.size ?? 30;
  const spacingM = opts.spacingM ?? 100;
  const origin = opts.origin ?? [-73.9453125 - ((size - 1) / 2) * (spacingM / (111_320 * Math.cos((40.72 * Math.PI) / 180))), 40.735];
  const dLon = spacingM / (111_320 * Math.cos(origin[1] * (Math.PI / 180)));
  const dLat = spacingM / 110_574;
  const at = (c: number, r: number): [number, number] => [origin[0] + c * dLon, origin[1] - r * dLat];
  const id = (c: number, r: number) => 1000 + r * size + c;
  const oneway = new Set(opts.onewayRows ?? []);
  const ways: TestWay[] = [];
  let wid = 1;
  // Each row and column is one way through all its nodes (intermediate nodes are shared with
  // the crossing ways, so every intersection becomes a graph node and each block an arc).
  for (let r = 0; r < size; r++) {
    const refs: number[] = [], coords: Array<[number, number]> = [];
    for (let c = 0; c < size; c++) { refs.push(id(c, r)); coords.push(at(c, r)); }
    const rev = oneway.has(r) ? ArcFlag.WALK : ALL_MODES;
    ways.push({ id: wid++, refs, coords, fwd: ALL_MODES, rev });
  }
  for (let c = 0; c < size; c++) {
    const refs: number[] = [], coords: Array<[number, number]> = [];
    for (let r = 0; r < size; r++) { refs.push(id(c, r)); coords.push(at(c, r)); }
    ways.push({ id: wid++, refs, coords, fwd: ALL_MODES, rev: ALL_MODES });
  }
  for (const w of opts.extraWays ?? []) ways.push({ ...w, id: w.id || wid++ });
  return { size, spacingM, tiles: buildTestTiles(ways), at, id };
}
