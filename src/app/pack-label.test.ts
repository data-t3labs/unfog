/**
 * Data → Routing data labels (pack-label.ts) against the real build-time table
 * (src/routing/pack-regions.json) and synthetic ones: one region per cell, one line.
 */
import { describe, expect, it } from 'vitest';
import { lonLatToGraphTile } from '../routing/graph-format';
import { LABEL_GRID_ZOOM, type PackRegionTable } from '../routing/pack-format';
import { LABEL_PREFIX, MAX_LINE_CHARS, REGIONS, packLabel, packTitle, pickRegion, regionName, sourceRegions } from './pack-label';

/** The real NYC cell's source line (packs-index.json, 2026-09-02 build): nine extracts. */
const NYC_SOURCE = 'Geofabrik us/delaware, us/district-of-columbia, us/maryland, us/new-jersey, us/new-york, us/north-carolina, us/pennsylvania, us/virginia, us/west-virginia (+ border merge)';
const now = 1_757_000_000_000;

/** A 5×5 z12 ring around a lon/lat, grouped by z10 sub-cell like PackSource.status() does. */
function ringSub(lon: number, lat: number): Array<[number, number, number, number]> {
  const [cx, cy] = lonLatToGraphTile(lon, lat);
  const shift = 12 - LABEL_GRID_ZOOM;
  const m = new Map<string, [number, number, number, number]>();
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = (cx + dx) >> shift, y = (cy + dy) >> shift, k = `${x}/${y}`;
    const s = m.get(k);
    if (s) s[2]++; else m.set(k, [x, y, 1, now]);
  }
  return [...m.values()];
}

describe('sourceRegions', () => {
  it('reads the extract ids out of every source wording the index has used', () => {
    expect(sourceRegions('Geofabrik us/new-york')).toEqual(['us/new-york']);
    expect(sourceRegions('Geofabrik us/new-york 2026-09-02')).toEqual(['us/new-york']);
    expect(sourceRegions('Geofabrik us/washington 2026-09-01, us/oregon 2026-09-01 (+ border merge)')).toEqual(['us/washington', 'us/oregon']);
    expect(sourceRegions('Geofabrik alberta, british-columbia, us/washington (+ border merge)')).toEqual(['alberta', 'british-columbia', 'us/washington']);
    expect(sourceRegions(NYC_SOURCE)).toHaveLength(9);
    expect(sourceRegions('Geofabrik canada/british-columbia 2026-09-02')).toEqual(['canada/british-columbia']);
    expect(sourceRegions('Geofabrik ontario, ontario, Ontario')).toEqual(['ontario']);
    expect(sourceRegions(undefined)).toEqual([]);
    expect(sourceRegions('')).toEqual([]);
    expect(sourceRegions('BBBike NewYork.osm.pbf 2026-08-29')).toEqual([]);
  });
});

describe('regionName', () => {
  it('uses the table, else derives a name from the id', () => {
    expect(regionName('us/new-york')).toEqual({ name: 'New York', cc: 'US' });
    expect(regionName('british-columbia')).toEqual({ name: 'British Columbia', cc: 'CA' });
    expect(regionName('us/district-of-columbia')).toEqual({ name: 'Washington, DC', cc: 'US' });
    expect(regionName('canada/british-columbia')).toEqual({ name: 'British Columbia', cc: 'Canada' });
    expect(regionName('somewhere-new')).toEqual({ name: 'Somewhere New', cc: '' });
  });
});

describe('pickRegion / packLabel on the real table', () => {
  it('the NYC cell: a ring around Bedford & N 7th is New York, not the first of nine extracts', () => {
    const cell = { cell: '6/18/24', source: NYC_SOURCE, sub: ringSub(-73.9568, 40.7176) };
    expect(pickRegion(cell)).toEqual({ id: 'us/new-york', how: 'grid', more: 8 });
    expect(packLabel(cell)).toBe('New York (US)');
    expect(packTitle(cell)).toBe('Streets near New York (US)');
  });

  it('the same cell cached from Philadelphia or Baltimore names those states; Vancouver and Seattle their own', () => {
    expect(packLabel({ cell: '6/18/24', source: NYC_SOURCE, sub: ringSub(-75.16, 39.95) })).toBe('Pennsylvania (US)');
    expect(packLabel({ cell: '6/18/24', source: NYC_SOURCE, sub: ringSub(-76.61, 39.29) })).toBe('Maryland (US)');
    const van = 'Geofabrik alberta, british-columbia, us/washington (+ border merge)';
    expect(packLabel({ cell: '6/10/21', source: van, sub: ringSub(-123.1207, 49.2827) })).toBe('British Columbia (CA)');
    const sea = 'Geofabrik british-columbia, us/oregon, us/washington (+ border merge)';
    expect(packLabel({ cell: '6/10/22', source: sea, sub: ringSub(-122.3321, 47.6062) })).toBe('Washington (US)');
  });

  it('a single-extract source needs no table; a bare Canadian id is no longer dropped; no source → the cell key', () => {
    expect(packLabel({ cell: '6/19/24', source: 'Geofabrik us/new-york' })).toBe('New York (US)');
    expect(packLabel({ cell: '6/18/24', source: 'Geofabrik us/new-york 2026-09-02' })).toBe('New York (US)'); // the e2e fake index wording
    expect(packLabel({ cell: '6/10/20', source: 'Geofabrik british-columbia' })).toBe('British Columbia (CA)');
    expect(packLabel({ cell: '6/10/21', source: 'Geofabrik canada/british-columbia 2026-09-02' })).toBe('British Columbia'); // "(Canada)" would not fit
    expect(packLabel({ cell: '6/1/2' })).toBe('Map area 6/1/2');
    expect(packLabel({ cell: '6/1/2', source: 'BBBike NewYork.osm.pbf 2026-08-29' })).toBe('Map area 6/1/2');
  });

  it('every region in the table fits the row in one line; long names drop the country tag', () => {
    for (const id of Object.keys(REGIONS.regions)) {
      const title = packTitle({ cell: '6/0/0', source: `Geofabrik ${id}` });
      expect(title.length, title).toBeLessThanOrEqual(MAX_LINE_CHARS);
      expect(title.startsWith(LABEL_PREFIX)).toBe(true);
    }
    expect(packLabel({ cell: '6/0/0', source: 'Geofabrik prince-edward-island' })).toBe('Prince Edward Island');
    expect(packLabel({ cell: '6/0/0', source: 'Geofabrik newfoundland-and-labrador' })).toBe('Newfoundland & Labrador');
    expect(packLabel({ cell: '6/0/0', source: 'Geofabrik us/district-of-columbia' })).toBe('Washington, DC (US)');
    expect(packLabel({ cell: '6/0/0', source: 'Geofabrik us/us-virgin-islands' })).toBe('Virgin Islands (US)');
  });
});

describe('pickRegion fallbacks (synthetic table)', () => {
  const table: PackRegionTable = {
    version: 1, zoom: 12, packZoom: 6, gridZoom: 10, builtAt: 'test',
    regions: {
      'us/aa': { name: 'Aa', cc: 'US', bbox: [-79, 36, -73, 42] },
      'us/bb': { name: 'Bb', cc: 'US', bbox: [-75, 38, -73, 41] },
      'us/cc': { name: 'Cc', cc: 'US', bbox: [-100, 30, -90, 35] },
    },
    // Cell 6/18/24: left half Aa, right half Bb, row 0 empty.
    cells: { '6/18/24': { regions: ['us/aa', 'us/bb'], grid: '.'.repeat(16) + ('0'.repeat(8) + '1'.repeat(8)).repeat(15) } },
  };
  const src = 'Geofabrik us/aa, us/bb, us/cc (+ border merge)';

  it('votes by cached tiles, then by the most recently used sub-cell, then alphabetically; empty grid cells do not vote', () => {
    // z10 (288+ix, 384+iy)
    expect(pickRegion({ cell: '6/18/24', source: src, sub: [[290, 385, 3, 1], [300, 385, 5, 1]] }, table)).toEqual({ id: 'us/bb', how: 'grid', more: 2 });
    expect(pickRegion({ cell: '6/18/24', source: src, sub: [[290, 385, 4, 9], [300, 385, 4, 1]] }, table)).toEqual({ id: 'us/aa', how: 'grid', more: 2 });
    expect(pickRegion({ cell: '6/18/24', source: src, sub: [[290, 385, 4, 5], [300, 385, 4, 5]] }, table)).toEqual({ id: 'us/aa', how: 'grid', more: 2 });
    expect(pickRegion({ cell: '6/18/24', source: src, sub: [[290, 384, 9, 5], [300, 385, 1, 5]] }, table)).toEqual({ id: 'us/bb', how: 'grid', more: 2 });
    expect(packLabel({ cell: '6/18/24', source: src, sub: [[300, 385, 1, 5]] }, table)).toBe('Bb (US)');
  });

  it('a cell the table does not know: the listed bbox holding the cached tiles deepest inside; none → the first region + N more', () => {
    // Cell 6/18/23 is not in the table. z10 (300, 380) ≈ lon −74.4, lat 41.9: only Aa's bbox holds it (Bb stops at 41).
    expect(pickRegion({ cell: '6/18/23', source: src, sub: [[300, 380, 2, 1]] }, table)).toEqual({ id: 'us/aa', how: 'bbox', more: 2 });
    // z10 (298, 384) ≈ lon −75.1, lat 40.9: just west of Bb's bbox, 1.15° inside Aa's → Aa.
    expect(pickRegion({ cell: '6/18/23', source: src, sub: [[298, 384, 2, 1]] }, table)?.id).toBe('us/aa');
    // Cached tiles far from every listed bbox (the Pacific): first region + 2 more.
    expect(pickRegion({ cell: '6/2/23', source: src, sub: [[40, 380, 2, 1]] }, table)).toEqual({ id: 'us/aa', how: 'first', more: 2 });
    expect(packLabel({ cell: '6/2/23', source: src, sub: [[40, 380, 2, 1]] }, table)).toBe('Aa (US) + 2 more');
    // No cached sub-cells at all (an older worker): first region.
    expect(pickRegion({ cell: '6/18/24', source: src }, table)).toEqual({ id: 'us/aa', how: 'first', more: 2 });
  });

  it('a table built at another grid zoom is ignored (falls back), never misread', () => {
    const other = { ...table, gridZoom: 9 };
    expect(pickRegion({ cell: '6/18/24', source: src, sub: [[300, 385, 5, 1]] }, other)?.how).not.toBe('grid');
  });
});
