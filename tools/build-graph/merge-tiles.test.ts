/**
 * Border merge on the Williamsburg fixture split into two "extracts": every way with a node west
 * of the median longitude (complete) and every way with a node east of it (complete), the way
 * Geofabrik keeps border-crossing ways whole in both neighbours.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadOverpassWays } from '../../tests/fixtures/routing/overpass-to-tiles';
import { NodeFlag, packGraphTile, type GraphTileInput } from '../../src/routing/graph-format';
import { buildGraphTiles } from '../../src/routing/graph-build';
import type { OsmWay } from '../../src/routing/osm-types';
import { borderTiles, dedupeWays, parseTileKey, partitionWays, planBorders, rebuildCell, ring, tileKey, wayCells, wayTileIndex } from './merge-tiles';

const FIXTURE = fileURLToPath(new URL('../../tests/fixtures/osm/williamsburg.json.gz', import.meta.url));

function loadWays(): OsmWay[] {
  return loadOverpassWays(FIXTURE).map((w) => ({ id: w.id, tags: w.tags, refs: w.nodes, coords: w.geometry.map((p) => [p.lon, p.lat] as [number, number]) }));
}

/** Directed arcs of a tile as "fromId>toId:way" (what a naive tile-level union would merge on). */
function arcSet(t: GraphTileInput): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < t.nodeId.length; i++) {
    if (t.nodeFlags[i] & NodeFlag.FOREIGN) continue;
    for (let a = t.arcStart[i]; a < t.arcStart[i + 1]; a++) out.add(`${t.nodeId[i]}>${t.nodeId[t.arcTo[a]]}:${t.arcWay[a]}`);
  }
  return out;
}

const packedMap = (tiles: Map<string, GraphTileInput>) => new Map([...tiles].map(([k, t]) => [k, Buffer.from(packGraphTile(t))]));

describe('ring / borderTiles / wayCells', () => {
  it('ring dilates by Chebyshev distance and clamps to the grid', () => {
    expect([...ring(['0/0'], 1, 12)].sort()).toEqual(['0/0', '0/1', '1/0', '1/1']);
    expect(ring(['5/5'], 2, 12).size).toBe(25);
    expect(ring(['4095/4095'], 1, 12).size).toBe(4);
  });
  it('borderTiles = tiles emitted by ≥ 2 extracts', () => {
    const b = borderTiles([{ id: 'a', tiles: [[1, 1, 0], [2, 1, 0]] }, { id: 'b', tiles: [[2, 1, 0], [3, 1, 0]] }, { id: 'c', tiles: [[3, 1, 0]] }]);
    expect([...b].sort()).toEqual(['2/1', '3/1']);
  });
  it('wayCells lists every cell whose wayTiles contain a node of the way', () => {
    const plan = planBorders([{ id: 'a', tiles: [[100, 100, 0]] }, { id: 'b', tiles: [[100, 100, 0]] }], { zoom: 12, packZoom: 6 });
    const idx = wayTileIndex(plan);
    const cellOfTile = (k: string) => { const [x, y] = parseTileKey(k); return `6/${x >> 6}/${y >> 6}`; };
    expect(Object.keys(plan.cells)).toEqual([cellOfTile('100/100')]);
    // a node inside tile 100/100 (its centre) belongs to the cell; a node far away does not
    const inside: [number, number] = [(100.5 / 4096) * 360 - 180, 0];
    const lat = (y: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 4096));
    inside[1] = (lat(100) + lat(101)) / 2;
    expect(wayCells({ coords: [inside] }, idx, 12)).toEqual([cellOfTile('100/100')]);
    expect(wayCells({ coords: [[0, 0]] }, idx, 12)).toEqual([]);
  });
});

describe.each([12, 15])('Williamsburg split into two complete-way halves at z%i', (zoom) => {
  const ways = loadWays();
  const lons = ways.flatMap((w) => w.coords.map((c) => c[0])).sort((a, b) => a - b);
  const lon0 = lons[lons.length >> 1];
  const west = ways.filter((w) => w.coords.some((c) => c[0] < lon0));
  const east = ways.filter((w) => w.coords.some((c) => c[0] >= lon0));
  const full = buildGraphTiles(ways, { zoom });
  const wb = buildGraphTiles(west, { zoom });
  const eb = buildGraphTiles(east, { zoom });
  const fullPacked = packedMap(full.tiles);
  const extracts = [
    { id: 'west', tiles: [...wb.tiles.values()].map((t) => [t.tx, t.ty, 0] as [number, number, number]) },
    { id: 'east', tiles: [...eb.tiles.values()].map((t) => [t.tx, t.ty, 0] as [number, number, number]) },
  ];
  const B = borderTiles(extracts);

  it('the halves overlap (crossing ways are complete in both) and their border tiles are NOT the full build', () => {
    expect(west.length + east.length).toBeGreaterThan(ways.length); // shared crossing ways
    expect(B.size).toBeGreaterThan(0);
    let differing = 0;
    for (const k of B) {
      const f = fullPacked.get(k)!;
      expect(f).toBeDefined();
      if (!Buffer.from(packGraphTile(wb.tiles.get(k)!)).equals(f) || !Buffer.from(packGraphTile(eb.tiles.get(k)!)).equals(f)) differing++;
    }
    expect(differing).toBeGreaterThan(0);
  });

  it('a naive union of the two tile sets keeps arcs that skip junctions only the other half knows', () => {
    let extra = 0, missing = 0;
    for (const k of B) {
      const truth = arcSet(full.tiles.get(k)!);
      const union = new Set([...arcSet(wb.tiles.get(k)!), ...arcSet(eb.tiles.get(k)!)]);
      for (const a of union) if (!truth.has(a)) extra++;
      for (const a of truth) if (!union.has(a)) missing++;
    }
    expect(extra + missing).toBeGreaterThan(0);
  });

  it('rebuilding ring1(B) from the way union reproduces the full build byte for byte', () => {
    const plan = planBorders(extracts, { zoom, packZoom: zoom - 6 });
    const partsW = partitionWays(west, plan), partsE = partitionWays(east, plan);
    const final = new Map<string, Buffer>();
    for (const t of wb.tiles.values()) final.set(tileKey(t.tx, t.ty), Buffer.from(packGraphTile(t)));
    for (const t of eb.tiles.values()) final.set(tileKey(t.tx, t.ty), Buffer.from(packGraphTile(t)));
    let rebuilt = 0;
    for (const [ck, cell] of Object.entries(plan.cells)) {
      expect(cell.extracts).toEqual(['east', 'west']);
      const unionWays = dedupeWays([partsW.get(ck) ?? [], partsE.get(ck) ?? []]);
      const r = rebuildCell(cell, unionWays, zoom);
      for (const [k, t] of r.tiles) {
        expect(Buffer.from(packGraphTile(t)).equals(fullPacked.get(k)!), `rebuilt ${k} ≠ full build`).toBe(true);
        final.set(k, Buffer.from(packGraphTile(t)));
        rebuilt++;
      }
      for (const k of r.empty) expect(fullPacked.has(k), `${k} empty in the rebuild but present in the full build`).toBe(false);
    }
    expect(rebuilt).toBeGreaterThanOrEqual(B.size);
    // Override the per-half tiles with the rebuilt ones: the whole set now equals the full build.
    expect([...final.keys()].sort()).toEqual([...fullPacked.keys()].sort());
    for (const [k, bytes] of final) expect(bytes.equals(fullPacked.get(k)!), `tile ${k} differs after the merge`).toBe(true);
  });
});
