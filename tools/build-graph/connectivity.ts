/**
 * Graph health: per-mode connected components over a set of tiles (weakly connected — direction
 * ignored). Used by the CLI after every build and by graph-output.test.ts on the prebuilt regions,
 * so a rule change that cuts the walk network in two (review F1) fails loudly.
 */
import { ArcFlag, MODE_BIT, NodeFlag, type GraphTile, type GraphTileInput, type Mode } from '../../src/routing/graph-format';

export interface ModeConnectivity {
  /** Nodes touched by at least one arc usable in this mode. */
  nodes: number;
  /** Size of the largest component. */
  largest: number;
  /** largest / nodes (0 when the mode has no arcs). */
  pct: number;
  components: number;
  /** Arcs usable in this mode (directed), and how many of them are GLUE. */
  arcs: number;
  glueArcs: number;
  /** Component id of an OSM node id (−1 when the node has no arc in this mode). */
  componentOf(nodeId: number): number;
}

export type Connectivity = Record<Mode, ModeConnectivity>;

export function connectivity(tiles: Iterable<GraphTileInput | GraphTile>): Connectivity {
  const list = Array.from(tiles);
  // global index per OSM node id (a node is local in exactly one tile, foreign in others)
  const index = new Map<number, number>();
  for (const t of list) for (let i = 0; i < t.nodeId.length; i++) {
    if (t.nodeFlags[i] & NodeFlag.FOREIGN) continue;
    if (!index.has(t.nodeId[i])) index.set(t.nodeId[i], index.size);
  }
  for (const t of list) for (let i = 0; i < t.nodeId.length; i++) if (!index.has(t.nodeId[i])) index.set(t.nodeId[i], index.size);
  const N = index.size;
  const out = {} as Connectivity;
  for (const mode of ['walk', 'bike', 'drive'] as Mode[]) {
    const bit = MODE_BIT[mode];
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const used = new Uint8Array(N);
    let arcs = 0, glueArcs = 0;
    for (const t of list) {
      const gid = new Int32Array(t.nodeId.length);
      for (let i = 0; i < gid.length; i++) gid[i] = index.get(t.nodeId[i])!;
      for (let i = 0; i < t.nodeId.length; i++) {
        for (let a = t.arcStart[i]; a < t.arcStart[i + 1]; a++) {
          if (!(t.arcFlags[a] & bit)) continue;
          arcs++;
          if (t.arcFlags[a] & ArcFlag.GLUE) glueArcs++;
          const u = gid[i], v = gid[t.arcTo[a]];
          used[u] = 1; used[v] = 1;
          const ru = find(u), rv = find(v);
          if (ru !== rv) parent[ru] = rv;
        }
      }
    }
    const size = new Map<number, number>();
    let nodes = 0;
    for (let i = 0; i < N; i++) {
      if (!used[i]) continue;
      nodes++;
      const r = find(i);
      size.set(r, (size.get(r) ?? 0) + 1);
    }
    let largest = 0;
    for (const s of size.values()) if (s > largest) largest = s;
    out[mode] = {
      nodes, largest, pct: nodes ? largest / nodes : 0, components: size.size, arcs, glueArcs,
      componentOf: (nodeId: number) => { const i = index.get(nodeId); return i === undefined || !used[i] ? -1 : find(i); },
    };
  }
  return out;
}
