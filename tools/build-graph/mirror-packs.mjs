#!/usr/bin/env node
/**
 * Emit the packs-index the app reads (coverage v2 hosting) — and, optionally, mirror a few packs
 * into the app's own Pages site.
 *
 * GitHub release assets serve byte ranges but no CORS headers, so the app cannot read them
 * directly; GitHub Pages on the app's origin can (Range → 206, same origin). The full continent
 * (≈ 3.5 GB) lives on sibling Pages sites of the same account (`unfog-graph-N`, each ≤ 900 MB,
 * deployed by their own mirror workflow from tools/build-graph/shard-repo/); which cell lives where
 * is tools/build-graph/pages-shards.json (shard-plan.mjs). This script runs in the deploy workflow
 * after `npm run build`: it downloads the release packs-index.json, rewrites every cell's `url` to
 * its shard, mirrors the cells listed in tools/build-graph/pages-mirror.json (normally none) from the
 * release into --out with curl, and writes --out/packs-index.json. Plain Node, no dependencies.
 *
 *   node tools/build-graph/mirror-packs.mjs [--release graphs-v1] [--repo data-t3labs/unfog]
 *        [--out dist/graph/packs] [--base https://data-t3labs.github.io/unfog/graph/packs/]
 *        [--cells tools/build-graph/pages-mirror.json] [--shards tools/build-graph/pages-shards.json]
 *        [--max-mb 950] [--check]
 * --check: after writing the index, HEAD every shard URL (16 at a time) and compare content-length
 * with the index; exit 1 on any mismatch or non-200 (a shard that has not deployed yet → 404).
 * Exit 1 when a download fails or the local mirror would exceed --max-mb (GitHub Pages sites should
 * stay under 1 GB): the deploy must fail loudly rather than publish a broken index.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const flags = new Set(['check']);
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  args[k] = flags.has(k) ? true : process.argv[++i];
}
const release = args.release ?? 'graphs-v1';
const repo = args.repo ?? 'data-t3labs/unfog';
const out = args.out ?? 'dist/graph/packs';
const base = args.base ?? 'https://data-t3labs.github.io/unfog/graph/packs/';
const cellsFile = args.cells ?? join(here, 'pages-mirror.json');
const shardsFile = args.shards ?? join(here, 'pages-shards.json');
const maxBytes = Number(args['max-mb'] ?? 950) * 1e6;
const dl = (name) => `https://github.com/${repo}/releases/download/${release}/${name}`;

mkdirSync(out, { recursive: true });
const curl = (url, file) => execFileSync('curl', ['-sSL', '--fail', '--retry', '5', '--retry-delay', '5', '-o', file, url], { stdio: ['ignore', 'inherit', 'inherit'] });

const indexFile = join(out, 'packs-index.release.json');
curl(dl('packs-index.json'), indexFile);
const index = JSON.parse(readFileSync(indexFile, 'utf8'));
const wanted = existsSync(cellsFile) ? JSON.parse(readFileSync(cellsFile, 'utf8')) : null;
const mirrorCells = Array.isArray(wanted?.cells) ? wanted.cells : [];
const plan = existsSync(shardsFile) ? JSON.parse(readFileSync(shardsFile, 'utf8')) : { shards: {} };

// cell → shard URL (pages-shards.json)
const shardUrl = new Map();
const shardOf = new Map();
for (const [name, s] of Object.entries(plan.shards ?? {})) {
  for (const cell of s.cells ?? []) {
    const info = index.packs[cell];
    if (!info) { console.error(`mirror-packs: ${name} lists ${cell}, which is not in the release index (re-run shard-plan.mjs)`); continue; }
    shardUrl.set(cell, (s.base ?? `https://data-t3labs.github.io/${name}/packs/`) + info.url.split('/').pop());
    shardOf.set(cell, name);
  }
}

// cells mirrored into THIS site (pages-mirror.json) — their URL wins over the shard's
const mirrored = new Map();
let total = 0;
for (const cell of mirrorCells) {
  const info = index.packs[cell];
  if (!info) { console.error(`mirror-packs: cell ${cell} is not in the release index; skipped`); continue; }
  const name = info.url.split('/').pop();
  const file = join(out, name);
  if (!existsSync(file) || statSync(file).size !== info.bytes) curl(dl(name), file);
  if (statSync(file).size !== info.bytes) { console.error(`mirror-packs: ${name} is ${statSync(file).size} B, expected ${info.bytes}`); process.exit(1); }
  mirrored.set(cell, base + name);
  total += info.bytes;
  console.error(`mirror-packs: mirrored ${cell} ${name} ${(info.bytes / 1e6).toFixed(1)} MB (${info.tiles} tiles)`);
}
if (total > maxBytes) { console.error(`mirror-packs: ${(total / 1e6).toFixed(0)} MB exceeds the ${(maxBytes / 1e6).toFixed(0)} MB Pages budget — move cells to a shard (docs/coverage-runbook.md § Hosting)`); process.exit(1); }

const packs = {};
const perShard = {};
let unhosted = 0;
for (const [cell, info] of Object.entries(index.packs)) {
  const url = mirrored.get(cell) ?? shardUrl.get(cell);
  if (!url) { unhosted++; console.error(`mirror-packs: WARNING ${cell} is in no shard and not mirrored; its URL stays on the release, which the app cannot read`); }
  packs[cell] = { ...info, url: url ?? info.url };
  const s = mirrored.has(cell) ? 'this site' : shardOf.get(cell) ?? 'release';
  perShard[s] = (perShard[s] ?? 0) + 1;
}
writeFileSync(join(out, 'packs-index.json'), JSON.stringify({ ...index, packs, mirroredAt: new Date().toISOString(), mirrorOf: dl('packs-index.json'), shardsUpdatedAt: plan.updatedAt }, null, 1) + '\n');
execFileSync('rm', ['-f', indexFile]);
console.error(`mirror-packs: ${Object.keys(packs).length} cells → ${out}/packs-index.json: ${Object.entries(perShard).map(([k, n]) => `${k} ${n}`).join(', ')}${mirrored.size ? ` (${(total / 1e6).toFixed(1)} MB mirrored here)` : ''}`);
if (unhosted) console.error(`mirror-packs: ${unhosted} cells unhosted — run node tools/build-graph/shard-plan.mjs and the shard workflows`);

if (args.check) {
  const t0 = Date.now();
  const todo = [...shardUrl].map(([cell, url]) => ({ cell, url, bytes: index.packs[cell].bytes }));
  const bad = [];
  // Accept-Encoding: identity — Node's fetch asks for gzip and Pages then reports the COMPRESSED length.
  const head = async ({ cell, url, bytes }) => {
    let r;
    try { r = await fetch(url, { method: 'HEAD', cache: 'no-store', headers: { 'accept-encoding': 'identity' } }); } catch (e) { bad.push(`${cell} ${url}: ${e.message}`); return; }
    const len = Number(r.headers.get('content-length'));
    if (r.status !== 200) bad.push(`${cell} ${url}: HTTP ${r.status}`);
    else if (len !== bytes) bad.push(`${cell} ${url}: content-length ${len} ≠ index ${bytes}`);
  };
  for (let i = 0; i < todo.length; i += 16) await Promise.all(todo.slice(i, i + 16).map(head));
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  for (const b of bad) console.error(`mirror-packs --check: ${b}`);
  console.error(`mirror-packs --check: ${todo.length} shard URLs, ${todo.length - bad.length} ok, ${bad.length} bad, ${s} s`);
  if (bad.length || unhosted) process.exit(1);
}
