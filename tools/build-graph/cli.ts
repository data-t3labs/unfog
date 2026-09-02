/**
 * Graph build CLI — OSM PBF (BBBike extract) or Overpass → routing graph tiles.
 *
 *   node tools/build-graph/dist/cli.js --pbf tools/build-graph/cache/Vancouver.osm.pbf --region vancouver --name "Metro Vancouver"
 *   node tools/build-graph/dist/cli.js --overpass -73.978,40.703,-73.938,40.729 --region williamsburg --name "Williamsburg"
 *
 * Options: --out <dir> (default public/graph/<region>), --bbox w,s,e,n (PBF: keep ways touching the
 * box; also the manifest bbox), --source "<text>", --index <file> (default public/graph/index.json),
 * --zoom <n> (default 12), --no-sidewalk-glue / --no-service-glue (exclude those GLUE candidates).
 * Writes <out>/12/<x>/<y>.ufg + <out>/manifest.json and merges the region into the index, then
 * prints stats including per-mode connectivity. See docs/BUILD-PLAN.md §2.4 "How to run".
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { GRAPH_ZOOM, NodeFlag, graphTilePath, packGraphTile, type RegionManifest } from '../../src/routing/graph-format';
import { buildGraphTiles } from '../../src/routing/graph-build';
import { classifyWay } from '../../src/routing/osm-rules';
import { fetchOverpassWays } from '../../src/routing/overpass';
import type { OsmWay } from '../../src/routing/osm-types';
import { connectivity } from './connectivity';
import { loadPbfWays } from './pbf-ways';

type BBox = [west: number, south: number, east: number, north: number];

interface Args {
  pbf?: string;
  overpass?: BBox;
  region: string;
  name: string;
  out: string;
  index: string;
  bbox?: BBox;
  source?: string;
  zoom: number;
  glueSidewalks: boolean;
  glueService: boolean;
}

const USAGE = `usage:
  build-graph --pbf <file.osm.pbf> --region <id> --name "<name>" [--out <dir>] [--bbox w,s,e,n] [--source "<text>"] [--index <file>]
  build-graph --overpass w,s,e,n --region <id> --name "<name>" [--out <dir>] [--source "<text>"] [--index <file>]
  common: --zoom <n> (12) · --no-sidewalk-glue · --no-service-glue (exclude sidewalks / driveways+parking aisles+unnamed service as GLUE candidates)
Large extracts: NODE_OPTIONS=--max-old-space-size=8192 npm run build-graph -- --pbf … (see docs/BUILD-PLAN.md §2.4).`;

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = { zoom: GRAPH_ZOOM, glueSidewalks: true, glueService: true };
  const bbox = (s: string, flag: string): BBox => {
    const p = s.split(',').map(Number);
    if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) throw new Error(`${flag}: expected w,s,e,n`);
    return [p[0], p[1], p[2], p[3]];
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    const need = () => { if (v === undefined) throw new Error(`${k} needs a value`); i++; return v; };
    switch (k) {
      case '--pbf': a.pbf = need(); break;
      case '--overpass': a.overpass = bbox(need(), k); break;
      case '--region': a.region = need(); break;
      case '--name': a.name = need(); break;
      case '--out': a.out = need(); break;
      case '--index': a.index = need(); break;
      case '--bbox': a.bbox = bbox(need(), k); break;
      case '--source': a.source = need(); break;
      case '--zoom': a.zoom = Number(need()); break;
      case '--no-sidewalk-glue': a.glueSidewalks = false; break;
      case '--no-service-glue': a.glueService = false; break;
      case '-h': case '--help': console.log(USAGE); process.exit(0); break;
      default: throw new Error(`unknown argument ${k}\n${USAGE}`);
    }
  }
  if (!a.pbf && !a.overpass) throw new Error(`one of --pbf or --overpass is required\n${USAGE}`);
  if (a.pbf && a.overpass) throw new Error('--pbf and --overpass are exclusive');
  if (!a.region || !/^[a-z0-9][a-z0-9-]*$/.test(a.region)) throw new Error('--region <id> is required (lowercase letters, digits, hyphens)');
  if (!a.name) throw new Error('--name "<name>" is required');
  a.out ??= join('public', 'graph', a.region);
  a.index ??= join('public', 'graph', 'index.json');
  return a as Args;
}

const log = (msg: string) => console.error(msg);
const mb = (b: number) => (b / 1e6).toFixed(2) + ' MB';

async function main(): Promise<void> {
  const t0 = performance.now();
  const args = parseArgs(process.argv.slice(2));
  const zoom = args.zoom;
  let ways: Iterable<OsmWay>;
  let source = args.source;
  let bbox: BBox | undefined = args.bbox;

  if (args.pbf) {
    const path = resolve(args.pbf);
    if (!existsSync(path)) throw new Error(`no such file: ${path}`);
    log(`reading ${path} (${mb(statSync(path).size)})`);
    const loaded = loadPbfWays(path, { keep: (t) => classifyWay(t).keep, bbox: args.bbox, log });
    ways = loaded.ways();
    source ??= `BBBike ${basename(path)} ${statSync(path).mtime.toISOString().slice(0, 10)}`;
    log(`ways to build: ${loaded.count} (${loaded.nodeCount} nodes, ${loaded.missing} missing)`);
  } else {
    bbox = args.overpass!;
    log(`fetching Overpass ways for [${bbox.join(', ')}]`);
    const fetched = await fetchOverpassWays(bbox, {
      onAttempt: (i) => log(i.error ? `  attempt ${i.attempt} at ${i.endpoint} failed: ${(i.error as Error).message ?? i.error}` : `  attempt ${i.attempt} at ${i.endpoint}`),
    });
    ways = fetched;
    source ??= `Overpass ${new Date().toISOString().slice(0, 10)}`;
    log(`fetched ${fetched.length} ways`);
  }

  const tb = performance.now();
  const result = buildGraphTiles(ways, { zoom, glueSidewalks: args.glueSidewalks, glueService: args.glueService });
  log(`graph: ${result.stats.ways} ways → ${result.stats.nodes} nodes, ${result.stats.arcs} arcs, ${result.stats.km.toFixed(1)} km, ${result.tiles.size} tiles (${((performance.now() - tb) / 1000).toFixed(1)} s)`);
  log(`glue: ${result.glue.candidates} candidate ways → ${result.glue.ways} kept as connectors, ${result.glue.arcs} arcs, ${result.glue.km.toFixed(1)} km (not counted in stats.km)`);
  const tc = performance.now();
  const conn = connectivity(result.tiles.values());
  for (const mode of ['walk', 'bike', 'drive'] as const) {
    const c = conn[mode];
    log(`connectivity ${mode}: largest component ${c.largest}/${c.nodes} nodes (${(100 * c.pct).toFixed(1)} %), ${c.components} components, ${c.arcs} arcs (${c.glueArcs} glue)`);
  }
  log(`connectivity computed in ${((performance.now() - tc) / 1000).toFixed(1)} s`);

  // ---- write tiles ----
  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  const tiles: RegionManifest['tiles'] = [];
  let bytes = 0, largest: [string, number] = ['', 0];
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const tw = performance.now();
  for (const t of result.tiles.values()) {
    const packed = packGraphTile(t);
    const rel = graphTilePath(t.tx, t.ty, zoom);
    const file = join(out, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, packed);
    tiles.push([t.tx, t.ty, packed.length]);
    bytes += packed.length;
    if (packed.length > largest[1]) largest = [rel, packed.length];
    for (let i = 0; i < t.nodeId.length; i++) {
      if (t.nodeFlags[i] & NodeFlag.FOREIGN) continue;
      const lon = t.nodeLon[i] / 1e7, lat = t.nodeLat[i] / 1e7;
      if (lon < west) west = lon; if (lon > east) east = lon; if (lat < south) south = lat; if (lat > north) north = lat;
    }
  }
  tiles.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  log(`wrote ${tiles.length} tiles, ${mb(bytes)} (${((performance.now() - tw) / 1000).toFixed(1)} s); largest ${largest[0]} ${mb(largest[1])}`);

  // ---- stale tiles from a previous build of this region ----
  const manifestPath = join(out, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const old = JSON.parse(readFileSync(manifestPath, 'utf8')) as RegionManifest;
      const now = new Set(tiles.map(([x, y]) => `${x}/${y}`));
      let removed = 0;
      for (const [x, y] of old.tiles ?? []) {
        if (now.has(`${x}/${y}`)) continue;
        const f = join(out, graphTilePath(x, y, old.zoom ?? zoom));
        if (existsSync(f)) { unlinkSync(f); removed++; }
      }
      if (removed) log(`removed ${removed} stale tiles from the previous build`);
    } catch (e) { log(`warning: could not read previous manifest: ${(e as Error).message}`); }
  }

  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  const manifest: RegionManifest = {
    id: args.region,
    name: args.name,
    zoom,
    bbox: bbox ?? (Number.isFinite(west) ? [round(west), round(south), round(east), round(north)] : [0, 0, 0, 0]),
    tiles,
    builtAt: new Date().toISOString(),
    source: source!,
    stats: { nodes: result.stats.nodes, arcs: result.stats.arcs, km: Math.round(result.stats.km * 10) / 10 },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));

  // ---- index.json: every region without its tile list ----
  const indexPath = resolve(args.index);
  type IndexEntry = Omit<RegionManifest, 'tiles'> & { tileCount: number; bytes: number };
  let index: IndexEntry[] = [];
  if (existsSync(indexPath)) {
    try { index = JSON.parse(readFileSync(indexPath, 'utf8')) as IndexEntry[]; } catch { index = []; }
    if (!Array.isArray(index)) index = [];
  }
  const { tiles: _tiles, ...rest } = manifest;
  void _tiles;
  index = index.filter((e) => e.id !== manifest.id);
  index.push({ ...rest, tileCount: tiles.length, bytes });
  index.sort((p, q) => p.id.localeCompare(q.id));
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

  const ru = process.resourceUsage();
  const wall = (performance.now() - t0) / 1000;
  console.log(JSON.stringify({
    region: manifest.id, name: manifest.name, source: manifest.source, bbox: manifest.bbox,
    ways: result.stats.ways, nodes: result.stats.nodes, arcs: result.stats.arcs, km: manifest.stats.km,
    tiles: tiles.length, bytes, largestTile: { path: largest[0], bytes: largest[1] },
    glue: { candidates: result.glue.candidates, ways: result.glue.ways, arcs: result.glue.arcs, km: Math.round(result.glue.km * 10) / 10, sidewalks: args.glueSidewalks, service: args.glueService },
    connectivity: Object.fromEntries((['walk', 'bike', 'drive'] as const).map((m) => [m, { pct: Math.round(conn[m].pct * 1000) / 1000, largest: conn[m].largest, nodes: conn[m].nodes, components: conn[m].components }])),
    wallS: Math.round(wall * 10) / 10, maxRssMB: Math.round(ru.maxRSS / 1024), out, index: indexPath,
  }, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `error: ${e.message}` : String(e));
  process.exit(1);
});
