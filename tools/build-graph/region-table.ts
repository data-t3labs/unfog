/**
 * Region table for the Data screen's pack labels (coverage v2, polish round 2) — the compact
 * build-time table `src/routing/pack-regions.json` (PackRegionTable in src/routing/pack-format.ts).
 *
 * Why: a pack's `source` names every Geofabrik extract that touched its z6 cell — nine on the
 * NYC cell (Delaware … West Virginia) — and the client has nothing else per cell: the pack header
 * carries only cell x/y and the UFG1 tiles no origin. This table lets src/app/pack-label.ts name
 * the ONE region the user's cached tiles are in ("Streets near New York (US)"):
 *   - per extract: display name, country tag, bbox (from its manifest);
 *   - per cell with ≥ 2 extracts: a z10 dominance grid — one character per z10 tile (16×16 in a
 *     z6 cell), the extract with the most street DATA there (the sum of its z12 tiles' bytes from
 *     its manifest); ties go to the alphabetically first. Bytes, not tile counts: a z12 tile that
 *     straddles a border is in both extracts' manifests, so by count New Jersey owns Brooklyn's
 *     z10 tile (Hoboken slivers count like Manhattan); by bytes New York does.
 * Built from `<work>/extracts/<slug>/manifest.json` (every z12 tile per extract with its size,
 * bbox) by `continent.js regions`, also run at the end of `pack`. ~40 KB of JSON (≈ 7 KB gzipped).
 * Deterministic: same manifests → byte-identical table (builtAt aside).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRAPH_ZOOM, type RegionManifest } from '../../src/routing/graph-format';
import { GRID_CHARS, GRID_EMPTY, LABEL_GRID_ZOOM, PACK_ZOOM, cellKey, cellOf, type PackRegionInfo, type PackRegionTable } from '../../src/routing/pack-format';
import { CANADA } from './fetch-extracts';

export interface ExtractTilesInput {
  /** Geofabrik id: `us/new-york`, `british-columbia`, `mexico`. */
  id: string;
  bbox: [west: number, south: number, east: number, north: number];
  /** z12 tiles with the size of the tile as built from THIS extract (the dominance weight; 1 when absent). */
  tiles: Array<[tx: number, ty: number, bytes?: number]>;
}

/** Names that title-casing the id gets wrong or too long for one 36-character line. */
const NAME_OVERRIDES: Record<string, string> = {
  'us/district-of-columbia': 'Washington, DC',
  'us/us-virgin-islands': 'Virgin Islands',
  'newfoundland-and-labrador': 'Newfoundland & Labrador',
};
const SMALL_WORDS = new Set(['of', 'and', 'the']);

/** "us/new-york" → "New York"; "prince-edward-island" → "Prince Edward Island"; overrides first. */
export function regionDisplayName(id: string): string {
  const o = NAME_OVERRIDES[id];
  if (o) return o;
  const last = id.split('/').pop() ?? id;
  return last
    .split('-')
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Country tag for a Geofabrik id (this continent's naming: `us/<state>`, bare provinces, `mexico`, `greenland`). */
export function regionCountry(id: string): string {
  if (id.startsWith('us/')) return 'US';
  if (CANADA.includes(id)) return 'CA';
  if (id === 'mexico') return 'MX';
  if (id === 'greenland') return 'GL';
  return '';
}

/** Read one extract's manifest as the generator's input. */
export function extractTilesFromManifest(dir: string): ExtractTilesInput {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as RegionManifest;
  return { id: m.name, bbox: m.bbox, tiles: m.tiles.map(([tx, ty, bytes]) => [tx, ty, bytes]) };
}

/**
 * The table. Pure: extracts in → table out. Cells a single extract covers get no entry; the
 * label for those is the source line's one region.
 */
export function buildRegionTable(extracts: ExtractTilesInput[], opts: { zoom?: number; packZoom?: number; gridZoom?: number; builtAt?: string } = {}): PackRegionTable {
  const zoom = opts.zoom ?? GRAPH_ZOOM, packZoom = opts.packZoom ?? PACK_ZOOM, gridZoom = opts.gridZoom ?? LABEL_GRID_ZOOM;
  if (!(packZoom < gridZoom && gridZoom <= zoom)) throw new Error(`region table: need packZoom < gridZoom ≤ zoom, got ${packZoom} / ${gridZoom} / ${zoom}`);
  const side = 1 << (gridZoom - packZoom);
  const shift = zoom - gridZoom;
  const sorted = extracts.slice().sort((a, b) => a.id.localeCompare(b.id));
  const regions: Record<string, PackRegionInfo> = {};
  // cell → extract id → per-grid-position weight (bytes of the extract's z12 tiles there)
  const counts = new Map<string, Map<string, Float64Array>>();
  for (const e of sorted) {
    if (regions[e.id]) throw new Error(`region table: duplicate extract ${e.id}`);
    regions[e.id] = { name: regionDisplayName(e.id), cc: regionCountry(e.id), bbox: e.bbox };
    for (const [tx, ty, bytes] of e.tiles) {
      const [cx, cy] = cellOf(tx, ty, zoom, packZoom);
      const key = cellKey(cx, cy, packZoom);
      let byExtract = counts.get(key);
      if (!byExtract) { byExtract = new Map(); counts.set(key, byExtract); }
      let grid = byExtract.get(e.id);
      if (!grid) { grid = new Float64Array(side * side); byExtract.set(e.id, grid); }
      const ix = (tx >> shift) - cx * side, iy = (ty >> shift) - cy * side;
      grid[iy * side + ix] += bytes && bytes > 0 ? bytes : 1;
    }
  }
  const cells: PackRegionTable['cells'] = {};
  const keys = [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const key of keys) {
    const byExtract = counts.get(key)!;
    if (byExtract.size < 2) continue;
    const ids = [...byExtract.keys()].sort((a, b) => a.localeCompare(b));
    if (ids.length > GRID_CHARS.length) throw new Error(`region table: ${ids.length} extracts in ${key}, more than ${GRID_CHARS.length}`);
    let grid = '';
    for (let pos = 0; pos < side * side; pos++) {
      let best = -1, bestN = 0;
      ids.forEach((id, i) => {
        const n = byExtract.get(id)![pos];
        if (n > bestN) { best = i; bestN = n; }
      });
      grid += best < 0 ? GRID_EMPTY : GRID_CHARS[best];
    }
    cells[key] = { regions: ids, grid };
  }
  return { version: 1, zoom, packZoom, gridZoom, builtAt: opts.builtAt ?? new Date().toISOString(), regions, cells };
}

/** Compact JSON: one line per cell so the file diffs by cell. */
export function serializeRegionTable(t: PackRegionTable): string {
  const lines: string[] = [];
  lines.push('{');
  lines.push(` "version": ${t.version}, "zoom": ${t.zoom}, "packZoom": ${t.packZoom}, "gridZoom": ${t.gridZoom}, "builtAt": ${JSON.stringify(t.builtAt)},`);
  lines.push(' "regions": {');
  const rids = Object.keys(t.regions);
  rids.forEach((id, i) => lines.push(`  ${JSON.stringify(id)}: ${JSON.stringify(t.regions[id])}${i < rids.length - 1 ? ',' : ''}`));
  lines.push(' },');
  lines.push(' "cells": {');
  const cids = Object.keys(t.cells);
  cids.forEach((k, i) => lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(t.cells[k])}${i < cids.length - 1 ? ',' : ''}`));
  lines.push(' }');
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function writeRegionTable(file: string, t: PackRegionTable): void {
  writeFileSync(file, serializeRegionTable(t));
}
