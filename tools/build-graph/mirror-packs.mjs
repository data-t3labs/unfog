#!/usr/bin/env node
/**
 * Mirror routing graph packs from the GitHub release into the Pages deploy (coverage v2).
 *
 * GitHub release assets serve byte ranges but no CORS headers, so the app cannot read them
 * directly; GitHub Pages on the app's origin can (Range → 206, same origin). This script runs in
 * the deploy workflow after `npm run build`: it downloads the packs listed in
 * tools/build-graph/pages-mirror.json from the release with curl and writes them plus a
 * packs-index.json whose URLs point at the Pages location into dist/graph/packs/. Plain Node, no
 * dependencies, no bundling (CI runs it directly).
 *
 *   node tools/build-graph/mirror-packs.mjs [--release graphs-v1] [--repo data-t3labs/unfog]
 *        [--out dist/graph/packs] [--base https://data-t3labs.github.io/unfog/graph/packs/]
 *        [--cells tools/build-graph/pages-mirror.json] [--max-mb 950]
 * Exit 1 when a download fails or the mirror would exceed --max-mb (GitHub Pages sites should stay
 * under 1 GB): the deploy must fail loudly rather than publish a broken index.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => { if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]); return acc; }, []));
const release = args.release ?? 'graphs-v1';
const repo = args.repo ?? 'data-t3labs/unfog';
const out = args.out ?? 'dist/graph/packs';
const base = args.base ?? 'https://data-t3labs.github.io/unfog/graph/packs/';
const cellsFile = args.cells ?? 'tools/build-graph/pages-mirror.json';
const maxBytes = Number(args['max-mb'] ?? 950) * 1e6;
const dl = (name) => `https://github.com/${repo}/releases/download/${release}/${name}`;

mkdirSync(out, { recursive: true });
const curl = (url, file) => execFileSync('curl', ['-sSL', '--fail', '--retry', '5', '--retry-delay', '5', '-o', file, url], { stdio: ['ignore', 'inherit', 'inherit'] });

const indexFile = join(out, 'packs-index.release.json');
curl(dl('packs-index.json'), indexFile);
const index = JSON.parse(readFileSync(indexFile, 'utf8'));
const wanted = existsSync(cellsFile) ? JSON.parse(readFileSync(cellsFile, 'utf8')) : null;
const cells = Array.isArray(wanted?.cells) ? wanted.cells : Object.keys(index.packs);

const packs = {};
let total = 0;
for (const cell of cells) {
  const info = index.packs[cell];
  if (!info) { console.error(`mirror-packs: cell ${cell} is not in the release index; skipped`); continue; }
  const name = info.url.split('/').pop();
  const file = join(out, name);
  if (!existsSync(file) || statSync(file).size !== info.bytes) curl(dl(name), file);
  if (statSync(file).size !== info.bytes) { console.error(`mirror-packs: ${name} is ${statSync(file).size} B, expected ${info.bytes}`); process.exit(1); }
  packs[cell] = { ...info, url: base + name };
  total += info.bytes;
  console.error(`mirror-packs: ${cell} ${name} ${(info.bytes / 1e6).toFixed(1)} MB (${info.tiles} tiles)`);
}
if (total > maxBytes) { console.error(`mirror-packs: ${(total / 1e6).toFixed(0)} MB exceeds the ${(maxBytes / 1e6).toFixed(0)} MB Pages budget — shard the packs (docs/coverage-runbook.md)`); process.exit(1); }
writeFileSync(join(out, 'packs-index.json'), JSON.stringify({ ...index, packs, mirroredAt: new Date().toISOString(), mirrorOf: dl('packs-index.json') }, null, 1) + '\n');
execFileSync('rm', ['-f', indexFile]);
console.error(`mirror-packs: ${Object.keys(packs).length} packs, ${(total / 1e6).toFixed(1)} MB → ${out}/packs-index.json (urls under ${base})`);
