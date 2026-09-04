/**
 * build-continent — resumable driver for coverage v2 (docs/coverage-runbook.md).
 *
 *   node tools/build-graph/dist/continent.js <cmd> [--continent north-america] [--work <dir>] [--only id,id] [--jobs N]
 *
 *   fetch     download Geofabrik extracts (resume + md5) into tools/build-graph/cache/geofabrik/
 *   build     per extract: spawn cli.js → <work>/extracts/<slug>/ (z12 tiles + manifest); logs download/build s, tiles, MB
 *   borders   plan border tiles across the built extracts, then per extract write the ways that feed
 *             each border cell's rebuild → <work>/borders/<cell>/<slug>.json (child processes)
 *   merge     per border cell: union the ways of every contributing extract, rebuild, keep the cell's
 *             rebuild tiles → <work>/merged/<cell>/
 *   pack      z6 packs (<work>/packs/6-<x>-<y>.ufp) + packs-index.json; merged tiles override extract tiles;
 *             then `regions`
 *   regions   src/routing/pack-regions.json — the Data screen's region table (name / country / bbox per
 *             extract, a z10 dominance grid per multi-extract cell) from the extract manifests
 *             (region-table.ts); commit it with the pack run it belongs to
 *   publish   upload packs + packs-index.json as assets of one GitHub release (gh CLI)
 *   mirror    re-plan tools/build-graph/pages-shards.json from the published index (commit + push it
 *             when it changed), trigger every unfog-graph-N shard workflow (gh), wait for the runs
 *             (unless --no-wait) and verify each shard site with HTTP; state.shards records the result
 *   all       fetch → build → borders → merge → pack (→ publish → mirror with --publish)
 *   status    print the state file summary
 * Every step is idempotent: <work>/state.json records what is done (with timings) and re-running
 * continues. Heavy steps run in child processes with a heap sized from the PBF (≈ 12× its size).
 * Long runs: launch via scripts/core/run-detached.sh (see the runbook).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAPH_ZOOM, type RegionManifest } from '../../src/routing/graph-format';
import type { OsmWay } from '../../src/routing/osm-types';
import { PACK_ZOOM, PACKS_INDEX_NAME, type PacksIndex } from '../../src/routing/pack-format';
import { classifyWay } from '../../src/routing/osm-rules';
import { CONTINENTS, extractSpec, fetchExtract, type ExtractSpec } from './fetch-extracts';
import { dedupeWays, planBorders, rebuildCell, wayCells, wayTileIndex, writeTiles, type BorderPlan, type ExtractTiles } from './merge-tiles';
import { groupByCell, packInfoOf, readPacksIndex, tilesFromManifestDir, writePack, writePacksIndex, type TileFile } from './pack-tiles';
import { loadPbfWays } from './pbf-ways';
import { buildRegionTable, extractTilesFromManifest, writeRegionTable } from './region-table';
import { planShards, shardPlanFile, summarizeShards } from './shard-planner.mjs';

// ---------------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------------
interface ExtractState {
  fetch?: { bytes: number; md5: string | null; verified: boolean | null; downloadS: number; at: string };
  build?: { s: number; tiles: number; bytes: number; nodes: number; arcs: number; km: number; maxRssMB: number; walk: number; at: string; heapMB: number };
  borders?: { s: number; ways: number; cells: number; planHash: string; at: string };
}
interface MergeState { s: number; tiles: number; empty: number; ways: number; bytes: number; hash: string; at: string }
interface PackState { bytes: number; indexBytes: number; tiles: number; sha256: string; origins: string[]; at: string; inputHash?: string; uploaded?: { release: string; sha256: string; at: string } }
/** One shard site (unfog-graph-N) as of the last `mirror`: what was triggered, how the run ended, whether the site verified. */
interface ShardState { at: string; cells: number; bytes: number; base: string; run?: number; conclusion?: string; verified?: boolean; note?: string }
interface State {
  version: 1;
  continent: string;
  extracts: Record<string, ExtractState>;
  borders?: { at: string; border: number; cells: number; rebuild: number };
  merge: Record<string, MergeState>;
  packs: Record<string, PackState>;
  shards?: Record<string, ShardState>;
}

interface Ctx {
  continent: string;
  work: string;
  geofabrik: string;
  dist: string;
  repoRoot: string;
  state: State;
  statePath: string;
  logPath: string;
  only: string[] | null;
  jobs: number;
  release: string;
  repo: string;
  urlBase: string;
  publish: boolean;
  force: boolean;
  dryRun: boolean;
  noWait: boolean;
}

const ts = () => new Date().toISOString();
const mb = (b: number) => (b / 1e6).toFixed(1) + ' MB';
const secs = (ms: number) => (ms / 1000).toFixed(1) + ' s';
const cellDir = (cellKey: string) => cellKey.replace(/\//g, '-');

function log(ctx: Ctx, msg: string): void {
  const line = `${ts()} ${msg}`;
  console.error(line);
  try { appendFileSync(ctx.logPath, line + '\n'); } catch { /* log dir missing until work exists */ }
}

function loadState(path: string, continent: string): State {
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf8')) as State; } catch { /* rewrite below */ }
  }
  return { version: 1, continent, extracts: {}, merge: {}, packs: {} };
}
function saveState(ctx: Ctx): void {
  mkdirSync(dirname(ctx.statePath), { recursive: true });
  writeFileSync(ctx.statePath, JSON.stringify(ctx.state, null, 1) + '\n');
}

const hash = (v: unknown): string => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);

// ---------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------
const USAGE = `usage: continent.js <fetch|build|borders|merge|pack|regions|publish|mirror|all|status|border-extract> [options]
  --continent <id>   (north-america)     --work <dir>   (tools/build-graph/cache/<continent>)
  --geofabrik <dir>  (tools/build-graph/cache/geofabrik)
  --only a,b,c       restrict fetch/build/borders to these extract ids (e.g. us/washington,british-columbia)
  --jobs N           parallel child processes for build/borders (3)
  --release <tag>    (graphs-v1)          --repo <owner/name>  (data-t3labs/unfog)
  --url-base <url>   asset URL prefix written into packs-index.json (derived from --repo/--release)
  --publish          (all) also publish + mirror   --force  re-do steps whose outputs exist (mirror: force the shard deploys)
  --dry-run          (publish, mirror) print only   --no-wait  (mirror) trigger the shard workflows and return`;

function parseArgs(argv: string[]): { cmd: string; rest: string[]; ctx: Ctx } {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, existsSync(join(here, '..', '..', '..', 'package.json')) ? '../../..' : '../..');
  const opt: Record<string, string | boolean> = {};
  const rest: string[] = [];
  const cmd = argv[0] ?? 'status';
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--publish' || k === '--force' || k === '--dry-run' || k === '--no-verify' || k === '--no-wait') { opt[k.slice(2)] = true; continue; }
    if (k.startsWith('--')) { const v = argv[++i]; if (v === undefined) throw new Error(`${k} needs a value\n${USAGE}`); opt[k.slice(2)] = v; continue; }
    rest.push(k);
  }
  const continent = String(opt.continent ?? 'north-america');
  if (!CONTINENTS[continent]) throw new Error(`unknown continent ${continent} (known: ${Object.keys(CONTINENTS).join(', ')})`);
  const work = resolve(String(opt.work ?? join(repoRoot, 'tools', 'build-graph', 'cache', continent)));
  const geofabrik = resolve(String(opt.geofabrik ?? join(repoRoot, 'tools', 'build-graph', 'cache', 'geofabrik')));
  const release = String(opt.release ?? 'graphs-v1');
  const repo = String(opt.repo ?? 'data-t3labs/unfog');
  const ctx: Ctx = {
    continent, work, geofabrik, release, repo, repoRoot,
    dist: here,
    statePath: join(work, 'state.json'),
    logPath: join(work, 'log.txt'),
    state: loadState(join(work, 'state.json'), continent),
    only: opt.only ? String(opt.only).split(',').map((s) => s.trim()).filter(Boolean) : null,
    jobs: Math.max(1, Number(opt.jobs ?? 3) || 3),
    urlBase: String(opt['url-base'] ?? `https://github.com/${repo}/releases/download/${release}/`),
    publish: opt.publish === true,
    force: opt.force === true,
    dryRun: opt['dry-run'] === true,
    noWait: opt['no-wait'] === true,
  };
  mkdirSync(work, { recursive: true });
  return { cmd, rest, ctx };
}

function extractsOf(ctx: Ctx): ExtractSpec[] {
  const ids = CONTINENTS[ctx.continent];
  const chosen = ctx.only ? ctx.only.map((id) => { if (!ids.includes(id)) throw new Error(`unknown extract ${id}`); return id; }) : ids;
  return chosen.map((id) => extractSpec(id, ctx.continent));
}

/** Extracts with a finished build (the inputs of borders/merge/pack). */
function builtExtracts(ctx: Ctx): ExtractSpec[] {
  return CONTINENTS[ctx.continent].map((id) => extractSpec(id, ctx.continent)).filter((e) => ctx.state.extracts[e.id]?.build && existsSync(join(ctx.work, 'extracts', e.slug, 'manifest.json')));
}

// ---------------------------------------------------------------------------------------------
// children
// ---------------------------------------------------------------------------------------------
interface ChildResult { code: number; stdout: string; s: number }

function runChild(ctx: Ctx, label: string, args: string[], heapMB: number): Promise<ChildResult> {
  return new Promise((resolvePromise, reject) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [`--max-old-space-size=${heapMB}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', errBuf = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => {
      errBuf += d.toString();
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) { log(ctx, `[${label}] ${errBuf.slice(0, i)}`); errBuf = errBuf.slice(i + 1); }
    });
    p.on('error', reject);
    p.on('close', (code) => { if (errBuf) log(ctx, `[${label}] ${errBuf}`); resolvePromise({ code: code ?? 1, stdout, s: (Date.now() - t0) / 1000 }); });
  });
}

async function parallel<T>(items: T[], jobs: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) { const item = items[next++]; await fn(item); } };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
}

const heapFor = (pbfBytes: number): number => Math.min(65536, Math.max(4096, Math.ceil((pbfBytes / 1e6) * 12)));

// ---------------------------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------------------------
async function cmdFetch(ctx: Ctx): Promise<void> {
  mkdirSync(ctx.geofabrik, { recursive: true });
  for (const e of extractsOf(ctx)) {
    const st = (ctx.state.extracts[e.id] ??= {});
    const file = join(ctx.geofabrik, e.file);
    if (st.fetch?.verified && existsSync(file) && statSync(file).size === st.fetch.bytes && !ctx.force) { log(ctx, `fetch ${e.id}: done (${mb(st.fetch.bytes)})`); continue; }
    log(ctx, `fetch ${e.id}`);
    const r = await fetchExtract(e, ctx.geofabrik, { log: (m) => log(ctx, m) });
    st.fetch = { bytes: r.bytes, md5: r.md5, verified: r.verified, downloadS: Math.round(r.downloadS * 10) / 10, at: ts() };
    saveState(ctx);
    log(ctx, `fetch ${e.id}: ${mb(r.bytes)} in ${r.downloadS.toFixed(1)} s${r.skipped ? ' (cached)' : ''}, md5 ${r.verified === null ? 'n/a' : r.verified ? 'ok' : 'BAD'}`);
  }
}

// ---------------------------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------------------------
async function cmdBuild(ctx: Ctx): Promise<void> {
  const cli = join(ctx.dist, 'cli.js');
  if (!existsSync(cli)) throw new Error(`missing ${cli}: run npx vite build --config tools/build-graph/vite.config.ts`);
  const todo = extractsOf(ctx).filter((e) => {
    const st = ctx.state.extracts[e.id];
    const done = st?.build && existsSync(join(ctx.work, 'extracts', e.slug, 'manifest.json'));
    if (done && !ctx.force) log(ctx, `build ${e.id}: done (${st!.build!.tiles} tiles, ${mb(st!.build!.bytes)}, ${st!.build!.s} s)`);
    return !done || ctx.force;
  });
  await parallel(todo, ctx.jobs, async (e) => {
    const pbf = join(ctx.geofabrik, e.file);
    if (!existsSync(pbf)) { log(ctx, `build ${e.id}: SKIP, no extract at ${pbf} (run fetch)`); return; }
    const size = statSync(pbf).size;
    const heapMB = heapFor(size);
    const out = join(ctx.work, 'extracts', e.slug);
    const date = statSync(pbf).mtime.toISOString().slice(0, 10);
    log(ctx, `build ${e.id}: ${mb(size)}, heap ${heapMB} MB`);
    const r = await runChild(ctx, e.slug, [cli, '--pbf', pbf, '--region', e.slug, '--name', e.id, '--out', out, '--index', join(ctx.work, 'extracts', 'index.json'), '--source', `Geofabrik ${e.id} ${date}`], heapMB);
    if (r.code !== 0) { log(ctx, `build ${e.id}: FAILED (exit ${r.code})`); return; }
    const jsonStart = r.stdout.indexOf('{');
    const stats = JSON.parse(r.stdout.slice(jsonStart)) as { tiles: number; bytes: number; nodes: number; arcs: number; km: number; maxRssMB: number; wallS: number; connectivity: { walk: { pct: number } } };
    const st = (ctx.state.extracts[e.id] ??= {});
    st.build = { s: Math.round(r.s * 10) / 10, tiles: stats.tiles, bytes: stats.bytes, nodes: stats.nodes, arcs: stats.arcs, km: stats.km, maxRssMB: stats.maxRssMB, walk: stats.connectivity.walk.pct, at: ts(), heapMB };
    saveState(ctx);
    log(ctx, `build ${e.id}: ${stats.tiles} tiles, ${mb(stats.bytes)}, ${stats.km.toFixed(0)} km, walk ${(100 * stats.connectivity.walk.pct).toFixed(1)} %, ${r.s.toFixed(1)} s, RSS ${(stats.maxRssMB / 1024).toFixed(2)} GB`);
  });
}

// ---------------------------------------------------------------------------------------------
// borders (plan + per-extract way extraction) and merge
// ---------------------------------------------------------------------------------------------
function readManifest(ctx: Ctx, slug: string): RegionManifest {
  return JSON.parse(readFileSync(join(ctx.work, 'extracts', slug, 'manifest.json'), 'utf8')) as RegionManifest;
}

function planPath(ctx: Ctx): string { return join(ctx.work, 'borders', 'plan.json'); }

function makePlan(ctx: Ctx): BorderPlan {
  const built = builtExtracts(ctx);
  const inputs: ExtractTiles[] = built.map((e) => ({ id: e.id, tiles: readManifest(ctx, e.slug).tiles }));
  const plan = planBorders(inputs, { zoom: GRAPH_ZOOM, packZoom: PACK_ZOOM });
  mkdirSync(dirname(planPath(ctx)), { recursive: true });
  writeFileSync(planPath(ctx), JSON.stringify(plan));
  const rebuild = Object.values(plan.cells).reduce((n, c) => n + c.rebuild.length, 0);
  ctx.state.borders = { at: ts(), border: plan.border.length, cells: Object.keys(plan.cells).length, rebuild };
  saveState(ctx);
  log(ctx, `borders: ${built.length} built extracts → ${plan.border.length} border tiles, ${rebuild} tiles to rebuild in ${Object.keys(plan.cells).length} cells`);
  return plan;
}

/** Hash of the part of the plan that concerns one extract (its cells' wayTiles + contributors). */
function planHashFor(plan: BorderPlan, id: string): string {
  const mine = Object.entries(plan.cells).filter(([, c]) => c.extracts.includes(id)).map(([k, c]) => [k, c.wayTiles, c.extracts]);
  return hash(mine);
}

async function cmdBorders(ctx: Ctx): Promise<void> {
  const plan = makePlan(ctx);
  const built = builtExtracts(ctx).filter((e) => !ctx.only || ctx.only.includes(e.id));
  const todo = built.filter((e) => {
    const h = planHashFor(plan, e.id);
    const st = ctx.state.extracts[e.id];
    const involved = Object.values(plan.cells).some((c) => c.extracts.includes(e.id));
    if (!involved) { log(ctx, `borders ${e.id}: no border cells`); return false; }
    if (st?.borders?.planHash === h && !ctx.force) { log(ctx, `borders ${e.id}: done (${st.borders.ways} ways → ${st.borders.cells} cells, ${st.borders.s} s)`); return false; }
    return true;
  });
  // Two PBF passes per extract with the whole way table in memory: 3 concurrent children made BC's
  // node pass 9× slower (28 s → 251 s) in the pilot, so this step caps itself at 2 jobs.
  await parallel(todo, Math.min(ctx.jobs, 2), async (e) => {
    const pbf = join(ctx.geofabrik, e.file);
    const heapMB = heapFor(statSync(pbf).size);
    log(ctx, `borders ${e.id}: extracting ways (heap ${heapMB} MB)`);
    const r = await runChild(ctx, `${e.slug}:borders`, [join(ctx.dist, 'continent.js'), 'border-extract', e.id, '--continent', ctx.continent, '--work', ctx.work, '--geofabrik', ctx.geofabrik], heapMB);
    if (r.code !== 0) { log(ctx, `borders ${e.id}: FAILED (exit ${r.code})`); return; }
    const stats = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { ways: number; cells: number };
    const st = (ctx.state.extracts[e.id] ??= {});
    st.borders = { s: Math.round(r.s * 10) / 10, ways: stats.ways, cells: stats.cells, planHash: planHashFor(plan, e.id), at: ts() };
    saveState(ctx);
    log(ctx, `borders ${e.id}: ${stats.ways} ways → ${stats.cells} cells, ${r.s.toFixed(1)} s`);
  });
}

/** Child: ways of one extract that touch any border cell's wayTiles, written per cell. */
function cmdBorderExtract(ctx: Ctx, id: string): void {
  const plan = JSON.parse(readFileSync(planPath(ctx), 'utf8')) as BorderPlan;
  const e = extractSpec(id, ctx.continent);
  const cells = Object.entries(plan.cells).filter(([, c]) => c.extracts.includes(id));
  const tiles = new Set<string>();
  for (const [, c] of cells) for (const k of c.wayTiles) tiles.add(k);
  const idx = wayTileIndex({ ...plan, cells: Object.fromEntries(cells) });
  const pbf = join(ctx.geofabrik, e.file);
  const loaded = loadPbfWays(pbf, { keep: (t) => classifyWay(t).keep, tiles, tileZoom: plan.zoom, log: (m) => console.error(m) });
  const perCell = new Map<string, string[]>();
  let ways = 0;
  for (const w of loaded.ways()) {
    const mine = wayCells(w, idx, plan.zoom);
    if (!mine.length) continue;
    ways++;
    const json = JSON.stringify(w);
    for (const ck of mine) { let list = perCell.get(ck); if (!list) { list = []; perCell.set(ck, list); } list.push(json); }
  }
  for (const [ck, list] of perCell) {
    const dir = join(ctx.work, 'borders', cellDir(ck));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${e.slug}.json`), '[' + list.join(',\n') + ']\n');
  }
  console.log(JSON.stringify({ id, ways, cells: perCell.size }));
}

function cmdMerge(ctx: Ctx): void {
  if (!existsSync(planPath(ctx))) throw new Error('no border plan: run borders first');
  const plan = JSON.parse(readFileSync(planPath(ctx), 'utf8')) as BorderPlan;
  const builtAt = Object.fromEntries(Object.entries(ctx.state.extracts).map(([id, s]) => [id, s.build?.at ?? '']));
  let n = 0, skipped = 0;
  for (const [ck, cell] of Object.entries(plan.cells)) {
    const h = hash([cell, cell.extracts.map((id) => [id, builtAt[id], ctx.state.extracts[id]?.borders?.at])]);
    const out = join(ctx.work, 'merged', cellDir(ck));
    const prev = ctx.state.merge[ck];
    if (prev?.hash === h && existsSync(join(out, 'manifest.json')) && !ctx.force) { skipped++; continue; }
    const t0 = Date.now();
    const lists: OsmWay[][] = [];
    for (const id of cell.extracts) {
      const f = join(ctx.work, 'borders', cellDir(ck), `${extractSpec(id, ctx.continent).slug}.json`);
      if (!existsSync(f)) { log(ctx, `merge ${ck}: missing ${f} (extract ${id} not yet border-extracted) — cell skipped`); lists.length = 0; break; }
      lists.push(JSON.parse(readFileSync(f, 'utf8')) as OsmWay[]);
    }
    if (!lists.length) continue;
    const ways = dedupeWays(lists);
    const built = rebuildCell(cell, ways, plan.zoom);
    const manifest = writeTiles(out, built.tiles.values(), {
      id: `merged-${cellDir(ck)}`, name: `merged border tiles ${ck}`, zoom: plan.zoom,
      source: `union of ${cell.extracts.join(', ')}`,
      stats: { nodes: built.result.stats.nodes, arcs: built.result.stats.arcs, km: Math.round(built.result.stats.km * 10) / 10 },
    });
    const bytes = manifest.tiles.reduce((s, t) => s + t[2], 0);
    ctx.state.merge[ck] = { s: Math.round((Date.now() - t0) / 100) / 10, tiles: manifest.tiles.length, empty: built.empty.length, ways: ways.length, bytes, hash: h, at: ts() };
    saveState(ctx);
    n++;
    log(ctx, `merge ${ck}: ${ways.length} ways from ${cell.extracts.length} extracts → ${manifest.tiles.length}/${cell.rebuild.length} tiles rebuilt (${built.empty.length} empty), ${mb(bytes)}, ${secs(Date.now() - t0)}`);
  }
  log(ctx, `merge: ${n} cells rebuilt, ${skipped} up to date`);
}

// ---------------------------------------------------------------------------------------------
// pack + publish
// ---------------------------------------------------------------------------------------------
function cmdPack(ctx: Ctx): PacksIndex {
  const built = builtExtracts(ctx);
  const tiles: TileFile[] = [];
  for (const e of built) tiles.push(...tilesFromManifestDir(join(ctx.work, 'extracts', e.slug), e.id));
  const mergedDir = join(ctx.work, 'merged');
  let merged = 0;
  // Merged tiles override extract tiles, but only those the CURRENT plan rebuilds (a merged cell
  // from an older plan may still list tiles that are no longer near a border).
  const plan = existsSync(planPath(ctx)) ? (JSON.parse(readFileSync(planPath(ctx), 'utf8')) as BorderPlan) : null;
  const rebuild = new Set<string>();
  if (plan) for (const c of Object.values(plan.cells)) for (const k of c.rebuild) rebuild.add(k);
  if (existsSync(mergedDir)) for (const d of readdirSync(mergedDir)) {
    if (!existsSync(join(mergedDir, d, 'manifest.json'))) continue;
    const list = tilesFromManifestDir(join(mergedDir, d), 'merged').filter((t) => rebuild.has(`${t.tx}/${t.ty}`));
    tiles.push(...list);
    merged += list.length;
  }
  const groups = groupByCell(tiles);
  const outDir = join(ctx.work, 'packs');
  const builtAt = ts();
  const prevIndex = readPacksIndex(outDir);
  const index: PacksIndex = { version: 1, zoom: GRAPH_ZOOM, packZoom: PACK_ZOOM, builtAt, release: ctx.release, packs: {} };
  let total = 0, written = 0;
  for (const g of groups) {
    const inputHash = hash(g.tiles.map((t) => [t.tx, t.ty, t.origin, statSync(t.file).size, statSync(t.file).mtimeMs]));
    const prev = ctx.state.packs[g.key];
    const prevInfo = prevIndex?.packs[g.key];
    const file = join(outDir, `${cellDir(g.key)}.ufp`);
    if (prev && prevInfo && prev.origins.join() === g.origins.join() && prev.inputHash === inputHash && existsSync(file) && !ctx.force) {
      index.packs[g.key] = prevInfo;
      total += prevInfo.bytes;
      continue;
    }
    const p = writePack(g, outDir);
    const source = `Geofabrik ${g.origins.filter((o) => o !== 'merged').join(', ')}${g.origins.includes('merged') ? ' (+ border merge)' : ''}`;
    index.packs[g.key] = packInfoOf(p, ctx.urlBase, source, builtAt);
    ctx.state.packs[g.key] = { uploaded: ctx.state.packs[g.key]?.uploaded, bytes: p.bytes, indexBytes: p.indexBytes, tiles: p.tiles, sha256: p.sha256, origins: p.origins, at: builtAt, inputHash };
    total += p.bytes;
    written++;
    log(ctx, `pack ${g.key}: ${p.tiles} tiles, ${mb(p.bytes)} (index ${p.indexBytes} B) from ${g.origins.join(', ')}`);
  }
  for (const k of Object.keys(ctx.state.packs)) if (!index.packs[k]) delete ctx.state.packs[k];
  saveState(ctx);
  const f = writePacksIndex(outDir, index);
  log(ctx, `pack: ${groups.length} packs (${written} rewritten), ${tiles.length - merged} extract tiles + ${merged} merged, ${mb(total)} total → ${f}`);
  cmdRegions(ctx);
  return index;
}

/** The app's region table (src/routing/pack-regions.json) from the built extracts' manifests. */
function cmdRegions(ctx: Ctx): void {
  const built = builtExtracts(ctx);
  if (!built.length) throw new Error('regions: no built extracts (run build first)');
  const extracts = built.map((e) => extractTilesFromManifest(join(ctx.work, 'extracts', e.slug)));
  const table = buildRegionTable(extracts, { builtAt: ts() });
  const file = join(ctx.repoRoot, 'src', 'routing', 'pack-regions.json');
  writeRegionTable(file, table);
  const multi = Object.keys(table.cells).length;
  log(ctx, `regions: ${extracts.length} extracts, ${multi} multi-extract cells with a z${table.gridZoom} grid, ${mb(statSync(file).size)} → ${file}`);
}

function gh(args: string[], dryRun: boolean, ctx: Ctx): string {
  log(ctx, `$ gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  if (dryRun) return '';
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
}

function cmdPublish(ctx: Ctx): void {
  const outDir = join(ctx.work, 'packs');
  const index = readPacksIndex(outDir);
  if (!index) throw new Error('no packs-index.json: run pack first');
  let exists = true;
  try { gh(['release', 'view', ctx.release, '--repo', ctx.repo, '--json', 'tagName'], ctx.dryRun, ctx); } catch { exists = false; }
  if (!exists) {
    gh(['release', 'create', ctx.release, '--repo', ctx.repo, '--prerelease', '--title', `Routing graph packs (${ctx.release})`, '--notes',
      `Unfog routing-graph packs: one \`6-<x>-<y>.ufp\` per zoom-6 cell (UFP1: index + deflated UFG1 z12 tiles, byte-range served) plus \`packs-index.json\`. Built from Geofabrik extracts (© OpenStreetMap contributors, ODbL). See docs/coverage-runbook.md.`], ctx.dryRun, ctx);
  }
  const files: string[] = [];
  for (const [key, info] of Object.entries(index.packs)) {
    const st = ctx.state.packs[key];
    const file = join(outDir, `${cellDir(key)}.ufp`);
    if (!existsSync(file)) { log(ctx, `publish ${key}: missing ${file}`); continue; }
    if (st?.uploaded && st.uploaded.sha256 === info.sha256 && st.uploaded.release === ctx.release && !ctx.force) continue;
    files.push(file);
  }
  // Uploads go through curl + the REST API, one file per call, state saved after each, 4 attempts:
  // `gh release upload` dials uploads.github.com and times out from this network ("dial tcp
  // 140.82.114.x:443: i/o timeout", 2026-09-02) while curl reaches the same IPs in 0.1 s.
  // "Clobber" = delete the existing asset of that name first (POST returns 422 otherwise).
  const releaseId = ctx.dryRun ? '0' : gh(['api', `repos/${ctx.repo}/releases/tags/${ctx.release}`, '--jq', '.id'], false, ctx).trim();
  const existing = new Map<string, number>();
  if (!ctx.dryRun) {
    const list = gh(['api', `repos/${ctx.repo}/releases/${releaseId}/assets`, '--paginate', '--jq', '.[] | "\\(.id) \\(.name)"'], false, ctx);
    for (const line of list.split('\n')) { const m = /^(\d+) (.+)$/.exec(line.trim()); if (m) existing.set(m[2], Number(m[1])); }
  }
  const token = ctx.dryRun ? '' : gh(['auth', 'token'], false, ctx).trim();
  const upload = (file: string): boolean => {
    const name = file.split('/').pop()!;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const old = existing.get(name);
        if (old !== undefined) { gh(['api', '-X', 'DELETE', `repos/${ctx.repo}/releases/assets/${old}`], ctx.dryRun, ctx); existing.delete(name); }
        const url = `https://uploads.github.com/repos/${ctx.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
        log(ctx, `$ curl -X POST --data-binary @${name} ${url}`);
        if (ctx.dryRun) return true;
        const out = execFileSync('curl', ['-sS', '--fail-with-body', '-m', '1800', '--retry', '2', '-X', 'POST', '-H', `Authorization: token ${token}`, '-H', 'Accept: application/vnd.github+json', '-H', 'Content-Type: application/octet-stream', '--data-binary', `@${file}`, url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
        const asset = JSON.parse(out) as { id: number; name: string; size: number };
        if (asset.size !== statSync(file).size) throw new Error(`uploaded size ${asset.size} ≠ local ${statSync(file).size}`);
        existing.set(name, asset.id);
        return true;
      } catch (e) {
        log(ctx, `publish: upload of ${name} failed (attempt ${attempt}): ${(e as Error).message.split('\n')[0].slice(0, 200)}`);
        if (attempt < 4) execFileSync('sleep', [String(10 * attempt)]);
      }
    }
    return false;
  };
  let done = 0, failed = 0;
  for (const f of files) {
    if (!upload(f)) { failed++; continue; }
    done++;
    if (!ctx.dryRun) {
      const key = Object.keys(index.packs).find((k) => `${cellDir(k)}.ufp` === f.split('/').pop());
      if (key) ctx.state.packs[key].uploaded = { release: ctx.release, sha256: index.packs[key].sha256 ?? '', at: ts() };
      saveState(ctx);
    }
    log(ctx, `publish: uploaded ${done}/${files.length} packs (${mb(statSync(f).size)})`);
  }
  if (failed) throw new Error(`publish: ${failed} packs failed to upload; re-run publish (packs-index.json was NOT uploaded)`);
  if (!upload(join(outDir, PACKS_INDEX_NAME))) throw new Error(`publish: ${PACKS_INDEX_NAME} failed to upload`);
  log(ctx, `publish: ${files.length} packs + ${PACKS_INDEX_NAME} → ${ctx.urlBase}`);
}

// ---------------------------------------------------------------------------------------------
// mirror: shard plan → shard workflows → verification (docs/coverage-runbook.md § Hosting)
// ---------------------------------------------------------------------------------------------
const sleepS = (s: number): void => { execFileSync('sleep', [String(s)]); };

interface ShardVerify { ok: boolean; note: string }
interface LiveShardIndex { packs?: Record<string, { bytes: number; sha256?: string }> }
// Accept-Encoding: identity — Node's fetch asks for gzip and Pages then reports the COMPRESSED length.
const identity = { 'accept-encoding': 'identity' };

/** index.json → 200 and, for three sample packs, HEAD length = index bytes + Range → 206 (+ ACAO *). */
async function verifyShard(base: string, cells: string[], index: PacksIndex): Promise<ShardVerify> {
  const notes: string[] = [];
  const bust = `?t=${Date.now()}`;
  let live: LiveShardIndex | null = null;
  try {
    const r = await fetch(`${base}index.json${bust}`, { cache: 'no-store' });
    if (r.status !== 200) return { ok: false, note: `index.json → HTTP ${r.status}` };
    live = (await r.json()) as LiveShardIndex;
  } catch (e) { return { ok: false, note: `index.json: ${(e as Error).message}` }; }
  const stale = cells.filter((c) => { const l = live?.packs?.[c]; const i = index.packs[c]; return !l || !i || l.bytes !== i.bytes || (i.sha256 && l.sha256 !== i.sha256); });
  if (stale.length) notes.push(`${stale.length} cells differ from the published index (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', …' : ''})`);
  const byBytes = [...cells].sort((a, b) => index.packs[b].bytes - index.packs[a].bytes);
  const samples = [...new Set([byBytes[0], byBytes[Math.floor(byBytes.length / 2)], byBytes[byBytes.length - 1]])].filter(Boolean);
  for (const c of samples) {
    const info = index.packs[c];
    const url = base + info.url.split('/').pop()!;
    try {
      const h = await fetch(url, { method: 'HEAD', cache: 'no-store', headers: identity });
      const len = Number(h.headers.get('content-length'));
      if (h.status !== 200) { notes.push(`${c} HEAD → ${h.status}`); continue; }
      if (len !== info.bytes) { notes.push(`${c} content-length ${len} ≠ ${info.bytes}`); continue; }
      const r = await fetch(url, { headers: { ...identity, Range: 'bytes=0-1023' }, cache: 'no-store' });
      if (r.status !== 206) { notes.push(`${c} Range → ${r.status}`); continue; }
      if (r.headers.get('access-control-allow-origin') !== '*') notes.push(`${c} no access-control-allow-origin: *`);
      await r.arrayBuffer();
    } catch (e) { notes.push(`${c}: ${(e as Error).message}`); }
  }
  return { ok: notes.length === 0, note: notes.length ? notes.join('; ') : `${samples.length} samples: HEAD length ok, Range → 206` };
}

async function cmdMirror(ctx: Ctx): Promise<void> {
  const index = readPacksIndex(join(ctx.work, 'packs'));
  if (!index) throw new Error('no packs-index.json: run pack + publish first');
  const planFile = join(ctx.repoRoot, 'tools', 'build-graph', 'pages-shards.json');
  const prev = existsSync(planFile) ? (JSON.parse(readFileSync(planFile, 'utf8')) as Parameters<typeof planShards>[1]) : { shards: {} };
  if (!Object.keys(prev.shards ?? {}).length) throw new Error(`${planFile} lists no shards (see docs/coverage-runbook.md § Hosting)`);
  const plan = planShards(index, prev);
  for (const l of summarizeShards(plan).split('\n')) log(ctx, `mirror: ${l}`);
  for (const n of plan.overCap) log(ctx, `mirror: WARNING ${n} is over capMB after keeping its assignments`);
  if (plan.unassigned.length) throw new Error(`mirror: ${plan.unassigned.length} cells (${mb(plan.unassignedBytes)}) fit in no shard — add "unfog-graph-${Object.keys(plan.shards).length + 1}": {"cells": []} to ${planFile}, create that repo from tools/build-graph/shard-repo (runbook § Hosting) and re-run`);
  const rel = 'tools/build-graph/pages-shards.json';
  if (plan.changed) {
    const doc = shardPlanFile(plan, prev);
    log(ctx, `mirror: plan changed (${plan.added.length} added, ${plan.dropped.length} dropped) → ${rel}`);
    if (!ctx.dryRun) {
      writeFileSync(planFile, JSON.stringify(doc, null, 1) + '\n');
      // The shard workflows read the plan from this repo's main branch, so it must be pushed first.
      // Only this one path is staged; a foreign staged change means another session is mid-commit.
      const git = (a: string[]) => execFileSync('git', ['-C', ctx.repoRoot, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      const staged = git(['diff', '--cached', '--name-only']).trim();
      if (staged) throw new Error(`mirror: the git index already has staged changes (${staged.split('\n').join(', ')}); commit or unstage them, then commit + push ${rel} and re-run mirror`);
      git(['add', rel]);
      git(['commit', '-q', '-m', `Coverage v2 hosting: shard plan ${ctx.release} (${plan.added.length} added, ${plan.dropped.length} dropped)`, '--', rel]);
      git(['push']);
      log(ctx, `mirror: committed + pushed ${rel}`);
    }
  } else log(ctx, `mirror: plan unchanged (${plan.kept} cells kept)`);

  const shards = ctx.state.shards ??= {};
  const owner = ctx.repo.split('/')[0];
  const t0 = Date.now();
  const triggered: string[] = [];
  for (const [name, s] of Object.entries(plan.shards)) {
    shards[name] = { at: ts(), cells: s.cells.length, bytes: s.bytes, base: s.base };
    try {
      gh(['workflow', 'run', 'mirror.yml', '-R', `${owner}/${name}`, ...(ctx.force ? ['-f', 'force=true'] : [])], ctx.dryRun, ctx);
      triggered.push(name);
    } catch (e) {
      shards[name].conclusion = 'not-triggered';
      shards[name].note = `gh workflow run failed: ${(e as Error).message.split('\n')[0].slice(0, 160)} — does the repo exist with mirror.yml? (tools/build-graph/shard-repo, runbook § Hosting)`;
      log(ctx, `mirror ${name}: ${shards[name].note}`);
    }
  }
  saveState(ctx);
  if (ctx.dryRun || ctx.noWait) { log(ctx, `mirror: triggered ${triggered.length}/${Object.keys(plan.shards).length} shard workflows${ctx.noWait ? ' (--no-wait)' : ''}`); return; }

  // Poll each shard's newest mirror.yml run created after the trigger, up to 40 min.
  const pending = new Set(triggered);
  const deadline = Date.now() + 40 * 60 * 1000;
  sleepS(15);
  while (pending.size && Date.now() < deadline) {
    for (const name of [...pending]) {
      const out = gh(['run', 'list', '-R', `${owner}/${name}`, '--workflow', 'mirror.yml', '--limit', '3', '--json', 'databaseId,status,conclusion,createdAt'], false, ctx);
      const runs = (JSON.parse(out || '[]') as { databaseId: number; status: string; conclusion: string; createdAt: string }[]).filter((r) => Date.parse(r.createdAt) >= t0 - 60_000);
      const run = runs[0];
      if (!run) continue;
      shards[name].run = run.databaseId;
      if (run.status !== 'completed') continue;
      shards[name].conclusion = run.conclusion;
      pending.delete(name);
      log(ctx, `mirror ${name}: run ${run.databaseId} ${run.conclusion} after ${secs(Date.now() - t0)}`);
    }
    saveState(ctx);
    if (pending.size) sleepS(20);
  }
  for (const name of pending) { shards[name].conclusion = 'timeout'; log(ctx, `mirror ${name}: still running after 40 min — check gh run list -R ${owner}/${name}`); }

  let bad = 0;
  for (const [name, s] of Object.entries(plan.shards)) {
    if (!triggered.includes(name)) { bad++; continue; }
    const v = await verifyShard(s.base, s.cells, index);
    shards[name].verified = v.ok;
    shards[name].note = v.note;
    if (!v.ok) bad++;
    log(ctx, `mirror ${name}: ${v.ok ? 'verified' : 'NOT verified'} — ${v.note}`);
  }
  saveState(ctx);
  if (bad) throw new Error(`mirror: ${bad} shard(s) failed or did not verify — see state.json shards; fix and re-run mirror (then the main deploy picks up the index)`);
  log(ctx, `mirror: ${Object.keys(plan.shards).length} shards verified; push main (or gh workflow run deploy.yml) so the app's packs-index.json points at them`);
}

function cmdStatus(ctx: Ctx): void {
  const s = ctx.state;
  const rows = Object.entries(s.extracts).map(([id, e]) => `${id.padEnd(28)} fetch ${e.fetch ? mb(e.fetch.bytes).padStart(10) + ' ' + String(e.fetch.downloadS).padStart(6) + ' s' : '-'.padStart(19)}  build ${e.build ? `${String(e.build.tiles).padStart(5)} tiles ${mb(e.build.bytes).padStart(9)} ${String(e.build.s).padStart(6)} s walk ${(100 * e.build.walk).toFixed(0)} %` : '-'}  borders ${e.borders ? `${e.borders.ways} ways/${e.borders.cells} cells` : '-'}`);
  console.log(rows.join('\n'));
  const packs = Object.values(s.packs);
  console.log(`\nextracts ${Object.keys(s.extracts).length} (built ${Object.values(s.extracts).filter((e) => e.build).length}) · border cells ${s.borders?.cells ?? '-'} (${s.borders?.border ?? '-'} border tiles, ${s.borders?.rebuild ?? '-'} to rebuild) · merged ${Object.keys(s.merge).length} · packs ${packs.length} = ${mb(packs.reduce((n, p) => n + p.bytes, 0))} (uploaded ${packs.filter((p) => p.uploaded).length})`);
  const shards = Object.entries(s.shards ?? {});
  if (shards.length) console.log(`shards ${shards.length}: ` + shards.map(([n, sh]) => `${n} ${sh.cells} cells ${mb(sh.bytes)} ${sh.conclusion ?? 'pending'}${sh.verified === undefined ? '' : sh.verified ? ' verified' : ' NOT verified'} (${sh.at.slice(0, 16)}Z)`).join(' · '));
  else console.log('shards: none mirrored yet (run mirror)');
}

// ---------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  const { cmd, rest, ctx } = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  switch (cmd) {
    case 'fetch': await cmdFetch(ctx); break;
    case 'build': await cmdBuild(ctx); break;
    case 'borders': await cmdBorders(ctx); break;
    case 'border-extract': cmdBorderExtract(ctx, rest[0]); return;
    case 'merge': cmdMerge(ctx); break;
    case 'pack': cmdPack(ctx); break;
    case 'regions': cmdRegions(ctx); break;
    case 'publish': cmdPublish(ctx); break;
    case 'mirror': await cmdMirror(ctx); break;
    case 'all':
      await cmdFetch(ctx); await cmdBuild(ctx); await cmdBorders(ctx); cmdMerge(ctx); cmdPack(ctx);
      if (ctx.publish) { cmdPublish(ctx); await cmdMirror(ctx); }
      break;
    case 'status': cmdStatus(ctx); return;
    case '-h': case '--help': console.log(USAGE); return;
    default: throw new Error(`unknown command ${cmd}\n${USAGE}`);
  }
  log(ctx, `${cmd}: finished in ${secs(Date.now() - t0)}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `error: ${e.message}` : String(e));
  process.exit(1);
});
