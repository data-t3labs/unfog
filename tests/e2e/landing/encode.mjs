/**
 * Derive the landing-site images in welcome/img/ from the PNG masters captured by capture.mjs.
 * Uses headless Chromium's canvas encoders (no sharp/imagemagick needed): WebP for browsers that
 * take it, JPEG as the <picture> fallback.
 *
 *   node tests/e2e/landing/encode.mjs <masters-dir>
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const src = path.resolve(process.argv[2] ?? path.join(here, 'out'));
const out = path.join(repo, 'welcome/img');
fs.mkdirSync(out, { recursive: true });

const executablePath =
  process.env.PW_CHROMIUM ??
  path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1237/chrome-headless-shell-mac-arm64/chrome-headless-shell');

// name, output width (px), webp quality, jpeg quality
const JOBS = [
  ['fog', 786, 0.8, 0.8],
  ['heat', 786, 0.8, 0.8],
  ['route', 786, 0.8, 0.8],
  ['data', 786, 0.82, 0.82],
  ['help-export', 786, 0.82, 0.82],
  ['help-install', 786, 0.82, 0.82],
  ['stats', 786, 0.82, 0.82],
  ['fog-wide', 1600, 0.76, 0.78],
];

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
const rows = [];
for (const [name, width, qw, qj] of JOBS) {
  const master = path.join(src, `${name}.png`);
  if (!fs.existsSync(master)) {
    console.warn(`skip ${name}: no master`);
    continue;
  }
  const dataUrl = `data:image/png;base64,${fs.readFileSync(master).toString('base64')}`;
  const res = await page.evaluate(
    async ({ dataUrl, width, qw, qj }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const scale = width / img.naturalWidth;
      const c = document.getElementById('c');
      c.width = width;
      c.height = Math.round(img.naturalHeight * scale);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      return { w: c.width, h: c.height, webp: c.toDataURL('image/webp', qw), jpeg: c.toDataURL('image/jpeg', qj) };
    },
    { dataUrl, width, qw, qj },
  );
  const write = (ext, url) => {
    const bytes = Buffer.from(url.split(',')[1], 'base64');
    fs.writeFileSync(path.join(out, `${name}.${ext}`), bytes);
    return bytes.length;
  };
  const webp = write('webp', res.webp);
  const jpg = write('jpg', res.jpeg);
  rows.push({ name, size: `${res.w}×${res.h}`, webpKB: Math.round(webp / 1024), jpgKB: Math.round(jpg / 1024) });
}
await browser.close();
console.table(rows);
console.log(`total webp: ${rows.reduce((a, r) => a + r.webpKB, 0)} KB · total jpg: ${rows.reduce((a, r) => a + r.jpgKB, 0)} KB → ${out}`);
