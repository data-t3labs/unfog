import { describe, expect, it } from 'vitest';
import { cellsAlong } from '../grid/cell';
import { ArcFlag, decodeGraphTile, encodeGraphTile } from './graph-format';
import { Graph } from './graph';
import { SpatialIndex, canEnterArc, canLeaveArc } from './spatial';
import { MapCellLookup } from './cells';
import { NoveltyScorer } from './novelty';
import { Searcher, hasImmediateUTurn, MinHeap } from './search';
import { findCandidates, pathCoords, snapPoint, trimGeometry } from './candidates';

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

  it('snapping skips an isolated arc for the nearest one the search can leave/enter (Jamaica no-route)', () => {
    // Island: a 20 m stair E—F, 20 m north of A—B's midpoint, connected to nothing.
    const E = [A[0] + DLON * 0.4, A[1] + 20 / 110_574], F = [A[0] + DLON * 0.6, A[1] + 20 / 110_574];
    const island = {
      ...square,
      nodeId: [...square.nodeId, 5, 6],
      nodeLon: [...square.nodeLon, e7(E[0]), e7(F[0])],
      nodeLat: [...square.nodeLat, e7(E[1]), e7(F[1])],
      nodeFlags: [...square.nodeFlags, 0, 0],
      arcStart: [...square.arcStart, 9, 10],
      arcTo: [...square.arcTo, 5, 4],
      arcLen: [...square.arcLen, 20, 20],
      arcFlags: [...square.arcFlags, STAIR, STAIR | ArcFlag.REVERSED],
      arcWay: [...square.arcWay, 50, 50],
      arcShapeStart: [...square.arcShapeStart, 1, 1],
      arcShapeEnd: [...square.arcShapeEnd, 1, 1],
    };
    const EF = 8;
    const graph = new Graph([decodeGraphTile(encodeGraphTile(island))]);
    expect(graph.arcReverse[EF]).toBe(EF + 1);
    const spatial = new SpatialIndex(graph);
    expect(canLeaveArc(graph, EF, ArcFlag.WALK)).toBe(false);
    expect(canEnterArc(graph, EF, ArcFlag.WALK)).toBe(false);
    expect(canLeaveArc(graph, AB, ArcFlag.DRIVE)).toBe(true);
    expect(canEnterArc(graph, AB, ArcFlag.DRIVE)).toBe(true);
    // 5 m south of the island, 15 m north of A—B: the island is the nearest walkable arc…
    const p: [number, number] = [A[0] + DLON / 2, A[1] + 15 / 110_574];
    expect(spatial.nearestArc(p[0], p[1], ArcFlag.WALK)!.arc).toBe(EF);
    // …but the snap lands on A—B, the nearest arc with a way on.
    for (const which of ['origin', 'destination'] as const) {
      const s = snapPoint(spatial, p, 'walk', which);
      expect(graph.segmentId(s.arc)).toBe(AB);
      expect(s.distM).toBeCloseTo(15, 0);
    }
    // Bike would dismount onto the stair; drive never saw it. Both land on A—B too.
    expect(graph.segmentId(snapPoint(spatial, p, 'bike', 'origin').arc)).toBe(AB);
    expect(graph.segmentId(snapPoint(spatial, p, 'drive', 'origin').arc)).toBe(AB);
    // End to end: a walk from p to the middle of C—D routes instead of stranding on the island.
    const res = findCandidates(graph, new MapCellLookup(), { from: p, to: [C[0] - DLON / 2, C[1]], mode: 'walk', detour: 0.25 });
    expect(res.candidates[res.candidates.length - 1].name).toBe('Direct');
    expect(res.shortestM).toBeGreaterThanOrEqual(150);
    // A lone arc with nothing to fall back to is still snapped: a trip along it routes directly.
    const lone = {
      ...island, nodeId: [5, 6], nodeLon: [e7(E[0]), e7(F[0])], nodeLat: [e7(E[1]), e7(F[1])], nodeFlags: [0, 0],
      arcStart: [0, 1, 2], arcTo: [1, 0], arcLen: [20, 20], arcFlags: [STAIR, STAIR | ArcFlag.REVERSED], arcWay: [50, 50],
      arcShapeStart: [0, 0], arcShapeEnd: [0, 0], shapeLon: [], shapeLat: [],
    };
    const loneGraph = new Graph([decodeGraphTile(encodeGraphTile(lone))]);
    const along = findCandidates(loneGraph, new MapCellLookup(), { from: [E[0] + DLON * 0.02, E[1]], to: [F[0] - DLON * 0.02, F[1]], mode: 'walk', detour: 0.25 });
    expect(along.candidates.map((c) => c.name)).toEqual(['Direct']);
    expect(along.shortestM).toBe(16);
  });

  it('no route at all rejects with NoRouteError naming the mode, never an empty candidate list', () => {
    const { graph, lookup } = build();
    // A→B is oneway and C↔D is a stair: a car near B's end of A—B cannot reach A's end.
    const from: [number, number] = [A[0] + DLON * 0.9, A[1]], to: [number, number] = [A[0] + DLON * 0.1, A[1]];
    const drive = () => findCandidates(graph, lookup, { from, to, mode: 'drive', detour: 0.25 });
    expect(drive).toThrow(/^No driving route found between these points\. Try walk or bike, or move the pin\.$/);
    let err: Error | undefined;
    try { drive(); } catch (e) { err = e as Error; }
    expect(err?.name).toBe('NoRouteError');
    // Walking is fine (B→A allows it); the other modes' messages read the same way.
    expect(findCandidates(graph, lookup, { from, to, mode: 'walk', detour: 0.25 }).shortestM).toBe(80);
    const bikeOnly = { ...square, arcFlags: square.arcFlags.map((f, i) => (i === CD || i === DC ? ArcFlag.DRIVE : f)) };
    const g2 = new Graph([decodeGraphTile(encodeGraphTile(bikeOnly))]);
    expect(() => findCandidates(g2, lookup, { from, to, mode: 'bike', detour: 0.25 })).toThrow(/^No cycling route found between these points\. Try walk or drive, or move the pin\.$/);
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

  it('GLUE connectors route at plain length under any λ and never count as new', () => {
    const glued = { ...square, arcFlags: square.arcFlags.map((f, i) => (i === CD || i === DC ? (f & ~(ArcFlag.STEPS | ArcFlag.DISMOUNT)) | ArcFlag.GLUE : f)) };
    const graph = new Graph([decodeGraphTile(encodeGraphTile(glued))]);
    // (a) A—B and C—D visited: the ordinary visited arc is penalised, the glue connector is not.
    const visited = new MapCellLookup();
    for (const seg of [[A, B], [C, D]] as Array<Array<[number, number]>>) for (const [cx, cy] of cellsAlong(seg, { stepM: 3 })) visited.mark(cx, cy, 1, 1);
    const searcher = new Searcher(graph, new NoveltyScorer(graph, visited));
    expect(searcher.arcCost(AB, 4, 'walk', null, 5)).toBe(500);
    expect(searcher.arcCost(CD, 4, 'walk', null, 5)).toBe(100);
    // C→A at λ=1 goes round via the connector (100) rather than the visited B→A (200); the
    // connector adds length but no new metres.
    const viaCD = searcher.run(snapOn(graph, CB, 0.5), snapOn(graph, DA, 0.5), { lambda: 1, mode: 'walk' })!;
    expect(Array.from(viaCD.arcs)).toEqual([BC, CD, DA]); // back along C—B's reverse to C, connector, D→A
    expect(viaCD.lengthM).toBeCloseTo(50.5 + 100 + 50, 6);
    expect(viaCD.newM).toBeCloseTo(50.5 * searcher.scorer.get(BC) + 0 + 50 * searcher.scorer.get(DA), 6);
    expect(viaCD.newM).toBeGreaterThan(50);
    // (b) nothing visited: an unvisited connector still reports 0 new metres.
    const fresh = new NoveltyScorer(graph, new MapCellLookup());
    expect(fresh.get(CD)).toBe(0);
    expect(fresh.newMetres(DC)).toBe(0);
    expect(fresh.get(BC)).toBe(1);
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
