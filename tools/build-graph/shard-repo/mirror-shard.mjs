#!/usr/bin/env node
/**
 * Mirror this shard's routing-graph packs from the Unfog release into a GitHub Pages site.
 *
 * Runs in this repo's mirror.yml on a GitHub runner (plain Node ≥ 20, no dependencies):
 *   1. reads the shard plan (tools/build-graph/pages-shards.json on data-t3labs/unfog main) and the
 *      release packs-index.json; picks its own cells by --shard (= the repository name);
 *   2. compares them with the index this site already serves (<base>index.json): if every cell's
 *      bytes + sha256 already match, writes `changed=false` to $GITHUB_OUTPUT and stops (nothing to
 *      deploy) unless --force;
 *   3. downloads each pack with curl (retries), checks size and sha256 against the index (exit 1 on a
 *      mismatch), writes <out>/packs/<name>.ufp, <out>/packs/index.json (this shard's cells, a valid
 *      partial packs-index with URLs under this site), <out>/index.html and <out>/.nojekyll;
 *   4. writes `changed=true` so the workflow uploads <out> as the Pages artifact.
 *
 *   node mirror-shard.mjs --shard unfog-graph-1 [--out site] [--force]
 *        [--plan <url>] [--index <url>] [--release graphs-v1] [--repo data-t3labs/unfog]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const flags = new Set(['force']);
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  args[k] = flags.has(k) ? true : process.argv[++i];
}
const shard = args.shard;
if (!shard) { console.error('mirror-shard: --shard <repo name> is required'); process.exit(1); }
const out = args.out ?? 'site';
const repo = args.repo ?? 'data-t3labs/unfog';
const release = args.release ?? 'graphs-v1';
const bust = `?t=${Date.now()}`;
const planUrl = args.plan ?? `https://raw.githubusercontent.com/${repo}/main/tools/build-graph/pages-shards.json${bust}`;
const indexUrl = args.index ?? `https://github.com/${repo}/releases/download/${release}/packs-index.json`;
const appUrl = 'https://data-t3labs.github.io/unfog/';

const fail = (msg) => { console.error(`mirror-shard: ${msg}`); process.exit(1); };
const setOutput = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); console.error(`mirror-shard: output ${k}=${v}`); };
const curl = (url, file) => execFileSync('curl', ['-sSL', '--fail', '--retry', '5', '--retry-delay', '10', '--retry-all-errors', '-o', file, url], { stdio: ['ignore', 'inherit', 'inherit'] });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function getJson(url, { optional = false } = {}) {
  if (!/^https?:\/\//.test(url)) return JSON.parse(readFileSync(url, 'utf8')); // local file (tests)
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
      if (r.status === 404 && optional) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      console.error(`mirror-shard: GET ${url} failed (attempt ${attempt}): ${e.message}`);
      if (attempt === 4) { if (optional) return null; throw e; }
      await new Promise((res) => setTimeout(res, 5000 * attempt));
    }
  }
  return null;
}

const plan = await getJson(planUrl);
const mine = plan?.shards?.[shard];
if (!mine) fail(`shard "${shard}" is not in the plan (${planUrl}); known: ${Object.keys(plan?.shards ?? {}).join(', ') || 'none'} — add it to pages-shards.json in ${repo} and push`);
const index = await getJson(indexUrl);
if (!index?.packs) fail(`${indexUrl} is not a packs-index`);
const base = mine.base ?? `https://data-t3labs.github.io/${shard}/packs/`;

const wanted = [];
for (const cell of mine.cells ?? []) {
  const info = index.packs[cell];
  if (!info) fail(`cell ${cell} is assigned to ${shard} but missing from the release index — re-run the shard planner in ${repo}`);
  wanted.push({ cell, info, name: info.url.split('/').pop() });
}
const total = wanted.reduce((n, w) => n + w.info.bytes, 0);
console.error(`mirror-shard: ${shard}: ${wanted.length} cells, ${(total / 1e6).toFixed(1)} MB, base ${base}`);

const live = await getJson(`${base}index.json${bust}`, { optional: true });
const same = live?.packs && wanted.length === Object.keys(live.packs).length && wanted.every((w) => { const l = live.packs[w.cell]; return l && l.bytes === w.info.bytes && l.sha256 === w.info.sha256; });
if (same && !args.force) {
  console.error(`mirror-shard: the site already serves exactly these ${wanted.length} packs (bytes + sha256 match); nothing to deploy`);
  setOutput('changed', 'false');
  process.exit(0);
}

const packsDir = join(out, 'packs');
mkdirSync(packsDir, { recursive: true });
const packs = {};
let i = 0;
for (const w of wanted) {
  const file = join(packsDir, w.name);
  const url = `https://github.com/${repo}/releases/download/${release}/${w.name}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!existsSync(file) || statSync(file).size !== w.info.bytes) curl(url, file);
    const size = statSync(file).size;
    if (size !== w.info.bytes) { if (attempt === 2) fail(`${w.name} is ${size} B, expected ${w.info.bytes} B`); execFileSync('rm', ['-f', file]); continue; }
    if (w.info.sha256) { const h = sha256(file); if (h !== w.info.sha256) { if (attempt === 2) fail(`${w.name} sha256 ${h} ≠ index ${w.info.sha256}`); execFileSync('rm', ['-f', file]); continue; } }
    break;
  }
  packs[w.cell] = { ...w.info, url: base + w.name };
  console.error(`mirror-shard: ${++i}/${wanted.length} ${w.cell} ${w.name} ${(w.info.bytes / 1e6).toFixed(1)} MB`);
}

const mirroredAt = new Date().toISOString();
writeFileSync(join(packsDir, 'index.json'), JSON.stringify({ version: index.version, zoom: index.zoom, packZoom: index.packZoom, builtAt: index.builtAt, release, shard, base, mirroredAt, mirrorOf: indexUrl, packs }, null, 1) + '\n');
writeFileSync(join(out, '.nojekyll'), '');
writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>${shard}</title><p>Routing-graph packs for <a href="${appUrl}">Unfog</a> (shard ${shard}: ${wanted.length} cells, ${(total / 1e6).toFixed(0)} MB, mirrored ${mirroredAt}) — map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, ODbL. Listing: <a href="packs/index.json">packs/index.json</a>.</p>\n`);
console.error(`mirror-shard: ${wanted.length} packs, ${(total / 1e6).toFixed(1)} MB → ${out}/ (index ${packsDir}/index.json)`);
setOutput('changed', 'true');
