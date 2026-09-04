import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeLattice } from '../../tests/fixtures/routing/lattice';
import { packGraphTile, unpackGraphTile } from '../../src/routing/graph-format';
import { PACKS_INDEX_NAME, parsePackIndex, type PacksIndex } from '../../src/routing/pack-format';
import { writeTiles } from './merge-tiles';
import { groupByCell, packInfoOf, readPacksIndex, tilesFromManifestDir, writePack, writePacksIndex, type TileFile } from './pack-tiles';
import { buildRegionTable, regionCountry, regionDisplayName, serializeRegionTable } from './region-table';

describe('groupByCell', () => {
  it('groups by z6 cell, last duplicate wins, origins are the union', () => {
    const tiles: TileFile[] = [
      { tx: 1206, ty: 1539, file: 'a', origin: 'us/new-york' },
      { tx: 1207, ty: 1539, file: 'b', origin: 'us/new-york' },
      { tx: 1206, ty: 1539, file: 'c', origin: 'merged' },
      { tx: 647, ty: 1402, file: 'd', origin: 'british-columbia' },
    ];
    const groups = groupByCell(tiles);
    expect(groups.map((g) => g.key)).toEqual(['6/10/21', '6/18/24']);
    const ny = groups[1];
    expect(ny.tiles.map((t) => t.file).sort()).toEqual(['b', 'c']);
    expect(ny.origins).toEqual(['merged', 'us/new-york']);
    expect(groups[0].origins).toEqual(['british-columbia']);
  });
});

describe('writePack / packs-index', () => {
  it('writes a pack whose index addresses every tile and a packs-index.json that round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unfog-pack-'));
    const lattice = makeLattice({ size: 30, spacingM: 400 }); // straddles 2×2 z12 tiles
    const manifest = writeTiles(join(dir, 'region'), lattice.tiles.values(), { id: 'lattice', name: 'Lattice', source: 'test' });
    expect(manifest.tiles.length).toBeGreaterThanOrEqual(4);
    const files = tilesFromManifestDir(join(dir, 'region'), 'lattice');
    const groups = groupByCell(files);
    expect(groups.length).toBe(1);
    const p = writePack(groups[0], join(dir, 'packs'));
    const bytes = new Uint8Array(readFileSync(p.file));
    expect(bytes.length).toBe(p.bytes);
    const index = parsePackIndex(bytes.subarray(0, p.indexBytes));
    expect(index.tileCount).toBe(files.length);
    expect(index.totalBytes).toBe(p.bytes);
    for (const e of index.entries) {
      const f = files.find((t) => t.tx === e.tx && t.ty === e.ty)!;
      expect(f).toBeDefined();
      const original = readFileSync(f.file);
      expect(Buffer.from(bytes.subarray(e.offset, e.offset + e.length)).equals(original)).toBe(true);
      const t = unpackGraphTile(bytes.subarray(e.offset, e.offset + e.length));
      expect([t.tx, t.ty]).toEqual([e.tx, e.ty]);
      expect(Buffer.from(packGraphTile(t)).equals(original)).toBe(true);
    }
    const info = packInfoOf(p, 'https://example.test/dl/', 'Geofabrik test', '2026-09-02T00:00:00Z');
    expect(info.url).toBe('https://example.test/dl/' + p.name);
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    const idx: PacksIndex = { version: 1, zoom: 12, packZoom: 6, builtAt: '2026-09-02T00:00:00Z', release: 'graphs-v1', packs: { [p.key]: info } };
    const f = writePacksIndex(join(dir, 'packs'), idx);
    expect(f.endsWith(PACKS_INDEX_NAME)).toBe(true);
    expect(readPacksIndex(join(dir, 'packs'))).toEqual(idx);
    writeFileSync(f, '{ broken');
    expect(readPacksIndex(join(dir, 'packs'))).toBeNull();
  });
});

describe('buildRegionTable (region-table.ts)', () => {
  it('names and tags extracts; a z10 grid per multi-extract cell picks the extract with the most bytes (ties alphabetical); single-extract cells get no entry', () => {
    // Cell 6/18/24 spans z12 x 1152–1215, y 1536–1599; z10 tile (288,384) = grid position 0.
    const table = buildRegionTable(
      [
        { id: 'us/bb', bbox: [-75, 38, -73, 41], tiles: [[1152, 1536, 150], [1156, 1536], [1300, 1600, 9]] },
        { id: 'us/aa', bbox: [-79, 36, -73, 42], tiles: [[1152, 1536, 100], [1153, 1536, 100], [1200, 1590, 5], [1160, 1540, 7]] },
        { id: 'ontario', bbox: [-95, 41, -74, 56], tiles: [[1160, 1540, 7]] },
      ],
      { builtAt: '2026-09-04T00:00:00Z' },
    );
    expect(table).toMatchObject({ version: 1, zoom: 12, packZoom: 6, gridZoom: 10, builtAt: '2026-09-04T00:00:00Z' });
    expect(Object.keys(table.regions)).toEqual(['ontario', 'us/aa', 'us/bb']);
    expect(table.regions['us/aa']).toEqual({ name: 'Aa', cc: 'US', bbox: [-79, 36, -73, 42] });
    expect(table.regions.ontario).toEqual({ name: 'Ontario', cc: 'CA', bbox: [-95, 41, -74, 56] });
    expect(Object.keys(table.cells)).toEqual(['6/18/24']); // 1300/1600 is alone in its cell → no grid
    const c = table.cells['6/18/24'];
    expect(c.regions).toEqual(['ontario', 'us/aa', 'us/bb']);
    expect(c.grid.length).toBe(256);
    expect(c.grid[0]).toBe('1'); // us/aa 200 B > us/bb 150 B
    expect(c.grid[1]).toBe('2'); // us/bb alone (no bytes → weight 1)
    expect(c.grid[13 * 16 + 12]).toBe('1'); // 1200/1590 → z10 (300,397) → (12,13)
    expect(c.grid[1 * 16 + 2]).toBe('0'); // 1160/1540 → (290,385) → (2,1): 7 B each → alphabetical → ontario
    expect((c.grid.match(/\./g) ?? []).length).toBe(252);
    // Round trip through the compact serializer.
    expect(JSON.parse(serializeRegionTable(table))).toEqual(table);
    // Deterministic: input order does not matter.
    const again = buildRegionTable(
      [
        { id: 'ontario', bbox: [-95, 41, -74, 56], tiles: [[1160, 1540, 7]] },
        { id: 'us/aa', bbox: [-79, 36, -73, 42], tiles: [[1160, 1540, 7], [1200, 1590, 5], [1153, 1536, 100], [1152, 1536, 100]] },
        { id: 'us/bb', bbox: [-75, 38, -73, 41], tiles: [[1300, 1600, 9], [1156, 1536], [1152, 1536, 150]] },
      ],
      { builtAt: '2026-09-04T00:00:00Z' },
    );
    expect(serializeRegionTable(again)).toBe(serializeRegionTable(table));
    expect(() => buildRegionTable([{ id: 'x', bbox: [0, 0, 1, 1], tiles: [] }, { id: 'x', bbox: [0, 0, 1, 1], tiles: [] }])).toThrow(/duplicate/);
  });

  it('display names: title case with small words, overrides for the awkward ones; country tags per Geofabrik naming', () => {
    expect(regionDisplayName('us/new-york')).toBe('New York');
    expect(regionDisplayName('prince-edward-island')).toBe('Prince Edward Island');
    expect(regionDisplayName('us/district-of-columbia')).toBe('Washington, DC');
    expect(regionDisplayName('newfoundland-and-labrador')).toBe('Newfoundland & Labrador');
    expect(regionDisplayName('us/us-virgin-islands')).toBe('Virgin Islands');
    expect(regionCountry('us/new-york')).toBe('US');
    expect(regionCountry('british-columbia')).toBe('CA');
    expect(regionCountry('mexico')).toBe('MX');
    expect(regionCountry('greenland')).toBe('GL');
    expect(regionCountry('elsewhere')).toBe('');
  });
});
