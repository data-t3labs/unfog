import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeLattice } from '../../tests/fixtures/routing/lattice';
import { packGraphTile, unpackGraphTile } from '../../src/routing/graph-format';
import { PACKS_INDEX_NAME, parsePackIndex, type PacksIndex } from '../../src/routing/pack-format';
import { writeTiles } from './merge-tiles';
import { groupByCell, packInfoOf, readPacksIndex, tilesFromManifestDir, writePack, writePacksIndex, type TileFile } from './pack-tiles';

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
