/**
 * Fast Gaussian-approximating blur for Float32 fields: three successive box blurs, each
 * separable (horizontal then vertical running sums), edge-clamped. Three boxes whose widths are
 * chosen by `boxesForGauss` approximate a Gaussian of the requested σ to within a few percent
 * (Kutskir's method — the standard "fast Gaussian blur" used by image libraries). Pure typed-array
 * code: no DOM, no canvas filters, runs in a worker on iOS and in Node tests.
 *
 * Cost: 6 passes over the field, O(width·height) each, independent of σ. No allocation inside
 * loops — two scratch buffers of the field's size (caller may supply them for reuse).
 */

/**
 * Box widths (odd, ≥1) for `n` successive box blurs approximating a Gaussian of `sigma`.
 * The first `m` boxes use the smaller width wl, the rest wl+2, chosen so the variance of the
 * composite (Σ (w²−1)/12) matches σ² as closely as possible.
 */
export function boxesForGauss(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/** Total half-width of the ×3 box-blur kernel (the blur's exact support radius) for a σ. */
export function blurSupportRadius(sigma: number): number {
  if (sigma <= 0) return 0;
  let r = 0;
  for (const w of boxesForGauss(sigma, 3)) r += (w - 1) >> 1;
  return r;
}

/**
 * Gaussian-approximating blur of `src` (row-major width×height). Returns the blurred field in
 * `out` (allocated if not given). `src` is not modified. `tmp` is scratch of the same size.
 * σ ≤ 0 copies. Values are computed in double precision and stored as float32.
 */
export function gaussianBlur(
  src: Float32Array,
  width: number,
  height: number,
  sigma: number,
  out?: Float32Array,
  tmp?: Float32Array,
): Float32Array {
  const n = width * height;
  if (src.length < n) throw new Error(`gaussianBlur: field has ${src.length} values, need ${n}`);
  const o = out && out.length >= n ? out : new Float32Array(n);
  const t = tmp && tmp.length >= n ? tmp : new Float32Array(n);
  const radii = sigma > 0 ? boxesForGauss(sigma, 3).map((w) => (w - 1) >> 1) : [0, 0, 0];
  if (radii[0] === 0 && radii[1] === 0 && radii[2] === 0) {
    o.set(src.subarray(0, n));
    return o;
  }
  // Pass 1 reads src, passes 2–3 read o; each pass = H(src→t) then V(t→o).
  boxBlurH(src, t, width, height, radii[0]);
  boxBlurV(t, o, width, height, radii[0]);
  for (let i = 1; i < 3; i++) {
    boxBlurH(o, t, width, height, radii[i]);
    boxBlurV(t, o, width, height, radii[i]);
  }
  return o;
}

/**
 * Horizontal box blur of radius r (window 2r+1) with edge clamping: samples beyond a row's ends
 * take the end value, so a constant field stays constant. Running sum: O(1) per pixel.
 */
export function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  if (r <= 0) { dst.set(src.subarray(0, w * h)); return; }
  const iarr = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const fv = src[row], lv = src[row + w - 1];
    // Window centred on x=0: r clamped copies of fv on the left + cells 0..r on the right.
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[row + Math.min(j, w - 1)];
    for (let x = 0; x < w; x++) {
      const add = x + r < w ? src[row + x + r] : lv;
      const sub = x - r - 1 >= 0 ? src[row + x - r - 1] : fv;
      val += add - sub;
      dst[row + x] = val * iarr;
    }
  }
}

/** Vertical counterpart of boxBlurH (column running sums; strided access, same clamping). */
export function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  if (r <= 0) { dst.set(src.subarray(0, w * h)); return; }
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
}
