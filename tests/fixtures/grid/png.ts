/**
 * Minimal PNG writer for test previews (RGBA 8-bit, one IDAT, no filtering). Node only — the
 * previews are written by scratch/preview tests, never by app code.
 */
import { deflateSync } from 'node:zlib';
import { crc32 } from '../../../src/grid/backup';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1); out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width); v.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = new Uint8Array(deflateSync(raw, { level: 6 }));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Composite straight-alpha RGBA over a flat background colour → opaque RGBA. */
export function compositeOver(rgba: Uint8ClampedArray, bg: [number, number, number]): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let o = 0; o < rgba.length; o += 4) {
    const a = rgba[o + 3] / 255;
    out[o] = rgba[o] * a + bg[0] * (1 - a);
    out[o + 1] = rgba[o + 1] * a + bg[1] * (1 - a);
    out[o + 2] = rgba[o + 2] * a + bg[2] * (1 - a);
    out[o + 3] = 255;
  }
  return out;
}
