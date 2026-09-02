import { describe, expect, it } from 'vitest';
import { cellsAlong } from '../grid/cell';
import { ArcFlag, decodeGraphTile, encodeGraphTile } from './graph-format';
import { Graph } from './graph';
import { SpatialIndex } from './spatial';
import { MapCellLookup } from './cells';
import { NoveltyScorer } from './novelty';
import { Searcher, hasImmediateUTurn, MinHeap } from './search';
import { pathCoords, trimGeometry } from './candidates';

// A 100 m square A—B—C—D—A around home (Bedford Av & N 7th). A→B is a oneway street for
// vehicles (B→A is WALK only); C↔D is a stair (WALK|BIKE|DISMOUNT); B↔C has a bend shape point.
const HOME = [-73.9568, 40.7176] as const;
const DLON = 100 / (111_320 * Math.cos((HOME[1] * Math.PI) / 180));
const DLAT = 100 / 110_574;
const A = [HOME[0], HOME[1]], B = [HOME[0] + DLON, HOME[1]], C = [HOME[0] + DLON, HOME[1] - DLAT], D = [HOME[0], HOME[1] - DLAT];
const BEND = [HOME[0] + DLON + DLON * 0.1, HOME[1] - DLAT / 2];
const ALL = ArcFlag.WALK | ArcFlag.BIKE | ArcFlag.DRIVE;
const STAIR = ArcFlag.WALK | ArcFlag.BIKE | ArcFlag.DISMOUNT | ArcFlag.STEPS;
const e7 = (v: number) => Math.round(v * 1e7);

const square = {
  tx: 1206, ty: 1539,
  nodeId: [1, 2, 3, 4],
  nodeLon: [A, B, C, D].map((p) => e7(p[0])),
  nodeLat: [A, B, C, D].map((p) => e7(p[1])),
  nodeFlags: [0, 0, 0, 0],
  // A: A→B, A→D | B: B→A, B→C | C: C→B, C→D | D: D→C, D→A
  arcStart: [0, 2, 4, 6, 8],
  arcTo: [1, 3, 0, 2, 1, 3, 2, 0],
  arcLen: [100, 100, 100, 101, 101, 100, 100, 100],
  arcFlags: [ALL, ALL, ArcFlag.WALK | ArcFlag.REVERSED, ALL, ALL | ArcFlag.REVERSED, STAIR, STAIR | ArcFlag.REVERSED, ALL | ArcFlag.REVERSED],
  arcWay: [10, 40, 10, 20, 20, 30, 30, 40],
  arcShapeStart: [0, 0, 0, 0, 0, 1, 1, 1],
  arcShapeEnd: [0, 0, 0, 1, 1, 1, 1, 1],
  shapeLon: [e7(BEND[0])],
  shapeLat: [e7(BEND[1])],
};
const AB = 0, AD = 1, BA = 2, BC = 3, CB = 4, CD = 5, DC = 6, DA = 7;

function build() {
  const graph = new Graph([decodeGraphTile(encodeGraphTile(square))]);
  const lookup = new MapCellLookup();
  const scorer = new NoveltyScorer(graph, lookup);
  const searcher = new Searcher(graph, scorer);
  const spatial = new SpatialIndex(graph);
  return { graph, lookup, scorer, searcher, spatial };
}

/** Snap descriptor at a fraction along an arc (bypasses the spatial index). */
function snapOn(graph: Graph, arc: number, t: number) {
  const geom = graph.arcGeometry(arc);
  const [lon, lat] = [geom[0][0] + (geom[geom.length - 1][0] - geom[0][0]) * t, geom[0][1] + (geom[geom.length - 1][1] - geom[0][1]) * t];
  return { arc, t, point: [lon, lat] as [number, number], distM: 0 };
}

describe('Graph (single tile)', () => {
  it('merges into CSR with reverse arcs and geometry in travel direction', () => {
    const { graph } = build();
    expect(graph.nodeCount).toBe(4);
    expect(graph.arcCount).toBe(8);
    expect(graph.arcsFrom(1)).toEqual([2, 4]);
    expect(graph.reverseArc(AB)).toBe(BA);
    expect(graph.reverseArc(BA)).toBe(AB);
    expect(graph.reverseArc(BC)).toBe(CB);
    expect(graph.reverseArc(CD)).toBe(DC);
    expect(graph.segmentId(CB)).toBe(BC);
    expect(graph.arcLengthM(BC)).toBe(101);
    const fwd = graph.arcGeometry(BC), rev = graph.arcGeometry(CB);
    expect(fwd.length).toBe(3);
    expect(fwd[1][0]).toBeCloseTo(BEND[0], 7);
    expect(rev[1][0]).toBeCloseTo(BEND[0], 7);
    expect(rev[0][0]).toBeCloseTo(C[0], 7);
    expect(rev[2][0]).toBeCloseTo(B[0], 7);
    expect(graph.nodeLon[0]).toBeCloseTo(A[0], 7);
    expect(graph.nodeLat[2]).toBeCloseTo(C[1], 7);
  });

  it('snaps to the nearest arc for the mode, in either direction of a oneway', () => {
    const { spatial } = build();
    // 5 m north of the midpoint of A—B.
    const p: [number, number] = [A[0] + DLON / 2, A[1] + 5 / 110_574];
    const s = spatial.nearestArc(p[0], p[1], ArcFlag.DRIVE)!;
    expect(s).not.toBeNull();
    expect([AB, BA]).toContain(s.arc);
    expect(s.t).toBeCloseTo(0.5, 2);
    expect(s.distM).toBeCloseTo(5, 0);
    expect(s.point[1]).toBeCloseTo(A[1], 7);
    // Nothing within 300 m of a point 2 km away.
    expect(spatial.nearestArc(A[0] + 20 * DLON, A[1], ArcFlag.WALK)).toBeNull();
    // Only walking can use B→A, but the segment is still snappable for drive (A→B exists).
    expect(spatial.nearestArc(p[0], p[1], ArcFlag.BIKE)).not.toBeNull();
  });

  it('walk ignores the oneway, drive and bike respect it, dismount costs ×1.5 but not in length', () => {
    const { graph, searcher } = build();
    const o = snapOn(graph, AB, 0.9), d = snapOn(graph, AB, 0.1);
    const walk = searcher.run(o, d, { lambda: 0, mode: 'walk' })!;
    expect(walk.lengthM).toBeCloseTo(80, 6);
    expect(Array.from(walk.arcs)).toEqual([BA]);
    expect(walk.startFrac).toBeCloseTo(0.1, 9);
    expect(walk.endFrac).toBeCloseTo(0.9, 9);
    const drive = searcher.run(o, d, { lambda: 0, mode: 'drive' });
    expect(drive).toBeNull(); // C↔D is a stair: no way around for cars
    const bike = searcher.run(o, d, { lambda: 0, mode: 'bike' })!;
    expect(Array.from(bike.arcs)).toEqual([AB, BC, CD, DA, AB]);
    expect(bike.lengthM).toBeCloseTo(10 + 101 + 100 + 100 + 10, 6);
    expect(bike.cost).toBeCloseTo(10 + 101 + 150 + 100 + 10, 6);
    expect(hasImmediateUTurn(graph, bike.arcs)).toBe(false);
    // Forward on the same arc: everyone goes direct.
    const fwd = searcher.run(d, o, { lambda: 0, mode: 'drive' })!;
    expect(Array.from(fwd.arcs)).toEqual([AB]);
    expect(fwd.lengthM).toBeCloseTo(80, 6);
    // Coordinates are trimmed to the snap points.
    const coords = pathCoords(graph, fwd);
    expect(coords[0][0]).toBeCloseTo(A[0] + DLON * 0.1, 6);
    expect(coords[coords.length - 1][0]).toBeCloseTo(A[0] + DLON * 0.9, 6);
  });

  it('never takes the reverse of the arc it arrived by', () => {
    const { graph, searcher } = build();
    // Origin near D on D→A, destination near C on C→B: every mode/λ combination.
    for (const mode of ['walk', 'bike', 'drive'] as const) {
      for (const lambda of [0, 1, 4]) {
        const r = searcher.run(snapOn(graph, DA, 0.2), snapOn(graph, CB, 0.3), { lambda, mode });
        if (r) expect(hasImmediateUTurn(graph, r.arcs)).toBe(false);
      }
    }
  });

  it('scores novelty from the cell lookup with 8-neighbour tolerance', () => {
    const { graph, lookup, scorer } = build();
    expect(scorer.get(AB)).toBe(1);
    // Mark the whole A—B street (cells along it, dilated) → both directions become 0.
    for (const [cx, cy] of cellsAlong([A, B] as Array<[number, number]>, { stepM: 3 })) lookup.mark(cx, cy, 1, 1);
    scorer.invalidate();
    expect(scorer.get(AB)).toBe(0);
    expect(scorer.get(BA)).toBe(0);
    expect(scorer.get(BC)).toBeGreaterThan(0.8); // only the corner at B is within tolerance
    expect(scorer.newMetres(AB)).toBe(0);
  });
});

describe('MinHeap', () => {
  it('pops in (key, value) order and survives growth', () => {
    const h = new MinHeap(2);
    const items: Array<[number, number]> = [];
    let s = 12345;
    for (let i = 0; i < 500; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; items.push([s % 50, i]); }
    for (const [k, v] of items) h.push(k, v);
    const sorted = items.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [k, v] of sorted) { expect(h.peekKey()).toBe(k); expect(h.pop()).toBe(v); }
    expect(h.size).toBe(0);
  });
});

describe('trimGeometry', () => {
  it('cuts a polyline between length fractions', () => {
    const geom: Array<[number, number]> = [A as [number, number], B as [number, number], C as [number, number]];
    const part = trimGeometry(geom, 0.25, 0.75);
    expect(part.length).toBe(3);
    expect(part[0][0]).toBeCloseTo(A[0] + DLON * 0.5, 6);
    expect(part[1]).toEqual(B);
    expect(part[2][1]).toBeCloseTo(B[1] - DLAT * 0.5, 6);
    expect(trimGeometry(geom, 0, 1)).toBe(geom);
  });
});
