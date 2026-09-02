// Rasterise public/icons/icon.svg into the PNGs the manifest and index.html reference.
// Usage: node tests/e2e/make-icons.mjs   (needs the Playwright Chromium headless shell; override with PW_CHROMIUM)
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'public/icons');
const svg = fs.readFileSync(path.join(outDir, 'icon.svg'), 'utf8');
const executablePath =
  process.env.PW_CHROMIUM ??
  path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1237/chrome-headless-shell-mac-arm64/chrome-headless-shell');

// [file, size, content scale] — maskable keeps the artwork inside the 80 % safe zone on a solid navy field.
const targets = [
  ['apple-touch-icon.png', 180, 1],
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-512-maskable.png', 512, 0.8],
];

const browser = await chromium.launch({ executablePath: fs.existsSync(executablePath) ? executablePath : undefined });
try {
  for (const [name, size, scale] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const inner = Math.round(size * scale);
    const off = Math.round((size - inner) / 2);
    const html = `<!doctype html><html><body style="margin:0;background:#10141e;width:${size}px;height:${size}px;overflow:hidden">
      <div style="position:absolute;left:${off}px;top:${off}px;width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg style="width:${inner}px;height:${inner}px;display:block" `)}</div></body></html>`;
    await page.setContent(html);
    await page.waitForTimeout(100);
    const file = path.join(outDir, name);
    await page.screenshot({ path: file, type: 'png', clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', path.relative(root, file), `${size}x${size}`, fs.statSync(file).size, 'bytes');
    await page.close();
  }
} finally {
  await browser.close();
}
