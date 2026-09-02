/**
 * Shared shapes between the graph builder (src/routing/graph-build.ts, tools/build-graph) and its
 * consumers (route.worker's on-demand downloader). Fixed in wave 0.
 */
import type { GraphTileInput } from './graph-format';

/** One OSM way with resolved node coordinates. `refs[i]` is the OSM node id of `coords[i]`. */
export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  refs: number[];
  coords: Array<[lon: number, lat: number]>;
}

/** Per-way routing classification (the single rule table lives in osm-rules.ts). */
export interface WayClass {
  keep: boolean;
  walk: boolean;
  bike: boolean;
  drive: boolean;
  steps: boolean;
  /** Bikes must dismount (walk the bike). */
  dismount: boolean;
  /** Vehicles may only travel in way direction (bike/drive). */
  onewayFwd: boolean;
  /** Vehicles may only travel against way direction (oneway=-1). */
  onewayBack: boolean;
  /** Bikes exempt from the oneway (oneway:bicycle=no / cycleway=opposite*). */
  bikeBothWays: boolean;
}

export interface BuildOptions {
  /** Graph zoom; default 12. */
  zoom?: number;
}

export interface BuildResult {
  tiles: Map<string, GraphTileInput>; // key "tx/ty"
  stats: { ways: number; nodes: number; arcs: number; km: number };
}

/** Implemented in graph-build.ts (wave 1 D). Pure; runs in Node and in a worker. */
export type BuildGraphTiles = (ways: Iterable<OsmWay>, opts?: BuildOptions) => BuildResult;

/** Implemented in overpass.ts (wave 1 D). */
export interface OverpassOptions {
  endpoint?: string; // default https://overpass-api.de/api/interpreter
  timeoutS?: number; // default 90
  signal?: AbortSignal;
  userAgent?: string;
}
export type FetchOverpassWays = (
  bbox: [west: number, south: number, east: number, north: number],
  opts?: OverpassOptions,
) => Promise<OsmWay[]>;
