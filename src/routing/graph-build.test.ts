import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { distanceM } from '../grid/cell';
import { buildGraphTiles, lowerBound, wayFlags } from './graph-build';
import { ArcFlag, NodeFlag, encodeGraphTile, graphTileBounds, lonLatToGraphTile, type GraphTileInput } from './graph-format';
import { classifyWay } from './osm-rules';
import type { OsmWay } from './osm-types';
import { parseOverpassJson } from './overpass';

const FIXTURE = new URL('../../tests/fixtures/osm/williamsburg.json.gz', import.meta.url);
const williamsburg = (): OsmWay[] => parseOverpassJson(gunzipSync(readFileSync(FIXTURE)).toString('utf8'));

/** Straight way along a parallel of latitude starting at (lon0, lat) with `n` nodes `stepDeg` apart. */
function way(id: number, tags: Record<string, string>, ids: number[], lon0: number, lat: number, stepDeg = 0.001): OsmWay {
  return { id, tags, refs: ids, coords: ids.map((_, i) => [lon0 + i * stepDeg, lat] as [number, number]) };
}

const bits = (f: number) => ({ walk: !!(f & ArcFlag.WALK), bike: !!(f & ArcFlag.BIKE), drive: !!(f & ArcFlag.DRIVE), rev: !!(f & ArcFlag.REVERSED), steps: !!(f & ArcFlag.STEPS), dismount: !!(f & ArcFlag.DISMOUNT) });

/** Flatten a result into global arcs keyed by OSM ids. */
function arcsOf(tiles: Map<string, GraphTileInput>) {
  const out: Array<{ tile: string; from: number; to: number; len: number; flags: number; way: number; shape: number }> = [];
  for (const [tile, t] of tiles) {
    for (let i = 0; i < t.nodeId.length; i++) {
      for (let a = t.arcStart[i]; a < t.arcStart[i + 1]; a++) {
        out.push({ tile, from: t.nodeId[i], to: t.nodeId[t.arcTo[a]], len: t.arcLen[a], flags: t.arcFlags[a], way: t.arcWay[a], shape: t.arcShapeEnd[a] - t.arcShapeStart[a] });
      }
    }
  }
  return out;
}

describe('wayFlags', () => {
  const base = { keep: true, walk: true, bike: true, drive: true, steps: false, dismount: false, onewayFwd: false, onewayBack: false, bikeBothWays: false };
  it('two-way street: both directions get every mode', () => {
    const [f, r] = wayFlags(base);
    expect(bits(f)).toMatchObject({ walk: true, bike: true, drive: true });
    expect(bits(r)).toMatchObject({ walk: true, bike: true, drive: true });
  });
  it('oneway=yes: reverse keeps only walk; oneway:bicycle=no restores bike', () => {
    const [f, r] = wayFlags({ ...base, onewayFwd: true });
    expect(bits(f)).toMatchObject({ walk: true, bike: true, drive: true });
    expect(bits(r)).toMatchObject({ walk: true, bike: false, drive: false });
    const [, r2] = wayFlags({ ...base, onewayFwd: true, bikeBothWays: true });
    expect(bits(r2)).toMatchObject({ walk: true, bike: true, drive: false });
  });
  it('oneway=-1: forward loses vehicles', () => {
    const [f, r] = wayFlags({ ...base, onewayBack: true });
    expect(bits(f)).toMatchObject({ walk: true, bike: false, drive: false });
    expect(bits(r)).toMatchObject({ walk: true, bike: true, drive: true });
  });
  it('steps + dismount copied to both directions', () => {
    const [f, r] = wayFlags({ ...base, drive: false, steps: true, dismount: true });
    expect(bits(f)).toMatchObject({ steps: true, dismount: true, drive: false });
    expect(bits(r)).toMatchObject({ steps: true, dismount: true, drive: false });
  });
});

describe('lowerBound', () => {
  it('finds exact positions in a sorted Float64Array', () => {
    const a = Float64Array.from([1, 3, 3, 7, 1e10 + 5]);
    expect(lowerBound(a, 1)).toBe(0); expect(lowerBound(a, 3)).toBe(1); expect(lowerBound(a, 7)).toBe(3);
    expect(lowerBound(a, 1e10 + 5)).toBe(4); expect(lowerBound(a, 4)).toBe(3); expect(lowerBound(a, 1e11)).toBe(5);
  });
});

describe('buildGraphTiles — synthetic topology', () => {
  it('a lone two-way street becomes one segment with two arcs, pass-through nodes as shape', () => {
    const r = buildGraphTiles([way(1, { highway: 'residential' }, [10, 11, 12, 13], -73.95, 40.72)]);
    expect(r.stats).toMatchObject({ ways: 1, nodes: 2, arcs: 2 });
    expect(r.tiles.size).toBe(1);
    const t = [...r.tiles.values()][0];
    expect(Array.from(t.nodeId)).toEqual([10, 13]);
    expect(Array.from(t.nodeFlags)).toEqual([0, 0]);
    expect(Array.from(t.arcStart)).toEqual([0, 1, 2]);
    expect(Array.from(t.arcTo)).toEqual([1, 0]);
    expect(t.shapeLon.length).toBe(2);
    expect(Array.from(t.arcShapeStart)).toEqual([0, 0]); expect(Array.from(t.arcShapeEnd)).toEqual([2, 2]);
    expect(bits(t.arcFlags[0]).rev).toBe(false); expect(bits(t.arcFlags[1]).rev).toBe(true);
    const expectM = 3 * distanceM(-73.95, 40.72, -73.949, 40.72);
    expect(t.arcLen[0]).toBe(Math.round(expectM)); expect(t.arcLen[1]).toBe(Math.round(expectM));
    expect(r.stats.km).toBeCloseTo(expectM / 1000, 6);
  });

  it('a junction node shared by two ways splits the street', () => {
    const r = buildGraphTiles([
      way(1, { highway: 'residential' }, [10, 11, 12, 13, 14], -73.95, 40.72),
      way(2, { highway: 'residential' }, [20, 12, 21], -73.948, 40.719, 0), // crosses at node 12
    ].map((w) => (w.id === 2 ? { ...w, coords: [[-73.948, 40.719], [-73.948, 40.72], [-73.948, 40.721]] as [number, number][] } : w)));
    expect(r.stats.nodes).toBe(5); // 10, 14, 12, 20, 21
    expect(r.stats.arcs).toBe(8); // 4 segments
    const t = [...r.tiles.values()][0];
    expect(Array.from(t.nodeId)).toEqual([10, 12, 14, 20, 21]); // sorted by id
    expect(t.nodeId).not.toContain(11); expect(t.nodeId).not.toContain(13);
  });

  it('oneway street: forward carries bike+drive, reverse only walk (+REVERSED); walk mask symmetric', () => {
    const r = buildGraphTiles([way(1, { highway: 'primary', oneway: 'yes' }, [1, 2, 3], -73.95, 40.72)]);
    const arcs = arcsOf(r.tiles);
    const fwd = arcs.find((a) => a.from === 1 && a.to === 3)!, rev = arcs.find((a) => a.from === 3 && a.to === 1)!;
    expect(bits(fwd.flags)).toMatchObject({ walk: true, bike: true, drive: true, rev: false });
    expect(bits(rev.flags)).toMatchObject({ walk: true, bike: false, drive: false, rev: true });
    expect(fwd.len).toBe(rev.len);
  });

  it('oneway=-1 flips which direction vehicles may use', () => {
    const arcs = arcsOf(buildGraphTiles([way(1, { highway: 'residential', oneway: '-1' }, [1, 2], -73.95, 40.72)]).tiles);
    expect(bits(arcs.find((a) => a.from === 1)!.flags)).toMatchObject({ drive: false, bike: false, walk: true });
    expect(bits(arcs.find((a) => a.from === 2)!.flags)).toMatchObject({ drive: true, bike: true, walk: true });
  });

  it('drops dropped ways and ways with < 2 usable points; drops NaN / undefined coordinates', () => {
    const ways: OsmWay[] = [
      way(1, { highway: 'footway', footway: 'sidewalk' }, [1, 2], -73.95, 40.72),
      { id: 2, tags: { highway: 'residential' }, refs: [3, 4, 5, 6], coords: [[-73.95, 40.72], [NaN, 40.72], undefined as unknown as [number, number], [-73.947, 40.72]] },
      { id: 3, tags: { highway: 'residential' }, refs: [7, 8], coords: [[-73.95, 40.73], [NaN, NaN]] },
    ];
    const r = buildGraphTiles(ways);
    expect(r.stats).toMatchObject({ ways: 1, nodes: 2, arcs: 2 });
    const t = [...r.tiles.values()][0];
    expect(Array.from(t.nodeId)).toEqual([3, 6]);
    expect(t.shapeLon.length).toBe(0);
  });

  it('collapses consecutive duplicate refs instead of creating a zero-length junction', () => {
    const r = buildGraphTiles([{ id: 1, tags: { highway: 'residential' }, refs: [1, 2, 2, 3], coords: [[-73.95, 40.72], [-73.949, 40.72], [-73.949, 40.72], [-73.948, 40.72]] }]);
    expect(r.stats).toMatchObject({ nodes: 2, arcs: 2 });
  });

  it('a closed loop way: the shared end node is a graph node with a self-loop segment', () => {
    const ring: OsmWay = { id: 9, tags: { highway: 'residential' }, refs: [1, 2, 3, 4, 1], coords: [[-73.95, 40.72], [-73.949, 40.72], [-73.949, 40.721], [-73.95, 40.721], [-73.95, 40.72]] };
    const r = buildGraphTiles([ring]);
    expect(r.stats).toMatchObject({ nodes: 1, arcs: 2 });
    const t = [...r.tiles.values()][0];
    expect(Array.from(t.arcTo)).toEqual([0, 0]);
    expect(t.shapeLon.length).toBe(3);
    expect(t.arcLen[0]).toBeGreaterThan(300);
  });

  it('a node used twice inside one way (figure-8) becomes a graph node', () => {
    const w: OsmWay = { id: 9, tags: { highway: 'path' }, refs: [1, 2, 3, 2, 4], coords: [[-73.95, 40.72], [-73.949, 40.72], [-73.949, 40.721], [-73.949, 40.72], [-73.948, 40.72]] };
    const r = buildGraphTiles([w]);
    expect(r.stats.nodes).toBe(3); // 1, 2, 4
    expect(r.stats.arcs).toBe(6); // 1-2, 2-3-2 (loop), 2-4
  });

  it('caps arcLen at 65535 but keeps the true length in stats.km', () => {
    // 200 km straight along the equator in 2 nodes (no junctions)
    const r = buildGraphTiles([{ id: 1, tags: { highway: 'primary' }, refs: [1, 2], coords: [[0, 0], [1.8, 0]] }]);
    const t = [...r.tiles.values()][0];
    expect(t.arcLen[0]).toBe(65535);
    expect(r.stats.km).toBeGreaterThan(190);
  });

  it('tiles by the from-node; the far endpoint is FOREIGN in each other tile', () => {
    // A way crossing a z12 tile boundary in x: −73.95 ↔ −73.90 straddles the tile edge at −73.916.
    const r = buildGraphTiles([way(1, { highway: 'residential' }, [1, 2, 3], -73.93, 40.72, 0.02)]);
    expect(r.tiles.size).toBe(2);
    const [tA, tB] = [...r.tiles.values()];
    for (const t of [tA, tB]) {
      expect(t.nodeId.length).toBe(2);
      const foreign = Array.from(t.nodeFlags).filter((f) => f & NodeFlag.FOREIGN).length;
      expect(foreign).toBe(1);
      expect(t.arcTo.length).toBe(1);
      const local = Array.from(t.nodeFlags).indexOf(0);
      expect(t.arcStart[local + 1] - t.arcStart[local]).toBe(1);
      // the foreign node has no arcs
      const fi = Array.from(t.nodeFlags).indexOf(NodeFlag.FOREIGN);
      expect(t.arcStart[fi + 1] - t.arcStart[fi]).toBe(0);
    }
    // both tiles carry the shape once
    expect(tA.shapeLon.length).toBe(1); expect(tB.shapeLon.length).toBe(1);
  });

  it('is deterministic regardless of input order', () => {
    const ways = williamsburg();
    const a = buildGraphTiles(ways);
    const b = buildGraphTiles([...ways].reverse());
    expect([...a.tiles.keys()]).toEqual([...b.tiles.keys()]);
    for (const k of a.tiles.keys()) expect(encodeGraphTile(a.tiles.get(k)!)).toEqual(encodeGraphTile(b.tiles.get(k)!));
  });

  it('accepts a generator (single pass over the input)', () => {
    function* gen() { yield way(1, { highway: 'residential' }, [1, 2], -73.95, 40.72); }
    expect(buildGraphTiles(gen()).stats.arcs).toBe(2);
  });
});

describe('buildGraphTiles — Williamsburg fixture', () => {
  const ways = williamsburg();
  const kept = ways.filter((w) => classifyWay(w.tags).keep);
  const r = buildGraphTiles(ways);
  const arcs = arcsOf(r.tiles);

  it('keeps a plausible subset and reports stats', () => {
    expect(ways.length).toBe(1760);
    expect(kept.length).toBeGreaterThan(800);
    expect(r.stats.ways).toBe(kept.length);
    expect(r.stats.arcs).toBe(arcs.length);
    expect(r.stats.nodes).toBeGreaterThan(1000);
    expect(r.stats.km).toBeGreaterThan(50);
  });

  it('every arc has a reverse twin with REVERSED flipped, equal length, same way, symmetric walk mask', () => {
    const key = (a: { from: number; to: number; way: number; len: number; shape: number }) => `${a.from}>${a.to}|${a.way}|${a.len}|${a.shape}`;
    const byKey = new Map<string, number[]>();
    for (const a of arcs) { const k = key(a); (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(a.flags); }
    for (const a of arcs) {
      const twins = byKey.get(key({ from: a.to, to: a.from, way: a.way, len: a.len, shape: a.shape }));
      expect(twins, `twin of ${key(a)}`).toBeDefined();
      const rev = !!(a.flags & ArcFlag.REVERSED);
      const twin = twins!.find((f) => !!(f & ArcFlag.REVERSED) === !rev);
      expect(twin, `reverse twin of ${key(a)}`).toBeDefined();
      expect(twin! & ArcFlag.WALK).toBe(a.flags & ArcFlag.WALK);
      expect(twin! & ArcFlag.STEPS).toBe(a.flags & ArcFlag.STEPS);
      expect(twin! & ArcFlag.DISMOUNT).toBe(a.flags & ArcFlag.DISMOUNT);
    }
  });

  it('arc lengths are ≤ 65535 and > 0 except for degenerate geometry', () => {
    for (const a of arcs) { expect(a.len).toBeLessThanOrEqual(65535); }
    expect(arcs.filter((a) => a.len === 0).length).toBeLessThan(arcs.length / 100);
  });

  it('local nodes lie inside their tile; foreign nodes lie outside and are targeted by an arc', () => {
    for (const [k, t] of r.tiles) {
      const [tx, ty] = k.split('/').map(Number);
      expect([t.tx, t.ty]).toEqual([tx, ty]);
      const b = graphTileBounds(tx, ty);
      const targeted = new Set(Array.from(t.arcTo));
      for (let i = 0; i < t.nodeId.length; i++) {
        const lon = t.nodeLon[i] / 1e7, lat = t.nodeLat[i] / 1e7;
        const [nx, ny] = lonLatToGraphTile(lon, lat);
        if (t.nodeFlags[i] & NodeFlag.FOREIGN) {
          expect([nx, ny]).not.toEqual([tx, ty]);
          expect(targeted.has(i)).toBe(true);
          expect(t.arcStart[i + 1]).toBe(t.arcStart[i]);
        } else {
          expect([nx, ny]).toEqual([tx, ty]);
          expect(lon).toBeGreaterThanOrEqual(b.west - 1e-7); expect(lon).toBeLessThan(b.east + 1e-7);
          expect(t.arcStart[i + 1]).toBeGreaterThan(t.arcStart[i]);
        }
      }
    }
    expect(r.tiles.size).toBeGreaterThanOrEqual(2); // the fixture bbox straddles tiles 1205/1206
  });

  it('degree-2 pass-through nodes are not graph nodes; junctions and endpoints are', () => {
    const refCount = new Map<number, number>();
    for (const w of kept) for (const id of w.refs) refCount.set(id, (refCount.get(id) ?? 0) + 1);
    const graphIds = new Set<number>();
    for (const t of r.tiles.values()) for (const id of Array.from(t.nodeId)) graphIds.add(id);
    let passThrough = 0;
    for (const w of kept) {
      expect(graphIds.has(w.refs[0])).toBe(true);
      expect(graphIds.has(w.refs[w.refs.length - 1])).toBe(true);
      for (let i = 1; i < w.refs.length - 1; i++) {
        if (refCount.get(w.refs[i]) === 1) { expect(graphIds.has(w.refs[i])).toBe(false); passThrough++; }
        else expect(graphIds.has(w.refs[i])).toBe(true);
      }
    }
    expect(passThrough).toBeGreaterThan(100);
    expect(r.stats.nodes).toBe(graphIds.size);
  });

  it('total km within ±5 % of Σ kept-way lengths', () => {
    let m = 0;
    for (const w of kept) for (let i = 1; i < w.coords.length; i++) m += distanceM(w.coords[i - 1][0], w.coords[i - 1][1], w.coords[i][0], w.coords[i][1]);
    expect(Math.abs(r.stats.km - m / 1000) / (m / 1000)).toBeLessThan(0.05);
  });

  it('per-tile CSR is well-formed and encodes', () => {
    for (const t of r.tiles.values()) {
      expect(t.arcStart.length).toBe(t.nodeId.length + 1);
      expect(t.arcStart[t.arcStart.length - 1]).toBe(t.arcTo.length);
      for (let a = 0; a < t.arcTo.length; a++) {
        expect(t.arcTo[a]).toBeLessThan(t.nodeId.length);
        expect(t.arcShapeEnd[a]).toBeLessThanOrEqual(t.shapeLon.length);
        expect(t.arcShapeStart[a]).toBeLessThanOrEqual(t.arcShapeEnd[a]);
      }
      expect(() => encodeGraphTile(t)).not.toThrow();
    }
  });
});
