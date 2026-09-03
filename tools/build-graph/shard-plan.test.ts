import { describe, expect, it } from 'vitest';
import { planShards, shardPlanFile, summarizeShards } from './shard-planner.mjs';

const MB = 1e6;
const index = (cells: Record<string, number>) => ({ packs: Object.fromEntries(Object.entries(cells).map(([k, mb]) => [k, { url: `https://x/${k.replace(/\//g, '-')}.ufp`, bytes: mb * MB }])) });
const plan = (shards: Record<string, string[]>, capMB = 100) => ({ capMB, shards: Object.fromEntries(Object.entries(shards).map(([n, cells]) => [n, { cells }])) });

describe('planShards', () => {
  it('keeps existing assignments and places new cells (largest first) where the most space is free', () => {
    const prev = plan({ 'unfog-graph-1': ['6/1/1', '6/1/2'], 'unfog-graph-2': ['6/2/1'] });
    const r = planShards(index({ '6/1/1': 40, '6/1/2': 30, '6/2/1': 20, '6/3/1': 50, '6/3/2': 10 }), prev);
    expect(r.shards['unfog-graph-1'].cells).toEqual(['6/1/1', '6/1/2', '6/3/2']); // 70 + 10 (graph-2 had 30 free < 50)
    expect(r.shards['unfog-graph-2'].cells).toEqual(['6/2/1', '6/3/1']); // 20 + 50
    expect(r.kept).toBe(3);
    expect(r.added).toEqual(['6/3/1', '6/3/2']);
    expect(r.unassigned).toEqual([]);
    expect(r.changed).toBe(true);
    expect(r.shards['unfog-graph-1'].base).toBe('https://data-t3labs.github.io/unfog-graph-1/packs/');
  });

  it('is stable: re-planning the same index changes nothing even when a fresh plan would pack differently', () => {
    const idx = index({ '6/1/1': 60, '6/2/1': 60, '6/3/1': 30, '6/4/1': 30 });
    const first = planShards(idx, plan({ 'unfog-graph-1': [], 'unfog-graph-2': [] }));
    const again = planShards(idx, shardPlanFile(first, {}));
    expect(again.changed).toBe(false);
    expect(again.shards).toEqual(first.shards);
    // deliberately lopsided existing plan stays lopsided
    const lopsided = planShards(idx, plan({ 'unfog-graph-1': ['6/1/1', '6/3/1'], 'unfog-graph-2': ['6/2/1', '6/4/1'] }));
    expect(lopsided.changed).toBe(false);
    expect(lopsided.shards['unfog-graph-1'].cells).toEqual(['6/1/1', '6/3/1']);
  });

  it('drops cells that left the index and counts them', () => {
    const r = planShards(index({ '6/1/1': 10 }), plan({ 'unfog-graph-1': ['6/1/1', '6/9/9'] }));
    expect(r.dropped).toEqual(['6/9/9']);
    expect(r.shards['unfog-graph-1'].cells).toEqual(['6/1/1']);
    expect(r.changed).toBe(true);
  });

  it('respects the cap: reports cells that fit nowhere (with bytes) and kept shards that grew past the cap', () => {
    const r = planShards(index({ '6/1/1': 90, '6/2/1': 90, '6/3/1': 15 }), plan({ 'unfog-graph-1': [], 'unfog-graph-2': [] }));
    expect(r.unassigned).toEqual(['6/3/1']);
    expect(r.unassignedBytes).toBe(15 * MB);
    expect(summarizeShards(r)).toContain('UNASSIGNED 1 (15.0 MB)');
    const grown = planShards(index({ '6/1/1': 120 }), plan({ 'unfog-graph-1': ['6/1/1'] }));
    expect(grown.overCap).toEqual(['unfog-graph-1']);
    expect(grown.shards['unfog-graph-1'].cells).toEqual(['6/1/1']); // never reshuffled
    expect(summarizeShards(grown)).toContain('OVER CAP');
  });

  it('writes a plan file with stable keys, an updatedAt that moves only on change, and the cap', () => {
    const prev = { ...plan({ 'unfog-graph-1': ['6/1/1'] }, 50), updatedAt: '2026-01-01T00:00:00.000Z' };
    const same = planShards(index({ '6/1/1': 1 }), prev);
    const doc = shardPlanFile(same, prev, { now: '2026-02-02T00:00:00.000Z' });
    expect(doc.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(doc.capMB).toBe(50);
    expect(Object.keys(doc)).toEqual(['note', 'updatedAt', 'capMB', 'shards']);
    expect(doc.shards['unfog-graph-1']).toEqual({ base: 'https://data-t3labs.github.io/unfog-graph-1/packs/', cells: ['6/1/1'] });
    const changed = planShards(index({ '6/1/1': 1, '6/1/2': 1 }), prev);
    expect(shardPlanFile(changed, prev, { now: '2026-02-02T00:00:00.000Z' }).updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });
});
