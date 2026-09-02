import { describe, expect, it } from 'vitest';
import { MemoryProvider, syntheticCity, syntheticRegion } from '../../tests/fixtures/grid/synthetic';
import { DEFAULT_RENDER_SETTINGS, type RenderSettings } from '../grid/api';
import { crc32 } from '../grid/backup';
import { lonLatToCell } from '../grid/cell';
import { levelForZoom } from '../grid/types';
import { blurSupportRadius } from './blur';
import { heatRampLut, renderOverlayRegion, renderOverlayTile, tileGeometry } from './tiles';

const S: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };
/** crc32 of the RGBA of the synthetic-city home tile with the defaults — the approved z ≥ 14 look. */
const APPROVED_HASHES: Record<string, number> = { 'z14-fog': 4177300252, 'z15-fog': 2487118329, 'z16-fog': 4131091800, 'z17-fog': 1576555743, 'z15-heat': 4164253060 };
const HOME: [number, number] = [-73.9568, 40.7176];
const [HCX, HCY] = lonLatToCell(HOME[0], HOME[1]);

/** Tile coords at zoom z containing base cell (cx, cy), for 512-px tiles. */
function tileAt(z: number, cx: number, cy: number): { x: number; y: number } {
  const cellsPerTile = 2 ** (22 - z);
  return { x: Math.floor(cx / cellsPerTile), y: Math.floor(cy / cellsPerTile) };
}

/** Output pixel (centre) of a base cell inside a tile. */
function pixelOf(z: number, x: number, y: number, cx: number, cy: number, size = 512): { px: number; py: number } {
  const cellsPerTile = 2 ** (22 - z);
  const cellPx = size / cellsPerTile;
  return { px: Math.floor((cx - x * cellsPerTile) * cellPx + cellPx / 2), py: Math.floor((cy - y * cellsPerTile) * cellPx + cellPx / 2) };
}

function rgba(img: Uint8ClampedArray, size: number, px: number, py: number): [number, number, number, number] {
  const o = (py * size + px) * 4;
  return [img[o], img[o + 1], img[o + 2], img[o + 3]];
}

describe('tileGeometry', () => {
  it('derives level, cells per tile and px per cell from the tile zoom and size', () => {
    // 512-px tiles: level = levelForZoom(z); a level cell is 2^(14−L) base cells
    expect(tileGeometry(15, 512)).toEqual({ level: 14, cellsPerTile: 128, cellPx: 4 });
    expect(tileGeometry(14, 512)).toEqual({ level: 14, cellsPerTile: 256, cellPx: 2 });
    expect(tileGeometry(12, 512)).toEqual({ level: 14, cellsPerTile: 1024, cellPx: 0.5 });
    expect(tileGeometry(11, 512)).toEqual({ level: 10, cellsPerTile: 128, cellPx: 4 });
    expect(tileGeometry(8, 512)).toEqual({ level: 10, cellsPerTile: 1024, cellPx: 0.5 });
    expect(tileGeometry(7, 512)).toEqual({ level: 6, cellsPerTile: 128, cellPx: 4 });
    expect(tileGeometry(3, 512)).toEqual({ level: 2, cellsPerTile: 128, cellPx: 4 });
    expect(tileGeometry(17, 512)).toEqual({ level: 14, cellsPerTile: 32, cellPx: 16 });
    expect(tileGeometry(22, 512)).toEqual({ level: 14, cellsPerTile: 1, cellPx: 512 });
    // 256-px tiles show the ground of a 512-px tile one zoom lower
    expect(tileGeometry(16, 256)).toEqual({ level: 14, cellsPerTile: 64, cellPx: 4 });
    expect(tileGeometry(13, 256)).toEqual({ level: 14, cellsPerTile: 512, cellPx: 0.5 });
    expect(tileGeometry(12, 256)).toEqual({ level: 10, cellsPerTile: 64, cellPx: 4 });
    for (let z = 0; z <= 22; z++) expect(tileGeometry(z, 512).level).toBe(levelForZoom(z));
  });
});

describe('fog tile', () => {
  const p = new MemoryProvider();
  const z = 15;
  const { x, y } = tileAt(z, HCX, HCY);
  // one straight east–west street, 1 cell thick, 400 cells long, through the tile's middle row
  const SX = x * 128 + 64, SY = y * 128 + 64; // a cell on the street, mid-tile
  p.line(SX - 200, SY, SX + 200, SY, 1);

  it('clears the core of a visited street, keeps full fog far away, lifts partially in the halo', async () => {
    const img = await renderOverlayTile({ z, x, y, mode: 'fog' }, S, p);
    expect(img.length).toBe(512 * 512 * 4);
    const { px, py } = pixelOf(z, x, y, SX, SY);
    const core = rgba(img, 512, px, py);
    expect(core.slice(0, 3)).toEqual([16, 20, 30]);
    expect(core[3]).toBeLessThanOrEqual(3);
    // 2 cells (8 px) from the street centre line: halo only (core threshold not reached)
    const halo = rgba(img, 512, px, py + 8)[3];
    expect(halo).toBeGreaterThan(20);
    expect(halo).toBeLessThan(190);
    // 30 cells away (120 px): untouched fog = round(0.8·255)
    const far = rgba(img, 512, px, Math.min(511, py + 120))[3];
    expect(far).toBe(204);
    // monotonic fade away from the street
    let last = -1;
    for (let d = 0; d <= 60; d += 2) { const a = rgba(img, 512, px, py + d)[3]; expect(a).toBeGreaterThanOrEqual(last); last = a; }
  });

  it('coreRadius 0 clears a narrower ribbon; halo 0 leaves only the core; fogAlpha scales', async () => {
    const wide = await renderOverlayTile({ z, x, y, mode: 'fog' }, S, p);
    const narrow = await renderOverlayTile({ z, x, y, mode: 'fog' }, { ...S, coreRadius: 0 }, p);
    const { px, py } = pixelOf(z, x, y, SX, SY);
    expect(rgba(narrow, 512, px, py + 4)[3]).toBeGreaterThan(rgba(wide, 512, px, py + 4)[3]);
    const noHalo = await renderOverlayTile({ z, x, y, mode: 'fog' }, { ...S, halo: 0 }, p);
    expect(rgba(noHalo, 512, px, py + 8)[3]).toBe(204);
    const lighter = await renderOverlayTile({ z, x, y, mode: 'fog' }, { ...S, fogAlpha: 0.5 }, p);
    expect(rgba(lighter, 512, px, py + 120)[3]).toBe(128);
    // widest feather (σ 6 cells = 24 px here): halo reaches further, core still crisp, far still fog
    const widest = await renderOverlayTile({ z, x, y, mode: 'fog' }, { ...S, feather: 6, halo: 0.8 }, p);
    expect(rgba(widest, 512, px, py)[3]).toBeLessThanOrEqual(3);
    expect(rgba(widest, 512, px, py + 32)[3]).toBeLessThan(rgba(wide, 512, px, py + 32)[3]);
    expect(rgba(widest, 512, px, py + 120)[3]).toBe(204);
  });

  it('empty regions are a flat fog tile (fast path) and match the far-field of a rendered tile', async () => {
    const img = await renderOverlayTile({ z, x: x + 50, y: y + 50, mode: 'fog' }, S, p);
    expect(rgba(img, 512, 0, 0)).toEqual([16, 20, 30, 204]);
    expect(rgba(img, 512, 511, 511)).toEqual([16, 20, 30, 204]);
  });

  it('adjacent tiles agree along their shared edge (seamless margin)', async () => {
    // A street crossing the vertical seam at an angle so the edge columns carry gradient.
    const q = new MemoryProvider();
    const cellsPerTile = 2 ** (22 - z);
    const seamX = (x + 1) * cellsPerTile;
    q.line(seamX - 60, HCY - 30, seamX + 60, HCY + 30, 1);
    q.line(seamX - 3, HCY - 60, seamX + 3, HCY + 60, 3);
    // defaults, and the widest feather / strongest halo the settings allow (σ = 6 cells)
    for (const settings of [S, { ...S, feather: 6, halo: 0.8 }]) {
      const left = await renderOverlayTile({ z, x, y, mode: 'fog' }, settings, q);
      const right = await renderOverlayTile({ z, x: x + 1, y, mode: 'fog' }, settings, q);
      const both = await renderOverlayRegion({ level: 14, cx0: x * cellsPerTile, cy0: y * cellsPerTile, cellPx: 4, width: 1024, height: 512, mode: 'fog' }, settings, q);
      let maxDiff = 0;
      for (let py = 0; py < 512; py++) {
        for (let px = 0; px < 1024; px++) {
          const tile = px < 512 ? left : right;
          const a = tile[(py * 512 + (px & 511)) * 4 + 3];
          const b = both[(py * 1024 + px) * 4 + 3];
          maxDiff = Math.max(maxDiff, Math.abs(a - b));
        }
      }
      expect(maxDiff).toBeLessThanOrEqual(2);
    }
    // heat too (different margin/sigmas)
    const hl = await renderOverlayTile({ z, x, y, mode: 'heat' }, S, q);
    const hr = await renderOverlayTile({ z, x: x + 1, y, mode: 'heat' }, S, q);
    const hb = await renderOverlayRegion({ level: 14, cx0: x * cellsPerTile, cy0: y * cellsPerTile, cellPx: 4, width: 1024, height: 512, mode: 'heat' }, S, q);
    let hDiff = 0;
    for (let py = 0; py < 512; py++) for (let px = 0; px < 1024; px++) {
      const tile = px < 512 ? hl : hr;
      for (let c = 0; c < 4; c++) hDiff = Math.max(hDiff, Math.abs(tile[(py * 512 + (px & 511)) * 4 + c] - hb[(py * 1024 + px) * 4 + c]));
    }
    expect(hDiff).toBeLessThanOrEqual(2);
  });

  it('coreRadius 0 still clears the street (σ_narrow follows the 1-cell ribbon) with a narrower core', async () => {
    for (const z of [15, 16]) {
      const t = tileAt(z, SX, SY);
      const { px, py } = pixelOf(z, t.x, t.y, SX, SY);
      const thin = await renderOverlayTile({ z, ...t, mode: 'fog' }, { ...S, coreRadius: 0 }, p);
      const full = await renderOverlayTile({ z, ...t, mode: 'fog' }, S, p);
      expect(rgba(thin, 512, px, py)[3]).toBeLessThanOrEqual(3);
      // count cleared px (alpha ≤ 10) along the column through the street: thinner than the 3-cell core
      const cleared = (img: Uint8ClampedArray): number => { let n = 0; for (let y = 0; y < 512; y++) if (rgba(img, 512, px, y)[3] <= 10) n++; return n; };
      expect(cleared(thin)).toBeGreaterThanOrEqual(4);
      expect(cleared(thin)).toBeLessThan(cleared(full));
    }
  });

  it('high zoom uses the work scale and still clears the street crisply', async () => {
    const t18 = tileAt(18, SX, SY);
    const img = await renderOverlayTile({ z: 18, ...t18, mode: 'fog' }, S, p);
    const { px, py } = pixelOf(18, t18.x, t18.y, SX, SY); // cellPx 32
    expect(rgba(img, 512, px, py)[3]).toBeLessThanOrEqual(3);
    // 6 cells off the street: at 32 px per cell that is beyond the halo — but the tile is only
    // 16 cells tall, so sample whichever side has room
    const off = py + 32 * 6 <= 511 ? py + 32 * 6 : py - 32 * 6;
    expect(rgba(img, 512, px, off)[3]).toBeGreaterThan(150);
    const t256 = await renderOverlayTile({ z: 16, x: t18.x >> 2, y: t18.y >> 2, mode: 'fog', size: 256 }, S, p);
    expect(t256.length).toBe(256 * 256 * 4);
  });

  it('margin covers the blur support', () => {
    for (const sigma of [0.75, 1, 3.6, 14, 16]) expect(Math.ceil(3 * sigma)).toBeGreaterThanOrEqual(blurSupportRadius(sigma));
  });

  it('out-of-range zooms (z > 22, z < 0) render a tile instead of throwing', async () => {
    const hi = await renderOverlayTile({ z: 23, x: SX * 2, y: SY * 2, mode: 'fog' }, S, p);
    expect(hi.length).toBe(512 * 512 * 4);
    expect(rgba(hi, 512, 256, 256)[3]).toBeLessThanOrEqual(3); // the street cell fills the tile
    const lo = await renderOverlayTile({ z: -1, x: 0, y: 0, mode: 'heat' }, S, p);
    expect(lo.length).toBe(512 * 512 * 4);
  });
});

/** Max |Δalpha| between horizontally / vertically adjacent pixels, plus the alpha range. */
function edgeStats(img: Uint8ClampedArray, size: number): { maxD: number; min: number; max: number } {
  let maxD = 0, min = 255, max = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = img[(y * size + x) * 4 + 3];
    if (a < min) min = a;
    if (a > max) max = a;
    if (x + 1 < size) maxD = Math.max(maxD, Math.abs(img[(y * size + x + 1) * 4 + 3] - a));
    if (y + 1 < size) maxD = Math.max(maxD, Math.abs(img[((y + 1) * size + x) * 4 + 3] - a));
  }
  return { maxD, min, max };
}

describe('pixel floor (z ≤ 13: ribbons ≥ 10 px, σ_narrow 3 px)', () => {
  const region = syntheticRegion();
  /** Fog edges never steeper than this per pixel (the z14 look is 90; z16 is 30). */
  const SOFT = 75;

  it('fog edges are soft at every zoom from z6 to z13, with fully cleared and fully fogged pixels in the home tile', async () => {
    for (const z of [6, 8, 9, 10, 11, 12, 13]) {
      const t = tileAt(z, region.cx, region.cy);
      const img = await renderOverlayTile({ z, ...t, mode: 'fog' }, S, region.provider);
      const { maxD, min, max } = edgeStats(img, 512);
      expect(maxD, `z${z} max |Δalpha|`).toBeLessThanOrEqual(SOFT);
      expect(min, `z${z} cleared`).toBeLessThanOrEqual(3);
      expect(max, `z${z} fogged`).toBe(204);
    }
  });

  it('a single walked street is a soft cleared line ≥ 8 px wide at z12 (0.5-px cells) and z9 (1-px level-10 cells)', async () => {
    for (const z of [12, 9]) {
      const q = new MemoryProvider();
      const cellsPerTile = 2 ** (22 - z);
      const t = tileAt(z, HCX, HCY);
      const sy = t.y * cellsPerTile + (cellsPerTile >> 1); // base-cell row through the tile's middle
      q.line(t.x * cellsPerTile - 500, sy, (t.x + 1) * cellsPerTile + 500, sy, 1);
      const img = await renderOverlayTile({ z, ...t, mode: 'fog' }, S, q);
      let cleared = 0, half = 0, maxD = 0, last = -1;
      for (let y = 0; y < 512; y++) {
        const a = rgba(img, 512, 256, y)[3];
        if (a <= 10) cleared++;
        if (a <= 102) half++;
        if (last >= 0) maxD = Math.max(maxD, Math.abs(a - last));
        last = a;
      }
      expect(cleared, `z${z} fully cleared px across the street`).toBeGreaterThanOrEqual(4);
      expect(half, `z${z} half-lifted px across the street`).toBeGreaterThanOrEqual(8);
      expect(half, `z${z} half-lifted px across the street`).toBeLessThanOrEqual(24);
      expect(maxD, `z${z} max |Δalpha| across the street`).toBeLessThanOrEqual(SOFT);
      expect(rgba(img, 512, 256, 40)[3]).toBe(204); // 216 px away: untouched fog
    }
  });

  it('adjacent 512-px renders agree along their shared edge at z12 and z10 (margin covers dilation + floored blur)', async () => {
    for (const z of [12, 10]) {
      const g = tileGeometry(z, 512);
      const per512 = 512 / g.cellPx; // level cells per 512 px
      // a seam through the home neighbourhood: left edge one tile west of the centre
      const f = 2 ** (14 - g.level);
      const cx0 = Math.floor(region.cx / f) - per512, cy0 = Math.floor(region.cy / f) - per512 / 2;
      const left = await renderOverlayRegion({ level: g.level, cx0, cy0, cellPx: g.cellPx, width: 512, height: 512, mode: 'fog' }, S, region.provider);
      const right = await renderOverlayRegion({ level: g.level, cx0: cx0 + per512, cy0, cellPx: g.cellPx, width: 512, height: 512, mode: 'fog' }, S, region.provider);
      const both = await renderOverlayRegion({ level: g.level, cx0, cy0, cellPx: g.cellPx, width: 1024, height: 512, mode: 'fog' }, S, region.provider);
      let maxDiff = 0, lifted = 0;
      for (let py = 0; py < 512; py++) for (let px = 0; px < 1024; px++) {
        const tile = px < 512 ? left : right;
        const a = tile[(py * 512 + (px & 511)) * 4 + 3], b = both[(py * 1024 + px) * 4 + 3];
        maxDiff = Math.max(maxDiff, Math.abs(a - b));
        if ((px === 511 || px === 512) && a < 200) lifted++;
      }
      expect(maxDiff, `z${z} seam`).toBeLessThanOrEqual(2);
      expect(lifted, `z${z} seam crosses data`).toBeGreaterThan(0);
    }
  });

  it('the approved look at z ≥ 14 is unchanged (crc32 snapshot of the synthetic-city tile)', async () => {
    // Regenerate these on an INTENDED look change only: run with PRINT_RENDER_HASHES=1 and paste.
    const { provider } = syntheticCity();
    const hashes: Record<string, number> = {};
    for (const [z, mode] of [[14, 'fog'], [15, 'fog'], [16, 'fog'], [17, 'fog'], [15, 'heat']] as Array<[number, 'fog' | 'heat']>) {
      const t = tileAt(z, HCX, HCY);
      const img = await renderOverlayTile({ z, ...t, mode }, S, provider);
      hashes[`z${z}-${mode}`] = crc32(new Uint8Array(img.buffer, img.byteOffset, img.byteLength));
    }
    if (process.env.PRINT_RENDER_HASHES) console.log(JSON.stringify(hashes)); // eslint-disable-line no-console
    expect(hashes).toEqual(APPROVED_HASHES);
  });
});

describe('heat tile', () => {
  const z = 15;
  it('ramp is monotonic in visit count and the dim layer covers everything else', async () => {
    const p = new MemoryProvider();
    const { x, y } = tileAt(z, HCX, HCY);
    const centres: Array<[number, number, number]> = [];
    for (let c = 1; c <= 8; c++) {
      // eight short segments across the tile's middle row, 13 cells apart, counts 1…8
      const cx = x * 128 + 8 + c * 13, cy = y * 128 + 64;
      p.line(cx - 4, cy, cx + 4, cy, c);
      centres.push([cx, cy, c]);
    }
    const img = await renderOverlayTile({ z, x, y, mode: 'heat' }, S, p);
    // The ramp itself: alpha rises with intensity, and green falls once the glow is visible
    // (below 0.08 the colour is irrelevant: alpha 0).
    const lut = heatRampLut();
    for (let i = 1; i < 1024; i++) {
      expect(lut[i * 4 + 3]).toBeGreaterThanOrEqual(lut[(i - 1) * 4 + 3]);
      if (lut[(i - 1) * 4 + 3] > 0) expect(lut[i * 4 + 1]).toBeLessThanOrEqual(lut[(i - 1) * 4 + 1]);
    }
    expect(lut[3]).toBe(0);
    expect(lut[1023 * 4 + 3]).toBe(1);
    // Composited over the dim layer, "redness" (R−G) and alpha grow with the visit count. (The
    // green channel alone is not monotonic: the amber glow gets opaque faster than it reddens.)
    let lastRed = -1, lastA = -1, lastG = 255;
    for (const [cx, cy] of centres) {
      const { px, py } = pixelOf(z, x, y, cx, cy);
      const [r, g, , a] = rgba(img, 512, px, py);
      expect(r).toBeGreaterThan(180);
      expect(r - g).toBeGreaterThanOrEqual(lastRed);
      expect(a).toBeGreaterThanOrEqual(lastA);
      lastRed = r - g; lastA = a; lastG = g;
    }
    expect(lastG).toBeLessThan(120); // 8 visits reads red/hot
    const dim = rgba(img, 512, 5, 5);
    expect(dim).toEqual([12, 15, 24, Math.round(0.68 * 255)]);
    const empty = await renderOverlayTile({ z, x: x + 40, y, mode: 'heat' }, S, p);
    expect(rgba(empty, 512, 100, 100)).toEqual([12, 15, 24, 173]);
  });
});

describe('render performance', () => {
  it('renders a synthetic city tile at z12 / z15 / z17 well under budget', async () => {
    const { provider } = syntheticCity();
    const results: Record<string, number> = {};
    const cases: Array<[number, 'fog' | 'heat', RenderSettings, string]> = [
      [8, 'fog', S, 'z8-fog'], [10, 'fog', S, 'z10-fog'], [12, 'fog', S, 'z12-fog'], [13, 'fog', S, 'z13-fog'],
      [15, 'fog', S, 'z15-fog'], [17, 'fog', S, 'z17-fog'], [15, 'heat', S, 'z15-heat'], [12, 'heat', S, 'z12-heat'],
      [15, 'fog', { ...S, feather: 6, halo: 0.8 }, 'z15-fog-feather6'],
    ];
    for (const [z, mode, settings, label] of cases) {
      const t = tileAt(z, HCX, HCY);
      await renderOverlayTile({ z, ...t, mode }, settings, provider); // warm-up (JIT + overview cache)
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await renderOverlayTile({ z, ...t, mode }, settings, provider);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      results[label] = Math.round(times[2] * 10) / 10;
    }
    // eslint-disable-next-line no-console
    console.log('render timings (median of 5, ms):', JSON.stringify(results));
    expect(results['z15-fog']).toBeLessThan(50);
    expect(results['z12-fog']).toBeLessThan(100);
    expect(results['z13-fog']).toBeLessThan(100);
    expect(results['z10-fog']).toBeLessThan(100);
    expect(results['z8-fog']).toBeLessThan(100);
    expect(results['z12-heat']).toBeLessThan(100);
    expect(results['z17-fog']).toBeLessThan(50);
    expect(results['z15-heat']).toBeLessThan(50);
    expect(results['z15-fog-feather6']).toBeLessThan(50);
  });
});
