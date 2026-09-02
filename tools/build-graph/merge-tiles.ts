/**
 * Border merge for multi-extract builds (coverage v2).
 *
 * Per-extract builds are exact inside an extract but not at its edges: a way that crosses the
 * border is complete in BOTH extracts (Geofabrik keeps crossing ways whole), yet each extract
 * only knows the junctions with its own local streets — the other side's junctions look like
 * plain shape points, so each build emits arcs that skip them, and no union of the two tile sets
 * can produce the exact arc between a junction known only to A and one known only to B.
 *
 * Exact fix: rebuild every tile near a border from the UNION OF WAYS of every extract that
 * touches it. Each way is complete in at least one extract, so the union is the complete way set
 * and every junction has its true reference count.
 *   B  = border tiles: emitted by ≥ 2 extracts;
 *   R  = ring1(B): tiles rebuilt from the union;
 *   W  = ring2(R): ways touching these tiles feed the rebuild (an arc leaving R is cut exactly
 *        unless it runs > 2 tiles ≈ 15 km without a junction — accepted).
 * Work is planned per zoom-6 cell (`planBorders`) so `build-continent merge` is resumable, and
 * a way is written once per cell whose W it touches (`wayCells`).
 *
 * merge-tiles.test.ts proves it on the Williamsburg fixture split into two complete-way halves:
 * per-half tiles differ from the single full build; rebuilt tiles equal it byte for byte.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GRAPH_ZOOM, graphTilePath, lonLatToGraphTile, packGraphTile, type GraphTileInput, type RegionManifest } from '../../src/routing/graph-format';
import { buildGraphTiles, type BuildOptionsEx, type BuildResultEx } from '../../src/routing/graph-build';
import type { OsmWay } from '../../src/routing/osm-types';
import { PACK_ZOOM, cellKey, cellOf } from '../../src/routing/pack-format';

export type TileKey = string; // "x/y"
export const tileKey = (x: number, y: number): TileKey => `${x}/${y}`;
export function parseTileKey(k: TileKey): [x: number, y: number] {
  const i = k.indexOf('/');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}

/** Chebyshev dilation of a tile set by r (clamped to the zoom's grid). */
export function ring(tiles: Iterable<TileKey>, r: number, zoom = GRAPH_ZOOM): Set<TileKey> {
  const n = 1 << zoom;
  const out = new Set<TileKey>();
  for (const k of tiles) {
    const [x, y] = parseTileKey(k);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < n && yy >= 0 && yy < n) out.add(tileKey(xx, yy));
    }
  }
  return out;
}

export interface ExtractTiles {
  id: string;
  tiles: Array<[tx: number, ty: number, ...rest: number[]]>;
}

/** Tiles emitted by at least two extracts. */
export function borderTiles(extracts: ExtractTiles[]): Set<TileKey> {
  const count = new Map<TileKey, number>();
  for (const e of extracts) for (const [x, y] of e.tiles) { const k = tileKey(x, y); count.set(k, (count.get(k) ?? 0) + 1); }
  const out = new Set<TileKey>();
  for (const [k, c] of count) if (c >= 2) out.add(k);
  return out;
}

export interface CellPlan {
  /** Tiles of this cell rebuilt from the way union. */
  rebuild: TileKey[];
  /** Tiles whose touching ways feed the rebuild (may reach into neighbouring cells). */
  wayTiles: TileKey[];
  /** Extract ids that emitted at least one wayTile (only they can hold relevant ways). */
  extracts: string[];
}

export interface BorderPlan {
  zoom: number;
  packZoom: number;
  border: TileKey[];
  cells: Record<string, CellPlan>;
}

export interface PlanOptions {
  zoom?: number;
  packZoom?: number;
  /** Ring around B that is rebuilt (default 1). */
  ringRebuild?: number;
  /** Ring around the rebuild set whose ways are read (default 2). */
  ringWays?: number;
}

export function planBorders(extracts: ExtractTiles[], opts: PlanOptions = {}): BorderPlan {
  const zoom = opts.zoom ?? GRAPH_ZOOM, packZoom = opts.packZoom ?? PACK_ZOOM;
  const B = borderTiles(extracts);
  const R = ring(B, opts.ringRebuild ?? 1, zoom);
  const byCell = new Map<string, TileKey[]>();
  for (const k of R) {
    const [x, y] = parseTileKey(k);
    const [cx, cy] = cellOf(x, y, zoom, packZoom);
    const ck = cellKey(cx, cy, packZoom);
    let list = byCell.get(ck);
    if (!list) { list = []; byCell.set(ck, list); }
    list.push(k);
  }
  const emitted = new Map<TileKey, Set<string>>();
  for (const e of extracts) for (const [x, y] of e.tiles) {
    const k = tileKey(x, y);
    let s = emitted.get(k);
    if (!s) { s = new Set(); emitted.set(k, s); }
    s.add(e.id);
  }
  const cells: Record<string, CellPlan> = {};
  const numeric = (a: TileKey, b: TileKey) => { const [ax, ay] = parseTileKey(a), [bx, by] = parseTileKey(b); return ay - by || ax - bx; };
  for (const [ck, rebuild] of [...byCell].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
    const wayTiles = [...ring(rebuild, opts.ringWays ?? 2, zoom)].sort(numeric);
    const ids = new Set<string>();
    for (const k of wayTiles) for (const id of emitted.get(k) ?? []) ids.add(id);
    cells[ck] = { rebuild: rebuild.sort(numeric), wayTiles, extracts: [...ids].sort() };
  }
  return { zoom, packZoom, border: [...B].sort(numeric), cells };
}

/** tile → cells whose wayTiles contain it. */
export function wayTileIndex(plan: BorderPlan): Map<TileKey, string[]> {
  const idx = new Map<TileKey, string[]>();
  for (const [ck, c] of Object.entries(plan.cells)) for (const k of c.wayTiles) {
    let list = idx.get(k);
    if (!list) { list = []; idx.set(k, list); }
    list.push(ck);
  }
  return idx;
}

/** Cells a way belongs to = cells whose wayTiles contain the tile of any of its nodes. */
export function wayCells(way: { coords: Array<[number, number] | undefined> }, idx: Map<TileKey, string[]>, zoom: number): string[] {
  const out = new Set<string>();
  let last = '';
  for (const c of way.coords) {
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const [x, y] = lonLatToGraphTile(c[0], c[1], zoom);
    const k = tileKey(x, y);
    if (k === last) continue;
    last = k;
    for (const ck of idx.get(k) ?? []) out.add(ck);
  }
  return [...out];
}

/** Partition in-memory ways per cell (the border-extract subcommand streams the same logic to files). */
export function partitionWays(ways: Iterable<OsmWay>, plan: BorderPlan): Map<string, OsmWay[]> {
  const idx = wayTileIndex(plan);
  const out = new Map<string, OsmWay[]>();
  for (const w of ways) for (const ck of wayCells(w, idx, plan.zoom)) {
    let list = out.get(ck);
    if (!list) { list = []; out.set(ck, list); }
    list.push(w);
  }
  return out;
}

/** Union of way lists by way id (first occurrence wins — copies of a way are identical across extracts). */
export function dedupeWays(lists: Iterable<Iterable<OsmWay>>): OsmWay[] {
  const seen = new Set<number>();
  const out: OsmWay[] = [];
  for (const list of lists) for (const w of list) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    out.push(w);
  }
  return out;
}

export interface RebuiltCell {
  tiles: Map<TileKey, GraphTileInput>;
  result: BuildResultEx;
  /** Rebuild tiles the union produced nothing for (no graph node inside — legitimately empty). */
  empty: TileKey[];
}

/** Build the way union of one cell and keep only its rebuild tiles. */
export function rebuildCell(cell: CellPlan, ways: Iterable<OsmWay>, zoom: number, opts: BuildOptionsEx = {}): RebuiltCell {
  const result = buildGraphTiles(ways, { ...opts, zoom });
  const want = new Set(cell.rebuild);
  const tiles = new Map<TileKey, GraphTileInput>();
  for (const k of cell.rebuild) { const t = result.tiles.get(k); if (t) tiles.set(k, t); }
  const empty = cell.rebuild.filter((k) => !tiles.has(k));
  void want;
  return { tiles, result, empty };
}

/** Write tiles + manifest the way the CLI does (`<out>/<zoom>/<x>/<y>.ufg`, `<out>/manifest.json`). */
export function writeTiles(out: string, tiles: Iterable<GraphTileInput>, fields: Pick<RegionManifest, 'id' | 'name' | 'source'> & Partial<RegionManifest>): RegionManifest {
  mkdirSync(out, { recursive: true });
  const list: RegionManifest['tiles'] = [];
  let zoom = fields.zoom ?? GRAPH_ZOOM;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const t of tiles) {
    zoom = t.zoom ?? zoom;
    const packed = packGraphTile(t);
    const file = join(out, graphTilePath(t.tx, t.ty, zoom));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, packed);
    list.push([t.tx, t.ty, packed.length]);
    for (let i = 0; i < t.nodeId.length; i++) {
      const lon = t.nodeLon[i] / 1e7, lat = t.nodeLat[i] / 1e7;
      if (lon < west) west = lon; if (lon > east) east = lon; if (lat < south) south = lat; if (lat > north) north = lat;
    }
  }
  list.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  const manifest: RegionManifest = {
    id: fields.id, name: fields.name, zoom,
    bbox: fields.bbox ?? (Number.isFinite(west) ? [round(west), round(south), round(east), round(north)] : [0, 0, 0, 0]),
    tiles: list,
    builtAt: fields.builtAt ?? new Date().toISOString(),
    source: fields.source,
    stats: fields.stats ?? { nodes: 0, arcs: 0, km: 0 },
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
