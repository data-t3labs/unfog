import { describe, expect, it } from 'vitest';
import { blurSupportRadius, boxBlurV, boxesForGauss, gaussianBlur } from './blur';

function field(w: number, h: number, fill: (x: number, y: number) => number): Float32Array {
  const f = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = fill(x, y);
  return f;
}

describe('gaussianBlur', () => {
  it('boxesForGauss returns odd widths whose composite variance matches σ²', () => {
    for (const sigma of [0.75, 1.5, 3.6, 14, 56]) {
      const sizes = boxesForGauss(sigma, 3);
      expect(sizes).toHaveLength(3);
      let variance = 0;
      for (const w of sizes) { expect(w % 2).toBe(1); variance += (w * w - 1) / 12; }
      // box widths are odd integers, so small σ is quantised (σ=0.75 → boxes 1,1,3 → σ_eff 0.82;
      // σ=1.5 → 3,3,3 → 1.41)
      expect(Math.abs(Math.sqrt(variance) - sigma) / sigma).toBeLessThan(0.1);
      expect(blurSupportRadius(sigma)).toBeLessThan(3 * sigma);
    }
  });

  it('the row-major vertical pass is bit-identical to the column-wise running sum it replaced', () => {
    // Reference: the original column-by-column form (perf-1 rewrote boxBlurV to walk rows).
    const ref = (src: Float32Array, w: number, h: number, r: number): Float32Array => {
      const dst = new Float32Array(w * h);
      const iarr = 1 / (2 * r + 1);
      for (let x = 0; x < w; x++) {
        const fv = src[x], lv = src[(h - 1) * w + x];
        let val = (r + 1) * fv;
        for (let j = 0; j < r; j++) val += src[Math.min(j, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          const add = y + r < h ? src[(y + r) * w + x] : lv;
          const sub = y - r - 1 >= 0 ? src[(y - r - 1) * w + x] : fv;
          val += add - sub;
          dst[y * w + x] = val * iarr;
        }
      }
      return dst;
    };
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (const [w, h, r] of [[37, 23, 1], [64, 64, 5], [100, 9, 12], [7, 50, 3]]) {
      const f = field(w, h, () => (rnd() < 0.3 ? 0 : rnd()));
      const dst = new Float32Array(w * h);
      boxBlurV(f, dst, w, h, r);
      expect(Array.from(dst), `${w}×${h} r=${r}`).toEqual(Array.from(ref(f, w, h, r)));
    }
  });

  it('keeps a constant field constant (edge clamping) and σ=0 copies', () => {
    const f = field(40, 30, () => 0.37);
    const out = gaussianBlur(f, 40, 30, 5);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.37, 5);
    const id = gaussianBlur(f, 40, 30, 0);
    expect(Array.from(id)).toEqual(Array.from(f));
  });

  it('preserves the mass of an interior impulse and spreads it symmetrically', () => {
    const w = 64, h = 64;
    const f = field(w, h, (x, y) => (x === 32 && y === 32 ? 1 : 0));
    const out = gaussianBlur(f, w, h, 3);
    let sum = 0;
    for (let i = 0; i < out.length; i++) sum += out[i];
    expect(sum).toBeCloseTo(1, 4);
    expect(out[32 * w + 32]).toBeGreaterThan(out[32 * w + 34]);
    expect(out[32 * w + 34]).toBeCloseTo(out[32 * w + 30], 6);
    expect(out[34 * w + 32]).toBeCloseTo(out[32 * w + 34], 6);
    // ≈ Gaussian: value at 1σ from the centre relative to the peak ≈ e^(−1/2)
    expect(out[32 * w + 35] / out[32 * w + 32]).toBeCloseTo(Math.exp(-0.5), 1);
    // nothing beyond the support radius
    const r = blurSupportRadius(3);
    expect(out[32 * w + 32 + r + 1]).toBe(0);
    expect(out[32 * w + 32 + r]).toBeGreaterThan(0);
  });

  it('does not modify the source and reuses supplied buffers', () => {
    const f = field(16, 16, (x) => x / 16);
    const copy = Float32Array.from(f);
    const out = new Float32Array(256), tmp = new Float32Array(256);
    const res = gaussianBlur(f, 16, 16, 2, out, tmp);
    expect(res).toBe(out);
    expect(Array.from(f)).toEqual(Array.from(copy));
  });
});
