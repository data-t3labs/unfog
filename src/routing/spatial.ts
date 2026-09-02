/**
 * Grid-bucketed spatial index over the arcs of a Graph, for snapping a lon/lat to the nearest
 * road. Only canonical arcs (one per undirected segment) are indexed; the mode check considers
 * both directions so a oneway street still snaps for drive.
 */
import { WORLD, lonLatToWorld, worldToLonLat } from '../grid/cell';
import type { LonLat } from './api';
import { ArcFlag } from './graph-format';
import type { Graph } from './graph';

const BUCKET_ZOOM = 16;
const BUCKET_SHIFT = 22 - BUCKET_ZOOM; // z22 cells → z16 buckets
const BUCKETS_PER_AXIS = 1 << BUCKET_ZOOM;
const DEG = Math.PI / 180;

export interface Snap {
  /** Canonical arc index (see Graph.segmentId). */
  arc: number;
  /** Fraction along the arc's geometry (by length) in the arc's travel direction, 0..1. */
  t: number;
  /** The projected point on the road. */
  point: LonLat;
  /** Distance from the query point to `point`, metres. */
  distM: number;
}

export class SpatialIndex {
  private readonly bucketStart: Uint32Array;
  private readonly bucketArcs: Uint32Array;
  private readonly bucketIndex = new Map<number, number>(); // bucket key → position in bucketStart
  private readonly stamp: Uint32Array;
  private stampGen = 1;

  constructor(readonly graph: Graph) {
    const g = graph;
    const pt: [number, number] = [0, 0];
    // Pass 1: collect bucket keys per canonical arc.
    const keys: number[] = [];      // flat list of (bucketKey) per (arc, bucket) pair
    const arcs: number[] = [];
    for (let a = 0; a < g.arcCount; a++) {
      if (g.segmentId(a) !== a) continue;
      const count = g.arcPointCount(a);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < count; i++) {
        g.arcPoint(a, i, pt);
        const [x, y] = lonLatToWorld(pt[0], pt[1]);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const bx0 = Math.floor(minX) >> BUCKET_SHIFT, bx1 = Math.floor(maxX) >> BUCKET_SHIFT;
      const by0 = Math.floor(minY) >> BUCKET_SHIFT, by1 = Math.floor(maxY) >> BUCKET_SHIFT;
      for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) { keys.push(by * BUCKETS_PER_AXIS + bx); arcs.push(a); }
    }
    // Group by bucket key (counting sort over a Map of keys).
    const counts = new Map<number, number>();
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    this.bucketStart = new Uint32Array(counts.size + 1);
    let pos = 0, i = 0;
    for (const [k, c] of counts) { this.bucketIndex.set(k, i); this.bucketStart[i] = pos; pos += c; i++; }
    this.bucketStart[i] = pos;
    const fill = new Uint32Array(counts.size);
    this.bucketArcs = new Uint32Array(pos);
    for (let j = 0; j < keys.length; j++) {
      const bi = this.bucketIndex.get(keys[j])!;
      this.bucketArcs[this.bucketStart[bi] + fill[bi]++] = arcs[j];
    }
    this.stamp = new Uint32Array(g.arcCount);
  }

  /**
   * Nearest arc usable by `modeMask` (in either direction) within `maxDistM` of a point.
   * Returns null when nothing qualifies.
   */
  nearestArc(lon: number, lat: number, modeMask: number, maxDistM = 300): Snap | null {
    const g = this.graph;
    const [wx, wy] = lonLatToWorld(lon, lat);
    const cx = Math.floor(wx) >> BUCKET_SHIFT, cy = Math.floor(wy) >> BUCKET_SHIFT;
    // Bucket edge in metres at this latitude.
    const bucketM = (40_075_016.686 / BUCKETS_PER_AXIS) * Math.cos(lat * DEG);
    const maxRings = Math.ceil(maxDistM / bucketM) + 1;
    const kx = 111_320 * Math.cos(lat * DEG), ky = 110_574;
    const gen = ++this.stampGen;
    const pt: [number, number] = [0, 0];
    let best: Snap | null = null;
    let bestD = maxDistM;
    for (let r = 0; r <= maxRings; r++) {
      if (best && bestD <= (r - 1) * bucketM) break;
      for (let by = cy - r; by <= cy + r; by++) {
        for (let bx = cx - r; bx <= cx + r; bx++) {
          if (r > 0 && Math.abs(by - cy) !== r && Math.abs(bx - cx) !== r) continue; // ring only
          const bi = this.bucketIndex.get(by * BUCKETS_PER_AXIS + bx);
          if (bi === undefined) continue;
          for (let k = this.bucketStart[bi]; k < this.bucketStart[bi + 1]; k++) {
            const a = this.bucketArcs[k];
            if (this.stamp[a] === gen) continue;
            this.stamp[a] = gen;
            const rev = g.arcReverse[a];
            const flags = g.arcFlags[a] | (rev >= 0 ? g.arcFlags[rev] : 0);
            if (!usableFlags(flags, modeMask)) continue;
            // Project onto every segment of the arc (planar metres around the query point).
            const count = g.arcPointCount(a);
            g.arcPoint(a, 0, pt);
            let px = (pt[0] - lon) * kx, py = (pt[1] - lat) * ky;
            let along = 0, total = 0;
            let segBestD = Infinity, segBestAlong = 0, segBestX = 0, segBestY = 0;
            for (let i = 1; i < count; i++) {
              g.arcPoint(a, i, pt);
              const qx = (pt[0] - lon) * kx, qy = (pt[1] - lat) * ky;
              const dx = qx - px, dy = qy - py;
              const segLen = Math.sqrt(dx * dx + dy * dy);
              let u = 0;
              if (segLen > 0) u = Math.max(0, Math.min(1, -(px * dx + py * dy) / (segLen * segLen)));
              const sx = px + dx * u, sy = py + dy * u;
              const d = Math.sqrt(sx * sx + sy * sy);
              if (d < segBestD) { segBestD = d; segBestAlong = along + u * segLen; segBestX = sx; segBestY = sy; }
              along += segLen; total += segLen;
              px = qx; py = qy;
            }
            if (segBestD < bestD || (segBestD === bestD && best && a < best.arc)) {
              bestD = segBestD;
              best = {
                arc: a,
                t: total > 0 ? segBestAlong / total : 0,
                point: [lon + segBestX / kx, lat + segBestY / ky],
                distM: segBestD,
              };
            }
          }
        }
      }
    }
    return best;
  }
}

/** Whether flags allow a mode. Bikes may also walk (DISMOUNT) where walking is allowed. */
export function usableFlags(flags: number, modeMask: number): boolean {
  if (flags & modeMask) return true;
  if (modeMask === ArcFlag.BIKE && (flags & ArcFlag.DISMOUNT) && (flags & ArcFlag.WALK)) return true;
  return false;
}

/** Utility for tests/tools: world coords of a bucket's north-west corner. */
export function bucketOrigin(bx: number, by: number): LonLat {
  return worldToLonLat(Math.min(WORLD, bx << BUCKET_SHIFT), Math.min(WORLD, by << BUCKET_SHIFT));
}
