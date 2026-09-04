/**
 * Pack labels for Data → Routing data: "Streets near New York (US)" — ONE region per cached cell,
 * one short line, deterministic.
 *
 * A pack's `source` names every Geofabrik extract that touched its z6 cell, up to nine on a
 * border cell ("Geofabrik us/delaware, us/district-of-columbia, … (+ border merge)" for the cell
 * that holds New York City — its centre is near Dover, Delaware). Listing them wrapped the row
 * over three or four lines and named the wrong places. The region the user's cached streets are
 * actually in comes from the build-time table src/routing/pack-regions.json (tools/build-graph/
 * region-table.ts): per multi-extract cell a z10 grid naming the extract with the most street
 * data in each z10 tile. The cached tiles of the cell (`PackCacheCell.sub`, by z10 sub-cell)
 * vote; the most tiles win, ties go to the most recently used sub-cell, then alphabetically.
 * Fallbacks, in order: a cell the table does not know → the listed region whose bbox holds the
 * cached tiles' centroid deepest inside; none → the first listed region "+ N more".
 *
 * One line: the country tag "(US)" is kept only while "Streets near …" stays within
 * MAX_LINE_CHARS; the row's CSS (nowrap + ellipsis) covers Dynamic Type beyond that.
 */
import type { PackCacheCell } from '../routing/api';
import { graphTileBounds } from '../routing/graph-format';
import { GRID_CHARS, GRID_EMPTY, LABEL_GRID_ZOOM, parseCellKey, type PackRegionTable } from '../routing/pack-format';
import regionsJson from '../routing/pack-regions.json';

export const REGIONS = regionsJson as unknown as PackRegionTable;
export const LABEL_PREFIX = 'Streets near ';
/** The longest line that fits the Data row at the default text size (17 px root, 16 px semibold). */
export const MAX_LINE_CHARS = 36;

export type LabelCell = Pick<PackCacheCell, 'cell' | 'source' | 'sub'>;

export interface PickedRegion {
  id: string;
  /** How the region was chosen (tests + the fallback wording). */
  how: 'single' | 'grid' | 'bbox' | 'first';
  /** Regions the source names that the label leaves out. */
  more: number;
}

/**
 * Extract ids named by a pack's source line, in order, deduplicated: "Geofabrik us/delaware,
 * ontario (+ border merge)" → ['us/delaware', 'ontario']. A date after an id ("us/new-york
 * 2026-09-02", the prebuilt-region wording) is ignored; anything that is not an id is skipped.
 */
export function sourceRegions(source: string | undefined): string[] {
  if (!source) return [];
  const body = source.replace(/^\s*geofabrik\s+/i, '').replace(/\s*\(\+[^)]*\)\s*$/, '');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of body.split(',')) {
    const id = part.trim().split(/\s+/)[0] ?? '';
    if (!/^[a-z][a-z-]*(?:\/[a-z][a-z-]*)*$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface RegionName {
  name: string;
  cc: string;
}

/** Display name + country tag: the table's, else derived from the id ("canada/british-columbia" → "British Columbia", "Canada"). */
export function regionName(id: string, table: PackRegionTable = REGIONS): RegionName {
  const r = table.regions[id];
  if (r) return { name: r.name, cc: r.cc };
  const parts = id.split('/');
  const last = parts[parts.length - 1];
  const country = parts.length >= 2 ? parts[parts.length - 2] : '';
  const name = last.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const cc = country ? (country.length <= 3 ? country.toUpperCase() : country.charAt(0).toUpperCase() + country.slice(1)) : '';
  return { name, cc };
}

/** The region of a cached cell — see the file comment for the order of evidence. Null without a source. */
export function pickRegion(cell: LabelCell, table: PackRegionTable = REGIONS): PickedRegion | null {
  const ids = sourceRegions(cell.source);
  if (!ids.length) return null;
  if (ids.length === 1) return { id: ids[0], how: 'single', more: 0 };
  const sub = cell.sub ?? [];
  const cxy = parseCellKey(cell.cell);
  const entry = table.cells[cell.cell];
  if (entry && cxy && sub.length && table.gridZoom === LABEL_GRID_ZOOM) {
    const side = 1 << (table.gridZoom - table.packZoom);
    const votes = new Map<string, { tiles: number; lastUsed: number }>();
    for (const [x, y, tiles, lastUsed] of sub) {
      const ix = x - cxy[0] * side, iy = y - cxy[1] * side;
      if (ix < 0 || iy < 0 || ix >= side || iy >= side) continue;
      const ch = entry.grid[iy * side + ix];
      const id = ch === GRID_EMPTY ? undefined : entry.regions[GRID_CHARS.indexOf(ch)];
      if (!id) continue;
      const v = votes.get(id) ?? { tiles: 0, lastUsed: 0 };
      v.tiles += tiles;
      v.lastUsed = Math.max(v.lastUsed, lastUsed);
      votes.set(id, v);
    }
    const best = [...votes.entries()].sort((a, b) => b[1].tiles - a[1].tiles || b[1].lastUsed - a[1].lastUsed || a[0].localeCompare(b[0]))[0];
    if (best) return { id: best[0], how: 'grid', more: ids.length - 1 };
  }
  // The table does not know this cell (a pack newer than the table): the listed region whose bbox
  // holds the cached tiles' centroid deepest inside.
  if (sub.length) {
    let lon = 0, lat = 0, n = 0;
    for (const [x, y, tiles] of sub) {
      const b = graphTileBounds(x, y, LABEL_GRID_ZOOM);
      lon += ((b.west + b.east) / 2) * tiles;
      lat += ((b.south + b.north) / 2) * tiles;
      n += tiles;
    }
    lon /= n; lat /= n;
    let bestId: string | null = null, bestMargin = -Infinity;
    for (const id of ids) {
      const box = table.regions[id]?.bbox;
      if (!box) continue;
      const margin = Math.min(lon - box[0], box[2] - lon, lat - box[1], box[3] - lat);
      if (margin >= 0 && margin > bestMargin) { bestMargin = margin; bestId = id; }
    }
    if (bestId) return { id: bestId, how: 'bbox', more: ids.length - 1 };
  }
  return { id: ids[0], how: 'first', more: ids.length - 1 };
}

/** "New York (US)", "Prince Edward Island" (tag dropped to fit), "Delaware (US) + 8 more" (last resort), "Map area 6/18/24" (no source). */
export function packLabel(cell: LabelCell, table: PackRegionTable = REGIONS): string {
  const p = pickRegion(cell, table);
  if (!p) return `Map area ${cell.cell}`;
  const { name, cc } = regionName(p.id, table);
  const tail = p.how === 'first' && p.more ? ` + ${p.more} more` : '';
  const tagged = cc ? `${name} (${cc})${tail}` : `${name}${tail}`;
  return (LABEL_PREFIX + tagged).length <= MAX_LINE_CHARS ? tagged : `${name}${tail}`;
}

/** The Data row's title: "Streets near New York (US)". */
export const packTitle = (cell: LabelCell, table: PackRegionTable = REGIONS): string => LABEL_PREFIX + packLabel(cell, table);
