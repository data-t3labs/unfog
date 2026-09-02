/**
 * TEST-ONLY converter: Overpass `out geom` JSON (tests/fixtures/osm/williamsburg.json.gz) → graph
 * tiles. Arcs both directions with WALK|BIKE, plus DRIVE unless the highway is
 * footway/path/pedestrian/cycleway/steps (oneway deliberately ignored — the production rules
 * live in src/routing/osm-rules.ts, wave 1 D).
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { ArcFlag, type GraphTileInput } from '../../../src/routing/graph-format';
import { buildTestTiles, type TestWay } from './tile-builder';

export interface OverpassWay {
  type: 'way';
  id: number;
  nodes: number[];
  geometry: Array<{ lat: number; lon: number }>;
  tags: Record<string, string>;
}

const NO_DRIVE = new Set(['footway', 'path', 'pedestrian', 'cycleway', 'steps']);

export function loadOverpassWays(path: string): OverpassWay[] {
  const json = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as { elements: OverpassWay[] };
  return json.elements.filter((e) => e.type === 'way' && Array.isArray(e.nodes) && Array.isArray(e.geometry) && e.nodes.length === e.geometry.length);
}

export function overpassToTestWays(ways: OverpassWay[]): TestWay[] {
  return ways.map((w) => {
    const drive = NO_DRIVE.has(w.tags?.highway ?? '') ? 0 : ArcFlag.DRIVE;
    const flags = ArcFlag.WALK | ArcFlag.BIKE | drive;
    return { id: w.id, refs: w.nodes, coords: w.geometry.map((p) => [p.lon, p.lat] as [number, number]), fwd: flags, rev: flags };
  });
}

export function overpassToTiles(path: string): { tiles: Map<string, GraphTileInput>; ways: OverpassWay[] } {
  const ways = loadOverpassWays(path);
  return { tiles: buildTestTiles(overpassToTestWays(ways)), ways };
}
