#!/usr/bin/env node
/**
 * Update tools/build-graph/pages-shards.json from a packs-index (coverage v2 hosting).
 *
 *   node tools/build-graph/shard-plan.mjs [--index <file|url>] [--plan tools/build-graph/pages-shards.json]
 *        [--cap-mb 900] [--dry-run]
 *
 * Default --index = the packs-index.json of the graphs-v1 release (downloaded with curl). The plan
 * is updated STABLY (existing assignments kept, missing cells dropped, new cells into the shard with
 * the most free space that fits — rules in shard-planner.mjs). Prints per-shard totals. Exit 1 when a
 * cell fits nowhere: add an empty shard entry to pages-shards.json and re-run. Plain Node ≥ 20, no
 * dependencies. The shard sites read this file from raw.githubusercontent.com (main), so commit +
 * push it before triggering them (docs/coverage-runbook.md § Hosting).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planShards, shardPlanFile, summarizeShards } from './shard-planner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const flags = new Set(['dry-run']);
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  args[k] = flags.has(k) ? true : process.argv[++i];
}
const planPath = args.plan ?? join(here, 'pages-shards.json');
const indexArg = args.index ?? 'https://github.com/data-t3labs/unfog/releases/download/graphs-v1/packs-index.json';

function loadIndex(src) {
  if (/^https?:\/\//.test(src)) {
    const file = join(mkdtempSync(join(tmpdir(), 'unfog-shard-plan-')), 'packs-index.json');
    execFileSync('curl', ['-sSL', '--fail', '--retry', '5', '--retry-delay', '5', '-o', file, src], { stdio: ['ignore', 'inherit', 'inherit'] });
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  return JSON.parse(readFileSync(src, 'utf8'));
}

const index = loadIndex(indexArg);
if (!index?.packs || typeof index.packs !== 'object') { console.error(`shard-plan: ${indexArg} is not a packs-index (no "packs")`); process.exit(1); }
const prev = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : { shards: {} };
if (!prev.shards || !Object.keys(prev.shards).length) { console.error(`shard-plan: ${planPath} lists no shards; add entries like "unfog-graph-1": { "cells": [] }`); process.exit(1); }

const result = planShards(index, prev, { capMB: args['cap-mb'] ? Number(args['cap-mb']) : undefined });
console.error(summarizeShards(result));
for (const c of result.dropped) console.error(`shard-plan: dropped ${c} (no longer in the index)`);
for (const n of result.overCap) console.error(`shard-plan: WARNING ${n} is over the cap after keeping its assignments — raise capMB or move cells by hand`);
if (result.unassigned.length) {
  console.error(`shard-plan: ${result.unassigned.length} cells (${result.unassignedBytes} B) fit in no shard — add a shard entry to ${planPath} (e.g. "unfog-graph-${Object.keys(result.shards).length + 1}": { "cells": [] }), create that repo (runbook § Hosting) and re-run`);
  process.exit(1);
}
const doc = shardPlanFile(result, prev, { capMB: args['cap-mb'] ? Number(args['cap-mb']) : undefined });
if (args['dry-run']) { console.error(`shard-plan: dry run, ${planPath} not written (${result.changed ? 'would change' : 'unchanged'})`); process.exit(0); }
if (result.changed || !existsSync(planPath)) {
  writeFileSync(planPath, JSON.stringify(doc, null, 1) + '\n');
  console.error(`shard-plan: wrote ${planPath} (${result.added.length} added, ${result.dropped.length} dropped) — commit + push it, then run the shard workflows`);
} else {
  console.error(`shard-plan: ${planPath} unchanged`);
}
