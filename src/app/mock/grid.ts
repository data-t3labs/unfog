/**
 * In-page GridApi for mock mode (`?mock=1` or when the grid worker fails to load). Synthetic
 * visited cells + a canvas renderer using the same feather/halo/heat maths as the approved
 * mockup (docs/mockups/mock.js) and BUILD-PLAN §2.2. Not fast, not persistent — a demo engine.
 */
import type { ApplyResult, GridApi, RenderSettings, RenderTileRequest, TrackSummary } from '../../grid/api';
import { cellsAlong, distanceM } from '../../grid/cell';
import { levelForZoom, type CellCounts, type GridStats, type ImportPayload, type Level, type Track } from '../../grid/types';
import { SynthCells, cellKey, type LonLat } from './synth';

const smooth = (a: number, b: number, t: number) => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

const HEAT_STOPS: Array<[number, [number, number, number], number]> = [
  [0.08, [255, 214, 120], 0.55],
  [0.3, [255, 168, 70], 0.85],
  [0.55, [255, 104, 56], 0.92],
  [0.8, [255, 56, 70], 0.96],
  [1.0, [255, 40, 120], 1],
];

function heatRamp(v: number): [number, number, number, number] {
  if (v < 0.08) return [255, 200, 110, 0];
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    if (v <= HEAT_STOPS[i][0]) {
      const [a0, c0, o0] = HEAT_STOPS[i - 1], [a1, c1, o1] = HEAT_STOPS[i];
      const t = (v - a0) / (a1 - a0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t, o0 + (o1 - o0) * t];
    }
  }
  return [255, 40, 120, 1];
}

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { ctx: Ctx2D; canvas: OffscreenCanvas | HTMLCanvasElement } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D };
}

function blurred(src: OffscreenCanvas | HTMLCanvasElement, W: number, B: number, px: number): Uint8ClampedArray {
  const { ctx } = makeCanvas(B, B);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if ('filter' in ctx) ctx.filter = px >= 0.5 ? `blur(${px.toFixed(1)}px)` : 'none';
  ctx.drawImage(src as CanvasImageSource, 0, 0, W, W, 0, 0, B, B);
  if ('filter' in ctx) ctx.filter = 'none';
  return ctx.getImageData(0, 0, B, B).data;
}

export function createMockGrid(center: LonLat, seed = 7): GridApi & { synth: SynthCells } {
  const synth = new SynthCells(center, seed);
  const tracks = new Map<string, Track>();
  /** Cells already credited per track id — re-marking the same id never double counts. */
  const credited = new Map<string, Set<number>>();
  let version = 1;
  let updatedAt = Date.now();

  const stats = (): GridStats => ({ ...synth.stats(), version, updatedAt });
  const touchedList = (t: Set<number>) => [...t].map((k) => ({ tx: k >> 16, ty: k & 0xffff }));

  function markTrackInternal(track: Track): Set<number> {
    const prev = credited.get(track.id);
    const pts = track.points.map((p) => [p[0], p[1]] as [number, number]);
    let touched: Set<number>;
    if (!prev) {
      touched = synth.markTrack(pts);
      const set = new Set<number>();
      for (const [cx, cy] of cellsOf(pts)) set.add(cellKey(cx, cy));
      credited.set(track.id, set);
    } else {
      // Only the cells this id has not credited yet get +1.
      touched = new Set();
      for (const [cx, cy] of cellsOf(pts)) {
        const k = cellKey(cx, cy);
        if (prev.has(k)) continue;
        prev.add(k);
        synth.cells.set(k, Math.min(255, (synth.cells.get(k) ?? 0) + 1));
        touched.add(((cx >> 8) << 16) | (cy >> 8));
      }
      synth.bump();
    }
    tracks.set(track.id, track);
    return touched;
  }

  function bump(): void {
    version++;
    updatedAt = Date.now();
  }

  async function renderTile(req: RenderTileRequest, s: RenderSettings): Promise<ImageBitmap | Uint8ClampedArray> {
    const size = req.size ?? 512;
    const L: Level = levelForZoom(req.z);
    const n = 1 << (L + 8 - req.z); // level cells per tile side
    const K = size / n; // px per level cell
    const sigmaW = Math.max(0.5, s.feather);
    const sigmaN = 0.9;
    const m = Math.ceil(3 * sigmaW) + 2;
    const W = n + 2 * m;
    const X0 = req.x * n - m, Y0 = req.y * n - m;
    const dilate = L === 14 && s.coreRadius === 1 ? 1 : 0;

    const small = makeCanvas(W, W);
    const img = small.ctx.createImageData(W, W);
    const px = img.data;
    let any = false;
    const t0 = Math.floor(X0 / 256), t1 = Math.floor((X0 + W - 1) / 256);
    const u0 = Math.floor(Y0 / 256), u1 = Math.floor((Y0 + W - 1) / 256);
    for (let ty = u0; ty <= u1; ty++) {
      for (let tx = t0; tx <= t1; tx++) {
        const counts = synth.tileCounts(L, tx, ty);
        if (!counts) continue;
        for (let iy = 0; iy < 256; iy++) {
          const gy = ty * 256 + iy - Y0;
          if (gy < -1 || gy > W) continue;
          for (let ix = 0; ix < 256; ix++) {
            const c = counts[iy * 256 + ix];
            if (!c) continue;
            const gx = tx * 256 + ix - X0;
            if (gx < -1 || gx > W) continue;
            const v = req.mode === 'heat' ? Math.round(255 * Math.min(1, 0.22 + (0.78 * (c - 1)) / 7)) : 255;
            for (let dy = -dilate; dy <= dilate; dy++) {
              for (let dx = -dilate; dx <= dilate; dx++) {
                const x = gx + dx, y = gy + dy;
                if (x < 0 || y < 0 || x >= W || y >= W) continue;
                const i = (y * W + x) * 4;
                if (v > px[i]) { px[i] = v; px[i + 1] = v; px[i + 2] = v; }
                px[i + 3] = 255;
                any = true;
              }
            }
          }
        }
      }
    }

    const out = new ImageData(size, size);
    const o = out.data;
    const dim = s.heatDim;
    const [dr, dg, db] = s.heatDimColor ?? [12, 15, 24];
    if (!any) {
      if (req.mode === 'fog') {
        const a = Math.round(s.fogAlpha * 255);
        for (let i = 0; i < o.length; i += 4) { o[i] = s.fogColor[0]; o[i + 1] = s.fogColor[1]; o[i + 2] = s.fogColor[2]; o[i + 3] = a; }
      } else {
        const a = Math.round(dim * 255);
        for (let i = 0; i < o.length; i += 4) { o[i] = dr; o[i + 1] = dg; o[i + 2] = db; o[i + 3] = a; }
      }
      return createImageBitmap(out);
    }

    small.ctx.putImageData(img, 0, 0);
    const B = Math.round(W * K);
    const narrowPass = req.z >= 12;
    const narrow = blurred(small.canvas, W, B, (req.mode === 'heat' ? 1 : sigmaN) * K);
    const wide = req.mode === 'fog' ? blurred(small.canvas, W, B, sigmaW * K) : narrow;
    const off = Math.round(m * K);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const bi = ((y + off) * B + (x + off)) * 4;
        const oi = (y * size + x) * 4;
        if (req.mode === 'fog') {
          const cover = narrow[bi + 3] / 255;
          const wc = wide[bi + 3] / 255;
          const core = narrowPass ? smooth(0.3, 0.85, cover) : smooth(0.15, 0.6, wc);
          const clear = Math.max(core, s.halo * smooth(0.03, 0.5, wc));
          const ga = (s.clearAlpha ?? 0) * clear; // night: a light over cleared ground (src/render/tiles.ts)
          const wf = s.fogAlpha * (1 - clear) * (1 - ga);
          const outA = ga + wf;
          if (ga > 0 && s.clearColor && outA > 0) {
            o[oi] = Math.round((s.clearColor[0] * ga + s.fogColor[0] * wf) / outA);
            o[oi + 1] = Math.round((s.clearColor[1] * ga + s.fogColor[1] * wf) / outA);
            o[oi + 2] = Math.round((s.clearColor[2] * ga + s.fogColor[2] * wf) / outA);
            o[oi + 3] = Math.round(outA * 255);
          } else {
            o[oi] = s.fogColor[0]; o[oi + 1] = s.fogColor[1]; o[oi + 2] = s.fogColor[2];
            o[oi + 3] = Math.round(s.fogAlpha * (1 - clear) * 255);
          }
        } else {
          const mm = (narrow[bi + 3] / 255) * (narrow[bi] / 255);
          const [r, g, b, ha] = heatRamp(mm);
          const a = ha * smooth(0.02, 0.2, narrow[bi + 3] / 255);
          const outA = a + dim * (1 - a);
          o[oi] = Math.round((r * a + dr * dim * (1 - a)) / outA);
          o[oi + 1] = Math.round((g * a + dg * dim * (1 - a)) / outA);
          o[oi + 2] = Math.round((b * a + db * dim * (1 - a)) / outA);
          o[oi + 3] = Math.round(outA * 255);
        }
      }
    }
    return createImageBitmap(out);
  }

  const api: GridApi & { synth: SynthCells } = {
    synth,
    async init() {
      return stats();
    },
    async getStats() {
      return stats();
    },
    async applyPayload(payload: ImportPayload): Promise<ApplyResult> {
      const touched = new Set<number>();
      for (const t of payload.cellTiles ?? []) {
        synth.mergeTile(t.tx, t.ty, t.counts);
        touched.add((t.tx << 16) | t.ty);
      }
      for (const tr of payload.tracks ?? []) for (const k of markTrackInternal(tr)) touched.add(k);
      bump();
      return { stats: stats(), touched: touchedList(touched) };
    },
    async markTrack(track: Track): Promise<ApplyResult> {
      const touched = markTrackInternal(track);
      bump();
      return { stats: stats(), touched: touchedList(touched) };
    },
    renderTile,
    async getTileCounts(level: Level, tx: number, ty: number): Promise<CellCounts | null> {
      const c = synth.tileCounts(level, tx, ty);
      return c ? new Uint8Array(c) : null;
    },
    async listBaseTiles() {
      return synth.baseTiles();
    },
    async exportBackup(): Promise<Uint8Array> {
      const cells: Array<[number, number]> = [...synth.cells.entries()];
      const json = JSON.stringify({ format: 'unfog-mock-backup', version: 1, cells, tracks: [...tracks.values()] });
      return new TextEncoder().encode(json);
    },
    async importBackup(bytes: Uint8Array): Promise<ApplyResult> {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { cells?: Array<[number, number]>; tracks?: Track[] };
      const touched = new Set<number>();
      for (const [k, c] of parsed.cells ?? []) {
        const cur = synth.cells.get(k) ?? 0;
        if (c > cur) synth.cells.set(k, c);
      }
      synth.bump();
      for (const t of parsed.tracks ?? []) if (!tracks.has(t.id)) tracks.set(t.id, t);
      bump();
      return { stats: stats(), touched: touchedList(touched) };
    },
    async listTracks(): Promise<TrackSummary[]> {
      return [...tracks.values()].map(summarize);
    },
    async getTrack(id: string) {
      return tracks.get(id) ?? null;
    },
    async deleteTrack(id: string) {
      tracks.delete(id);
      credited.delete(id);
      bump();
      return stats();
    },
    async deleteAll() {
      synth.cells.clear();
      synth.bump();
      tracks.clear();
      credited.clear();
      bump();
      return stats();
    },
  };
  return api;
}

function cellsOf(points: Array<[number, number]>): Array<[number, number]> {
  return cellsAlong(points);
}

export function summarize(t: Track): TrackSummary {
  let len = 0;
  for (let i = 1; i < t.points.length; i++) {
    const a = t.points[i - 1], b = t.points[i];
    const d = distanceM(a[0], a[1], b[0], b[1]);
    if (d < 500) len += d;
  }
  const times = t.points.map((p) => p[2]).filter((v): v is number => typeof v === 'number');
  return {
    id: t.id,
    source: t.source,
    name: t.name,
    points: t.points.length,
    startMs: times.length ? Math.min(...times) : undefined,
    endMs: times.length ? Math.max(...times) : undefined,
    lengthM: len,
  };
}
