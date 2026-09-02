/**
 * Group built z12 tiles into z6 packs (src/routing/pack-format.ts) and write packs-index.json.
 * Library used by build-continent.ts; pure functions are unit-tested in pack-tiles.test.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRAPH_ZOOM, graphTilePath, type RegionManifest } from '../../src/routing/graph-format';
import { PACKS_INDEX_NAME, PACK_ZOOM, cellKey, cellOf, encodePack, packFileName, type PackInfo, type PacksIndex } from '../../src/routing/pack-format';

export interface TileFile {
  tx: number;
  ty: number;
  file: string;
  /** Where the tile came from (extract id or "merged"), for the pack's `source` line. */
  origin: string;
}

/** Tiles listed by a region manifest (`<dir>/manifest.json`), as files. */
export function tilesFromManifestDir(dir: string, origin: string): TileFile[] {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as RegionManifest;
  return m.tiles.map(([tx, ty]) => ({ tx, ty, file: join(dir, graphTilePath(tx, ty, m.zoom ?? GRAPH_ZOOM)), origin }));
}

export interface CellGroup {
  key: string;
  cell: [cx: number, cy: number];
  tiles: TileFile[];
  /** Every origin that contributed a tile to this cell, overridden ones included. */
  origins: string[];
}

/**
 * Group tiles by z6 cell. When the same tile key appears more than once the LAST occurrence wins
 * (callers list per-extract tiles first and merged border tiles last).
 */
export function groupByCell(tiles: TileFile[], zoom = GRAPH_ZOOM, packZoom = PACK_ZOOM): CellGroup[] {
  const byKey = new Map<string, TileFile>();
  const originsByCell = new Map<string, Set<string>>();
  for (const t of tiles) {
    byKey.set(`${t.tx}/${t.ty}`, t);
    const [cx, cy] = cellOf(t.tx, t.ty, zoom, packZoom);
    const key = cellKey(cx, cy, packZoom);
    let o = originsByCell.get(key);
    if (!o) { o = new Set(); originsByCell.set(key, o); }
    o.add(t.origin);
  }
  const groups = new Map<string, CellGroup>();
  for (const t of byKey.values()) {
    const cell = cellOf(t.tx, t.ty, zoom, packZoom);
    const key = cellKey(cell[0], cell[1], packZoom);
    let g = groups.get(key);
    if (!g) { g = { key, cell, tiles: [], origins: [...originsByCell.get(key)!].sort() }; groups.set(key, g); }
    g.tiles.push(t);
  }
  return [...groups.values()].sort((a, b) => a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0]);
}

export interface WrittenPack {
  key: string;
  file: string;
  name: string;
  bytes: number;
  indexBytes: number;
  tiles: number;
  sha256: string;
  origins: string[];
}

/** Write one pack file for a cell group; returns what packs-index.json needs. */
export function writePack(group: CellGroup, outDir: string): WrittenPack {
  const tiles = group.tiles.map((t) => ({ tx: t.tx, ty: t.ty, bytes: new Uint8Array(readFileSync(t.file)) }));
  const { bytes, index } = encodePack(group.cell, tiles);
  mkdirSync(outDir, { recursive: true });
  const name = packFileName(group.cell[0], group.cell[1]);
  const file = join(outDir, name);
  writeFileSync(file, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { key: group.key, file, name, bytes: bytes.length, indexBytes: index.indexBytes, tiles: index.tileCount, sha256, origins: group.origins };
}

export function packInfoOf(p: WrittenPack, urlBase: string, source: string, builtAt: string): PackInfo {
  return { url: urlBase + p.name, bytes: p.bytes, indexBytes: p.indexBytes, tiles: p.tiles, builtAt, source, sha256: p.sha256 };
}

export function readPacksIndex(dir: string): PacksIndex | null {
  const f = join(dir, PACKS_INDEX_NAME);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')) as PacksIndex; } catch { return null; }
}

export function writePacksIndex(dir: string, index: PacksIndex): string {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, PACKS_INDEX_NAME);
  const sorted: PacksIndex = { ...index, packs: Object.fromEntries(Object.entries(index.packs).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) };
  writeFileSync(f, JSON.stringify(sorted, null, 1) + '\n');
  return f;
}
