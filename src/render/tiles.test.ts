import { describe, expect, it } from 'vitest';
import { MemoryProvider, syntheticCity } from '../../tests/fixtures/grid/synthetic';
import { DEFAULT_RENDER_SETTINGS, type RenderSettings } from '../grid/api';
import { lonLatToCell } from '../grid/cell';
import { levelForZoom } from '../grid/types';
import { blurSupportRadius } from './blur';
import { heatRampLut, renderOverlayRegion, renderOverlayTile, tileGeometry } from './tiles';

const S: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };
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

  it('low zoom (cellPx < 1) and overview levels render without the narrow pass', async () => {
    const { provider } = syntheticCity();
    const t12 = tileAt(12, HCX, HCY);
    const img12 = await renderOverlayTile({ z: 12, ...t12, mode: 'fog' }, S, provider);
    const { px, py } = pixelOf(12, t12.x, t12.y, HCX, HCY);
    expect(rgba(img12, 512, px, py)[3]).toBeLessThan(150); // explored neighbourhood is lifted
    expect(rgba(img12, 512, 2, 2)[3]).toBe(204); // corner of the tile: nothing there
    const t10 = tileAt(10, HCX, HCY); // level 10 overview, cellPx 2
    const img10 = await renderOverlayTile({ z: 10, ...t10, mode: 'fog' }, S, provider);
    const c10 = pixelOf(10, t10.x, t10.y, HCX, HCY);
    expect(rgba(img10, 512, c10.px, c10.py)[3]).toBeLessThan(204);
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
      [12, 'fog', S, 'z12-fog'], [15, 'fog', S, 'z15-fog'], [17, 'fog', S, 'z17-fog'], [15, 'heat', S, 'z15-heat'],
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
    expect(results['z17-fog']).toBeLessThan(50);
    expect(results['z15-heat']).toBeLessThan(50);
    expect(results['z15-fog-feather6']).toBeLessThan(50);
  });
});
