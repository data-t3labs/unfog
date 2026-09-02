/**
 * TEST-ONLY minimal way → graph-tile builder (the production one is src/routing/graph-build.ts,
 * owned by wave 1 D). Graph nodes = way endpoints + nodes shared by ≥ 2 ways; arcs = runs between
 * graph nodes, one per direction with per-direction flags; shape = intermediate nodes; tiled at
 * z12 with FOREIGN copies of endpoints that live in another tile (each tile stores its own copy
 * of the shape it references).
 */
import { distanceM } from '../../../src/grid/cell';
import { ArcFlag, GRAPH_ZOOM, NodeFlag, lonLatToGraphTile, type GraphTileInput } from '../../../src/routing/graph-format';

export interface TestWay {
  id: number;
  refs: number[];
  coords: Array<[number, number]>;
  /** Flags for the forward arcs (way direction). */
  fwd: number;
  /** Flags for the reverse arcs; 0 = no reverse arc at all. */
  rev: number;
}

interface Segment {
  u: number; v: number; way: number; len: number; fwd: number; rev: number;
  shape: Array<[number, number]>;
}

export function buildTestTiles(ways: TestWay[], zoom = GRAPH_ZOOM): Map<string, GraphTileInput> {
  const refCount = new Map<number, number>();
  const coordOf = new Map<number, [number, number]>();
  for (const w of ways) {
    for (let i = 0; i < w.refs.length; i++) {
      refCount.set(w.refs[i], (refCount.get(w.refs[i]) ?? 0) + 1);
      coordOf.set(w.refs[i], w.coords[i]);
    }
  }
  const isGraphNode = (w: TestWay, i: number) => i === 0 || i === w.refs.length - 1 || (refCount.get(w.refs[i]) ?? 0) >= 2;
  const segments: Segment[] = [];
  for (const w of ways) {
    let start = 0;
    for (let i = 1; i < w.refs.length; i++) {
      if (!isGraphNode(w, i)) continue;
      let len = 0;
      for (let k = start + 1; k <= i; k++) len += distanceM(w.coords[k - 1][0], w.coords[k - 1][1], w.coords[k][0], w.coords[k][1]);
      segments.push({ u: w.refs[start], v: w.refs[i], way: w.id, len: Math.max(1, Math.round(len)), fwd: w.fwd, rev: w.rev, shape: w.coords.slice(start + 1, i) });
      start = i;
    }
  }
  const tileOf = new Map<number, string>();
  const tileXY = new Map<string, [number, number]>();
  for (const [id, c] of coordOf) {
    const [tx, ty] = lonLatToGraphTile(c[0], c[1], zoom);
    const k = `${tx}/${ty}`;
    tileOf.set(id, k);
    tileXY.set(k, [tx, ty]);
  }
  // Per tile: arcs grouped by from-node.
  interface Arc { to: number; len: number; flags: number; way: number; shape: Array<[number, number]>; reversed: boolean }
  const perTile = new Map<string, Map<number, Arc[]>>();
  const add = (from: number, arc: Arc) => {
    const tk = tileOf.get(from)!;
    let m = perTile.get(tk);
    if (!m) { m = new Map(); perTile.set(tk, m); }
    let list = m.get(from);
    if (!list) { list = []; m.set(from, list); }
    list.push(arc);
  };
  for (const s of segments) {
    if (s.fwd) add(s.u, { to: s.v, len: s.len, flags: s.fwd, way: s.way, shape: s.shape, reversed: false });
    if (s.rev) add(s.v, { to: s.u, len: s.len, flags: s.rev | ArcFlag.REVERSED, way: s.way, shape: s.shape, reversed: true });
  }
  const out = new Map<string, GraphTileInput>();
  for (const [tk, [tx, ty]] of tileXY) {
    const arcsByNode = perTile.get(tk) ?? new Map<number, Arc[]>();
    const localIds = [...coordOf.keys()].filter((id) => tileOf.get(id) === tk && (refCount.get(id) ?? 0) > 0 && isAnyGraphNode(id)).sort((a, b) => a - b);
    const index = new Map<number, number>();
    const nodeId: number[] = [], nodeLon: number[] = [], nodeLat: number[] = [], nodeFlags: number[] = [];
    const pushNode = (id: number, foreign: boolean) => {
      index.set(id, nodeId.length);
      const c = coordOf.get(id)!;
      nodeId.push(id); nodeLon.push(Math.round(c[0] * 1e7)); nodeLat.push(Math.round(c[1] * 1e7)); nodeFlags.push(foreign ? NodeFlag.FOREIGN : 0);
    };
    for (const id of localIds) pushNode(id, false);
    for (const id of localIds) for (const a of arcsByNode.get(id) ?? []) if (!index.has(a.to)) pushNode(a.to, true);
    const arcStart: number[] = [0], arcTo: number[] = [], arcLen: number[] = [], arcFlags: number[] = [], arcWay: number[] = [];
    const arcShapeStart: number[] = [], arcShapeEnd: number[] = [], shapeLon: number[] = [], shapeLat: number[] = [];
    // Shared shape per (segment) inside this tile: key by way + endpoints.
    const shapeRange = new Map<string, [number, number]>();
    for (let i = 0; i < nodeId.length; i++) {
      const id = nodeId[i];
      const arcs = nodeFlags[i] & NodeFlag.FOREIGN ? [] : (arcsByNode.get(id) ?? []);
      for (const a of arcs) {
        const segKey = a.reversed ? `${a.way}:${a.to}:${id}` : `${a.way}:${id}:${a.to}`;
        let range = shapeRange.get(segKey);
        if (!range) {
          const s0 = shapeLon.length;
          for (const p of a.shape) { shapeLon.push(Math.round(p[0] * 1e7)); shapeLat.push(Math.round(p[1] * 1e7)); }
          range = [s0, shapeLon.length];
          shapeRange.set(segKey, range);
        }
        arcTo.push(index.get(a.to)!); arcLen.push(Math.min(65535, a.len)); arcFlags.push(a.flags); arcWay.push(a.way);
        arcShapeStart.push(range[0]); arcShapeEnd.push(range[1]);
      }
      arcStart.push(arcTo.length);
    }
    out.set(tk, { zoom, tx, ty, nodeId, nodeLon, nodeLat, nodeFlags, arcStart, arcTo, arcLen, arcFlags, arcWay, arcShapeStart, arcShapeEnd, shapeLon, shapeLat });
  }
  return out;

  function isAnyGraphNode(id: number): boolean {
    // endpoints or shared nodes — recomputed from the ways (cheap for test sizes)
    if ((refCount.get(id) ?? 0) >= 2) return true;
    for (const w of ways) if (w.refs[0] === id || w.refs[w.refs.length - 1] === id) return true;
    return false;
  }
}
