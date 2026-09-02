/**
 * Fog / heat overlay tile renderer (docs/BUILD-PLAN.md §2.2). Cells → coverage field → separable
 * blurs → RGBA. Pure typed arrays: runs inside the grid worker (no canvas filters on iOS) and in
 * Node tests. Output is straight-alpha RGBA, size×size.
 *
 * Geometry. A raster tile (z, x, y) covers 2^(22−z) base cells per side. Cells are read at
 * `level = levelForZoom(map zoom)` where a level-L cell is 2^(14−L) base cells, so the tile spans
 * n = 2^(L+8−z) level cells and each level cell is cellPx = size / n output pixels — with 512-px
 * tiles and the level rule, cellPx ∈ {0.5, 1, 2, 4} up to z16, then doubles per zoom (level 14 is
 * the finest). A 256-px tile at zoom z shows the same ground as a 512-px tile at z−1, so the level
 * is picked from z + log2(size/512). When cellPx < 1 several cells share a pixel: we take the max.
 *
 * Work scale. Blur σ is proportional to cellPx, so at high zoom the fields are huge and smooth.
 * When cellPx > 4 the field is built and blurred at 1/k resolution (k a power of two, ≥ 4 work px
 * per cell ⇒ σ ≥ 3.6 work px, well band-limited) and bilinearly upsampled BEFORE the smoothstep
 * non-linearities, so the cleared edge is still crisp at output resolution.
 *
 * Seams. The field carries a margin m = ceil(3·σmax) work px on every side; the ×3 box blur's
 * exact support is Σ radii ≈ 3σ − 1.5 < m, so edge clamping never reaches the tile interior and
 * neighbouring tiles agree to float rounding (tested).
 *
 * Fog (per output pixel, after upsampling):
 *   F = 1 where the cell (dilated by coreRadius: cell + 8 neighbours) has count > 0
 *   narrow = blur(F, σ = 0.9·cellPx), wide = blur(F, σ = feather·cellPx)
 *   core = smoothstep(0.30, 0.85, narrow); halo = halo·smoothstep(0.03, 0.5, wide)
 *   clear = max(core, halo); RGBA = (fogColor, fogAlpha·(1 − clear))
 * Heat: I = 0.22 + 0.78·min(1, (count−1)/7) per (max-dilated) cell, C = 1 where count > 0;
 *   both blurred σ = cellPx; glow = ramp(blur(I)) with alpha × smoothstep(0.02, 0.2, blur(C))
 *   (the outer-edge gate the canvas mockup got from premultiplied blur), composited over the dim
 *   layer (12, 15, 24, heatDim). blur(I) < 0.08 ⇒ dim layer only.
 *
 * Low zoom — the pixel floor. The look above is defined in cells, so once a ribbon is thinner
 * than the z14 one (6 px) the narrow blur collapses towards one pixel (a hard fog edge) and
 * sub-pixel ribbons become confetti. A tile whose nominal ribbon ((2·dilation+1)·cellPx) is below
 * FLOOR_BELOW_RIBBON_PX is therefore rendered AS IF a cell were FLOOR_CELL_PX wide: the
 * rasterised field is max-dilated in pixel space until the ribbon is 3·FLOOR_CELL_PX = 10 px
 * (coreRadius 0 at the base level: 2 cells ≈ 7 px), and σ_wide / σ_heat derive from
 * max(cellPx, FLOOR_CELL_PX) — the same ribbon/σ ratios as the base look, so cores still clear
 * and the fog edge spans ~4 px at every zoom. σ_narrow is 0.3·ribbon in every case (= 0.9·cellPx
 * for the 3-cell ribbon; with coreRadius 0 it follows the 1-cell ribbon instead of staying at 0.9
 * cells, which never cleared the core). The 3×3 cell-space dilation applies at the base level
 * only: an overview cell is already ≥ 16 base cells (115 m at level 10) and dilating it would turn
 * one walk into a 345 m ribbon. Nothing changes for the default look at z ≥ 14 (512-px tiles).
 */

/** Ribbons thinner than this (work px) get the pixel floor: everything below the z14 look. */
export const FLOOR_BELOW_RIBBON_PX = 6;
/** Px per cell the floored look is derived from: 3-cell ribbons become 10 px, σ_narrow 3 px. */
export const FLOOR_CELL_PX = 10 / 3;
import type { OverlayMode, RenderSettings, RenderTileRequest } from '../grid/api';
import { TILE_SIZE } from '../grid/cell';
import { levelForZoom, type CellCounts, type CellTileProvider, type Level } from '../grid/types';
import { blurSupportRadius, gaussianBlur } from './blur';

export interface TileGeometry {
  level: Level;
  /** Level cells per tile side. */
  cellsPerTile: number;
  /** Output pixels per level cell. */
  cellPx: number;
}

export function tileGeometry(z: number, size: number): TileGeometry {
  const level = levelForZoom(z + Math.log2(size / 512));
  const cellsPerTile = Math.pow(2, level + 8 - z);
  return { level, cellsPerTile, cellPx: size / cellsPerTile };
}

/** A rectangle of the world at one level, in level-cell units, rendered at `cellPx` px per cell. */
export interface RegionRequest {
  level: Level;
  /** Origin (north-west corner) in level cells; may be fractional. */
  cx0: number;
  cy0: number;
  cellPx: number;
  width: number;
  height: number;
  mode: OverlayMode;
}

/** Heat colour ramp (mockup): stops of blurred intensity → (r, g, b, glow alpha). */
const HEAT_STOPS: Array<[number, number, number, number, number]> = [
  [0.08, 255, 214, 120, 0.55],
  [0.3, 255, 168, 70, 0.85],
  [0.55, 255, 104, 56, 0.92],
  [0.8, 255, 56, 70, 0.96],
  [1.0, 255, 40, 120, 1.0],
];
const HEAT_DIM: [number, number, number] = [12, 15, 24];
const RAMP_N = 1024;
let rampLut: Float32Array | null = null;

/** Ramp sampled into a LUT of RAMP_N entries × (r, g, b, a). Below 0.08 alpha is 0. */
export function heatRampLut(): Float32Array {
  if (rampLut) return rampLut;
  const lut = new Float32Array(RAMP_N * 4);
  for (let i = 0; i < RAMP_N; i++) {
    const v = i / (RAMP_N - 1);
    let r = 255, g = 200, b = 110, a = 0;
    if (v >= HEAT_STOPS[0][0]) {
      const last = HEAT_STOPS[HEAT_STOPS.length - 1];
      r = last[1]; g = last[2]; b = last[3]; a = last[4];
      for (let s = 1; s < HEAT_STOPS.length; s++) {
        if (v <= HEAT_STOPS[s][0]) {
          const p = HEAT_STOPS[s - 1], q = HEAT_STOPS[s];
          const t = (v - p[0]) / (q[0] - p[0]);
          r = p[1] + (q[1] - p[1]) * t; g = p[2] + (q[2] - p[2]) * t; b = p[3] + (q[3] - p[3]) * t; a = p[4] + (q[4] - p[4]) * t;
          break;
        }
      }
    }
    lut[i * 4] = r; lut[i * 4 + 1] = g; lut[i * 4 + 2] = b; lut[i * 4 + 3] = a;
  }
  rampLut = lut;
  return lut;
}

/** Heat intensity per count (BUILD-PLAN §2.2): 1 visit → 0.22, 8+ visits → 1. */
const INTENSITY = new Float32Array(256);
for (let c = 1; c < 256; c++) INTENSITY[c] = 0.22 + 0.78 * Math.min(1, (c - 1) / 7);

function smoothstep(a: number, b: number, t: number): number {
  let u = (t - a) / (b - a);
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return u * u * (3 - 2 * u);
}

export async function renderOverlayTile(req: RenderTileRequest, settings: RenderSettings, provider: CellTileProvider): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const size = req.size ?? 512;
  const g = tileGeometry(req.z, size);
  return renderOverlayRegion(
    { level: g.level, cx0: req.x * g.cellsPerTile, cy0: req.y * g.cellsPerTile, cellPx: g.cellPx, width: size, height: size, mode: req.mode },
    settings,
    provider,
  );
}

/**
 * Scratch buffers reused across renders (typed-array churn was ~12 MB per z12 tile). Safe: every
 * use happens after the provider fetch, and from there the render runs synchronously to the end
 * of the call, so two in-flight renders never share a buffer. The output RGBA is always fresh
 * (it is transferred to the main thread).
 */
const scratchF32 = new Map<string, Float32Array>();
const scratchI32 = new Map<string, Int32Array>();
let scratchWin = new Uint8Array(0);
function f32(name: string, n: number): Float32Array {
  let b = scratchF32.get(name);
  if (!b || b.length < n) { b = new Float32Array(n); scratchF32.set(name, b); }
  return b;
}
function i32(name: string, n: number): Int32Array {
  let b = scratchI32.get(name);
  if (!b || b.length < n) { b = new Int32Array(n); scratchI32.set(name, b); }
  return b;
}

export async function renderOverlayRegion(req: RegionRequest, settings: RenderSettings, provider: CellTileProvider): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const { level, cx0, cy0, cellPx, width, height, mode } = req;
  const out = new Uint8ClampedArray(width * height * 4);

  // ---- work scale: k output px per work px (power of two, divides width/height)
  let k = 1;
  while (cellPx / k > 4 && width % (k * 2) === 0 && height % (k * 2) === 0) k *= 2;
  const cpw = cellPx / k; // work px per level cell (exact: powers of two)
  const wW = width / k, wH = height / k;

  // ---- ribbon width (work px) and the pixel floor
  const dil = level === 14 && settings.coreRadius ? 1 : 0; // cell-space dilation (base level only)
  const nominal = (2 * dil + 1) * cpw; // ribbon width the cell look would give
  const floored = nominal < FLOOR_BELOW_RIBBON_PX;
  const cellScale = floored ? Math.max(cpw, FLOOR_CELL_PX) : cpw; // px per cell the σs derive from
  // Floored: ribbons as if cells were FLOOR_CELL_PX wide (3 cells; coreRadius 0 at the base: 2).
  const target = floored ? (dil || level !== 14 ? 3 : 2) * FLOOR_CELL_PX : nominal;
  const r = nominal >= target ? 0 : Math.ceil((target - nominal) / 2); // px-space max-dilation radius
  const ribbon = Math.max(nominal, 1) + 2 * r; // a sub-pixel ribbon max-pools to ≥ 1 px

  // ---- sigmas (work px)
  const sigmaWide = settings.feather * cellScale;
  const sigmaNarrow = 0.3 * ribbon; // = 0.9·cellPx for the 3-cell ribbon; scales with coreRadius 0
  const sigmaHeat = cellScale;
  const sigmaMax = mode === 'fog' ? Math.max(sigmaWide, sigmaNarrow) : sigmaHeat;
  const m = Math.max(2, Math.ceil(3 * sigmaMax), blurSupportRadius(sigmaMax) + 1) + r;
  const W = wW + 2 * m, H = wH + 2 * m;

  // ---- cell window (level cells) covering the field plus dilation
  const wcx0 = Math.floor(cx0 - m / cpw) - dil, wcx1 = Math.ceil(cx0 + (wW + m) / cpw) + dil;
  const wcy0 = Math.floor(cy0 - m / cpw) - dil, wcy1 = Math.ceil(cy0 + (wH + m) / cpw) + dil;
  const cw = wcx1 - wcx0, ch = wcy1 - wcy0;
  const tiles = await fetchTiles(wcx0, wcy0, wcx1, wcy1, level, provider);
  // ---- everything below is synchronous: scratch buffers are safe from here on
  if (scratchWin.length < cw * ch) scratchWin = new Uint8Array(cw * ch);
  const win = scratchWin;
  win.fill(0, 0, cw * ch);
  if (!fillWindow(win, cw, wcx0, wcy0, wcx1, wcy1, tiles)) {
    fillEmpty(out, mode, settings);
    return out;
  }
  if (dil) dilate3(win, cw, ch);

  // ---- work-px → window-cell ranges (max-pooled when cpw < 1)
  const colS = i32('colS', W), colE = i32('colE', W), rowS = i32('rowS', H), rowE = i32('rowE', H);
  cellRanges(colS, colE, W, cx0, m, cpw, wcx0, cw);
  cellRanges(rowS, rowE, H, cy0, m, cpw, wcy0, ch);

  // ---- fields
  const n = W * H;
  const fA = f32('fA', n); // fog: coverage F; heat: intensity I
  const fB = mode === 'heat' ? f32('fB', n) : null; // heat: coverage C
  const single = cpw >= 1;
  for (let wy = 0; wy < H; wy++) {
    const rs = rowS[wy], re = rowE[wy];
    const o0 = wy * W;
    if (single) {
      const base = rs * cw;
      if (mode === 'fog') {
        for (let wx = 0; wx < W; wx++) fA[o0 + wx] = win[base + colS[wx]] ? 1 : 0;
      } else {
        for (let wx = 0; wx < W; wx++) { const c = win[base + colS[wx]]; fA[o0 + wx] = INTENSITY[c]; (fB as Float32Array)[o0 + wx] = c ? 1 : 0; }
      }
    } else {
      for (let wx = 0; wx < W; wx++) {
        let mx = 0;
        const cs = colS[wx], ce = colE[wx];
        for (let y = rs; y < re; y++) {
          const base = y * cw;
          for (let x = cs; x < ce; x++) { const v = win[base + x]; if (v > mx) mx = v; }
        }
        if (mode === 'fog') fA[o0 + wx] = mx ? 1 : 0;
        else { fA[o0 + wx] = INTENSITY[mx]; (fB as Float32Array)[o0 + wx] = mx ? 1 : 0; }
      }
    }
  }

  // ---- pixel-space ribbon floor (separable max, radius r)
  const tmp = f32('tmp', n);
  if (r > 0) {
    dilateMax(fA, W, H, r, tmp);
    if (fB) dilateMax(fB, W, H, r, tmp);
  }

  // ---- blurs (s1 = narrow | blur(I); s2 = wide | blur(C))
  const s1 = f32('s1', n), s2 = f32('s2', n);
  if (mode === 'fog') {
    gaussianBlur(fA, W, H, sigmaWide, s2, tmp);
    gaussianBlur(fA, W, H, sigmaNarrow, s1, tmp);
  } else {
    gaussianBlur(fA, W, H, sigmaHeat, s1, tmp);
    gaussianBlur(fB as Float32Array, W, H, sigmaHeat, s2, tmp);
  }

  // ---- fields at output resolution: k = 1 reads the interior of the work field in place,
  // k > 1 resamples bilinearly (before the smoothstep non-linearities)
  let p1 = s1, p2 = s2, stride = W, off = m * W + m;
  if (k > 1) {
    p1 = resample(s1, W, m, k, width, height, f32('p1', width * height));
    p2 = resample(s2, W, m, k, width, height, f32('p2', width * height));
    stride = width; off = 0;
  }

  // ---- colour
  if (mode === 'fog') {
    const [fr, fg, fb] = settings.fogColor;
    const fa = settings.fogAlpha, hk = settings.halo;
    for (let y = 0, o = 0; y < height; y++) {
      for (let x = 0, i = off + y * stride; x < width; x++, i++, o += 4) {
        const core = smoothstep(0.3, 0.85, p1[i]);
        const halo = hk * smoothstep(0.03, 0.5, p2[i]);
        const clear = core > halo ? core : halo;
        out[o] = fr; out[o + 1] = fg; out[o + 2] = fb;
        out[o + 3] = fa * (1 - clear) * 255; // Uint8ClampedArray rounds to nearest
      }
    }
  } else {
    const lut = heatRampLut();
    const da = settings.heatDim;
    const [dr, dg, db] = HEAT_DIM;
    for (let y = 0, o = 0; y < height; y++) {
      for (let x = 0, i = off + y * stride; x < width; x++, i++, o += 4) {
        const v = p1[i];
        let idx = (v * (RAMP_N - 1)) | 0;
        if (idx < 0) idx = 0; else if (idx >= RAMP_N) idx = RAMP_N - 1;
        const a = lut[idx * 4 + 3] * smoothstep(0.02, 0.2, p2[i]);
        const outA = a + da * (1 - a);
        if (a > 0 && outA > 0) {
          const wd = da * (1 - a);
          out[o] = (lut[idx * 4] * a + dr * wd) / outA;
          out[o + 1] = (lut[idx * 4 + 1] * a + dg * wd) / outA;
          out[o + 2] = (lut[idx * 4 + 2] * a + db * wd) / outA;
        } else {
          out[o] = dr; out[o + 1] = dg; out[o + 2] = db;
        }
        out[o + 3] = outA * 255;
      }
    }
  }
  return out;
}

/** Constant tile for regions with no data anywhere near: full fog, or the heat dim layer. */
function fillEmpty(out: Uint8ClampedArray, mode: OverlayMode, settings: RenderSettings): void {
  const [r, g, b] = mode === 'fog' ? settings.fogColor : HEAT_DIM;
  // same rounding as the full path (clamped-array store), so flat and rendered tiles match
  out[3] = (mode === 'fog' ? settings.fogAlpha : settings.heatDim) * 255;
  const a = out[3];
  for (let o = 0; o < out.length; o += 4) { out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a; }
}

interface FetchedTile { tx: number; ty: number; counts: CellCounts }

/**
 * Fetch every provider tile overlapping the window [wcx0,wcx1)×[wcy0,wcy1) (level cells), in
 * parallel and each at most once; tiles outside the world or without data are dropped. This is
 * the only await of a render.
 */
async function fetchTiles(wcx0: number, wcy0: number, wcx1: number, wcy1: number, level: Level, provider: CellTileProvider): Promise<FetchedTile[]> {
  const tilesPerAxis = Math.pow(2, level);
  const tx0 = Math.max(0, Math.floor(wcx0 / TILE_SIZE)), tx1 = Math.min(tilesPerAxis - 1, Math.floor((wcx1 - 1) / TILE_SIZE));
  const ty0 = Math.max(0, Math.floor(wcy0 / TILE_SIZE)), ty1 = Math.min(tilesPerAxis - 1, Math.floor((wcy1 - 1) / TILE_SIZE));
  const jobs: Array<Promise<{ tx: number; ty: number; counts: CellCounts | null }>> = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(provider.getTile(level, tx, ty).then((counts) => ({ tx, ty, counts })));
  const out: FetchedTile[] = [];
  for (const t of await Promise.all(jobs)) if (t.counts) out.push(t as FetchedTile);
  return out;
}

/** Copy the fetched tiles' counts into the (zeroed) window. Returns whether any cell is non-zero. */
function fillWindow(win: Uint8Array, cw: number, wcx0: number, wcy0: number, wcx1: number, wcy1: number, tiles: FetchedTile[]): boolean {
  let any = false;
  for (const { tx, ty, counts } of tiles) {
    const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
    const xs = Math.max(ox, wcx0), xe = Math.min(ox + TILE_SIZE, wcx1);
    const ys = Math.max(oy, wcy0), ye = Math.min(oy + TILE_SIZE, wcy1);
    if (xs >= xe || ys >= ye) continue;
    for (let y = ys; y < ye; y++) {
      const src = (y - oy) * TILE_SIZE;
      const row = counts.subarray(src + (xs - ox), src + (xe - ox));
      win.set(row, (y - wcy0) * cw + (xs - wcx0));
      if (!any) for (let i = 0; i < row.length; i++) if (row[i]) { any = true; break; }
    }
  }
  return any;
}

/** In-place 3×3 max dilation (separable; edges clamp). One scratch allocation. */
function dilate3(win: Uint8Array, cw: number, ch: number): void {
  const tmp = new Uint8Array(win.length);
  for (let y = 0; y < ch; y++) {
    const row = y * cw;
    for (let x = 0; x < cw; x++) {
      let v = win[row + x];
      if (x > 0 && win[row + x - 1] > v) v = win[row + x - 1];
      if (x + 1 < cw && win[row + x + 1] > v) v = win[row + x + 1];
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < ch; y++) {
    const row = y * cw;
    for (let x = 0; x < cw; x++) {
      let v = tmp[row + x];
      if (y > 0 && tmp[row - cw + x] > v) v = tmp[row - cw + x];
      if (y + 1 < ch && tmp[row + cw + x] > v) v = tmp[row + cw + x];
      win[row + x] = v;
    }
  }
}

/**
 * In-place separable max filter of radius r (window 2r+1) on a W×H field — the pixel-space
 * ribbon floor. Edges clamp (the margin absorbs it). `tmp` is scratch of the field's size.
 */
export function dilateMax(f: Float32Array, W: number, H: number, r: number, tmp: Float32Array): void {
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = f[row + x];
      const x0 = x - r < 0 ? 0 : x - r, x1 = x + r >= W ? W - 1 : x + r;
      for (let u = x0; u <= x1; u++) if (f[row + u] > v) v = f[row + u];
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    const y0 = y - r < 0 ? 0 : y - r, y1 = y + r >= H ? H - 1 : y + r;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = tmp[row + x];
      for (let u = y0; u <= y1; u++) if (tmp[u * W + x] > v) v = tmp[u * W + x];
      f[row + x] = v;
    }
  }
}

/**
 * For each work px along one axis, the [start, end) range of window cells it covers. A work px
 * at index p covers level cells [c0 + (p − m)/cpw, c0 + (p + 1 − m)/cpw); when cpw ≥ 1 that is a
 * single cell (floor of the start), when cpw < 1 it is 1/cpw cells (max-pooled by the caller).
 * cpw is a power of two, so the divisions are exact and neighbouring tiles agree bit-for-bit.
 */
function cellRanges(start: Int32Array, end: Int32Array, len: number, c0: number, m: number, cpw: number, wc0: number, wlen: number): void {
  for (let p = 0; p < len; p++) {
    let s = Math.floor(c0 + (p - m) / cpw) - wc0;
    let e = cpw >= 1 ? s + 1 : Math.floor(c0 + (p + 1 - m) / cpw) - wc0;
    if (s < 0) s = 0; else if (s > wlen - 1) s = wlen - 1;
    if (e <= s) e = s + 1; else if (e > wlen) e = wlen;
    start[p] = s; end[p] = e;
  }
}

/**
 * Field (W wide, margin m) → `out` (width×height). k = 1: direct copy of the interior. k > 1:
 * bilinear at output pixel centres, sx = (ox + 0.5)/k − 0.5 + m.
 */
function resample(f: Float32Array, W: number, m: number, k: number, width: number, height: number, out: Float32Array): Float32Array {
  if (k === 1) {
    for (let oy = 0; oy < height; oy++) out.set(f.subarray((oy + m) * W + m, (oy + m) * W + m + width), oy * width);
    return out;
  }
  const ix0 = i32('ix0', width), fx = f32('fx', width);
  for (let ox = 0; ox < width; ox++) {
    const sx = (ox + 0.5) / k - 0.5 + m;
    const x0 = Math.floor(sx);
    ix0[ox] = x0; fx[ox] = sx - x0;
  }
  for (let oy = 0; oy < height; oy++) {
    const sy = (oy + 0.5) / k - 0.5 + m;
    const y0 = Math.floor(sy), fy = sy - y0;
    const r0 = y0 * W, r1 = (y0 + 1) * W;
    const o = oy * width;
    for (let ox = 0; ox < width; ox++) {
      const x0 = ix0[ox], t = fx[ox];
      const top = f[r0 + x0] * (1 - t) + f[r0 + x0 + 1] * t;
      const bot = f[r1 + x0] * (1 - t) + f[r1 + x0 + 1] * t;
      out[o + ox] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}
