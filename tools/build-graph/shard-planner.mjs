/**
 * Shard planner (coverage v2 hosting): assigns every cell of a packs-index to one of the sibling
 * GitHub Pages sites (`unfog-graph-N`, each ≤ capMB) that serve the packs on the app's origin.
 * Pure — no I/O; `shard-plan.mjs` is the CLI, `build-continent.ts` (`mirror`) calls it directly.
 *
 * Rules (docs/coverage-runbook.md § Hosting):
 *   - existing cell → shard assignments are kept (a re-plan never reshuffles a deployed shard);
 *   - cells that are no longer in the index are dropped;
 *   - new cells, largest first, go to the shard with the most free space that still fits;
 *   - nothing fits → the result lists the cell under `unassigned` (the CLI exits 1 and tells the
 *     operator to add an empty shard entry to pages-shards.json).
 * A kept shard that grew past the cap (a data refresh) is reported under `overCap`, never
 * reshuffled: the operator decides (raise capMB, or move cells by hand).
 */

/** Public URL prefix of one shard site (all sites of the account share the app's origin). */
export const shardBase = (name, owner = 'data-t3labs') => `https://${owner}.github.io/${name}/packs/`;

/**
 * @typedef {{ url: string; bytes: number; indexBytes?: number; tiles?: number; builtAt?: string; source?: string; sha256?: string }} PackInfo
 * @typedef {{ packs: Record<string, PackInfo> }} IndexLike
 * @typedef {{ base?: string; cells?: string[] }} ShardEntry
 * @typedef {{ note?: string; updatedAt?: string; capMB?: number; shards?: Record<string, ShardEntry> }} ShardPlanFile
 * @typedef {{ base: string; cells: string[]; bytes: number }} ShardResult
 * @typedef {{ shards: Record<string, ShardResult>; capBytes: number; kept: number; added: string[]; dropped: string[]; unassigned: string[]; unassignedBytes: number; overCap: string[]; changed: boolean }} PlanResult
 */

const cmpCell = (a, b) => {
  const [az, ax, ay] = a.split('/').map(Number);
  const [bz, bx, by] = b.split('/').map(Number);
  return az - bz || ax - bx || ay - by || (a < b ? -1 : a > b ? 1 : 0);
};

/**
 * @param {IndexLike} index      packs-index.json (release or emitted)
 * @param {ShardPlanFile} prev   current pages-shards.json (may have empty shard entries)
 * @param {{ capMB?: number; owner?: string }} [opts]
 * @returns {PlanResult}
 */
export function planShards(index, prev, opts = {}) {
  const capMB = opts.capMB ?? prev.capMB ?? 900;
  const capBytes = capMB * 1e6;
  const packs = index?.packs ?? {};
  /** @type {Record<string, ShardResult>} */
  const shards = {};
  for (const [name, s] of Object.entries(prev.shards ?? {})) shards[name] = { base: s?.base || shardBase(name, opts.owner), cells: [], bytes: 0 };

  const assigned = new Map();
  const dropped = [];
  let kept = 0;
  for (const [name, s] of Object.entries(prev.shards ?? {})) {
    for (const cell of s?.cells ?? []) {
      if (!packs[cell]) { dropped.push(cell); continue; }
      if (assigned.has(cell)) continue; // duplicate entry: the first shard keeps it
      assigned.set(cell, name);
      shards[name].cells.push(cell);
      shards[name].bytes += packs[cell].bytes;
      kept++;
    }
  }

  const fresh = Object.keys(packs).filter((c) => !assigned.has(c)).sort((a, b) => packs[b].bytes - packs[a].bytes || cmpCell(a, b));
  const added = [];
  const unassigned = [];
  for (const cell of fresh) {
    const bytes = packs[cell].bytes;
    let best = null;
    for (const [name, s] of Object.entries(shards)) {
      const free = capBytes - s.bytes;
      if (free >= bytes && (!best || free > best.free)) best = { name, free };
    }
    if (!best) { unassigned.push(cell); continue; }
    shards[best.name].cells.push(cell);
    shards[best.name].bytes += bytes;
    assigned.set(cell, best.name);
    added.push(cell);
  }
  for (const s of Object.values(shards)) s.cells.sort(cmpCell);
  const overCap = Object.entries(shards).filter(([, s]) => s.bytes > capBytes).map(([name]) => name);
  const unassignedBytes = unassigned.reduce((n, c) => n + packs[c].bytes, 0);
  const prevCells = Object.entries(prev.shards ?? {}).map(([n, s]) => `${n}:${(s?.cells ?? []).join(',')}`).join(';');
  const nextCells = Object.entries(shards).map(([n, s]) => `${n}:${s.cells.join(',')}`).join(';');
  return { shards, capBytes, kept, added, dropped: dropped.sort(cmpCell), unassigned, unassignedBytes, overCap, changed: prevCells !== nextCells };
}

/** The pages-shards.json document for a plan result (stable key order; `updatedAt` only when changed). */
export function shardPlanFile(result, prev, opts = {}) {
  const capMB = opts.capMB ?? prev.capMB ?? 900;
  return {
    note: prev.note ?? 'Cell → GitHub Pages shard assignments for the routing-graph packs (coverage v2 hosting). Written by tools/build-graph/shard-plan.mjs; assignments are stable across re-plans. Add a shard = add an empty entry {"base": ..., "cells": []} and re-run. See docs/coverage-runbook.md § Hosting.',
    updatedAt: result.changed || !prev.updatedAt ? (opts.now ?? new Date().toISOString()) : prev.updatedAt,
    capMB,
    shards: Object.fromEntries(Object.entries(result.shards).map(([name, s]) => [name, { base: s.base, cells: s.cells }])),
  };
}

/** One-line-per-shard summary (bytes vs cap) for logs. */
export function summarizeShards(result) {
  const cap = result.capBytes / 1e6;
  const rows = Object.entries(result.shards).map(([name, s]) => `${name.padEnd(16)} ${s.cells.length.toString().padStart(4)} cells ${(s.bytes / 1e6).toFixed(1).padStart(7)} MB / ${cap.toFixed(0)} MB${s.bytes > result.capBytes ? '  OVER CAP' : ''}`);
  const total = Object.values(result.shards).reduce((n, s) => n + s.bytes, 0);
  rows.push(`total ${Object.values(result.shards).reduce((n, s) => n + s.cells.length, 0)} cells ${(total / 1e6).toFixed(1)} MB in ${Object.keys(result.shards).length} shards · kept ${result.kept}, added ${result.added.length}, dropped ${result.dropped.length}${result.unassigned.length ? `, UNASSIGNED ${result.unassigned.length} (${(result.unassignedBytes / 1e6).toFixed(1)} MB)` : ''}`);
  return rows.join('\n');
}
