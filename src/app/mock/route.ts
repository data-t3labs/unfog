/**
 * In-page RouteApi for mock mode: candidate routes walk the same synthetic street grid the
 * mock fog shows, "% new" is measured against the synthetic cells, and downloads are simulated.
 */
import type { BBox, CoverageReport, DownloadProgress, LoopRequest, LonLat, RouteApi, RouteCandidate, RouteRequest, RouteResult } from '../../routing/api';
import { lonLatToGraphTile, type Mode, type RegionManifest } from '../../routing/graph-format';
import { distanceM } from '../../grid/cell';
import { fromUV, toUV, type SynthCells } from './synth';

const SPEED_KMH: Record<Mode, number> = { walk: 4.8, bike: 15, drive: 30 };

const REGIONS: RegionManifest[] = [
  {
    id: 'nyc',
    name: 'New York City',
    zoom: 12,
    bbox: [-74.36, 40.48, -73.67, 40.96],
    tiles: [],
    builtAt: '2026-08-29',
    source: 'BBBike NewYork.osm.pbf (mock manifest)',
    stats: { nodes: 812_000, arcs: 1_450_000, km: 21_400 },
  },
  {
    id: 'vancouver',
    name: 'Metro Vancouver',
    zoom: 12,
    bbox: [-123.31, 49.0, -122.67, 49.42],
    tiles: [],
    builtAt: '2026-08-29',
    source: 'BBBike Vancouver.osm.pbf (mock manifest)',
    stats: { nodes: 310_000, arcs: 540_000, km: 9_800 },
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function inBBox(p: LonLat, b: BBox): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

export function createMockRoute(synth: SynthCells): RouteApi {
  const downloads: Array<{ id: string; center: LonLat; radiusKm: number; tiles: number; bytes: number; builtAt: string }> = [];
  const g = synth.grid;

  function covered(p: LonLat): boolean {
    if (REGIONS.some((r) => inBBox(p, r.bbox))) return true;
    return downloads.some((d) => distanceM(d.center[0], d.center[1], p[0], p[1]) <= d.radiusKm * 1000);
  }

  function legLength(path: LonLat[]): number {
    let len = 0;
    for (let i = 1; i < path.length; i++) len += distanceM(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    return len;
  }

  function newMetres(path: LonLat[]): number {
    let unseen = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const d = distanceM(a[0], a[1], b[0], b[1]);
      const n = Math.max(1, Math.ceil(d / 6));
      for (let t = 0; t <= n; t++) {
        const p: LonLat = [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n];
        if (!synth.seenAt(p)) unseen += d / (n + 1);
      }
    }
    return unseen;
  }

  /** Walk the grid intersections corner to corner (Manhattan steps); one vertex per intersection. */
  function walkCorners(corners: Array<[number, number]>): LonLat[] {
    const uv: Array<[number, number]> = [];
    let cur = corners[0];
    uv.push(cur);
    for (let c = 1; c < corners.length; c++) {
      const nxt = corners[c];
      const di = Math.sign(nxt[0] - cur[0]), dj = Math.sign(nxt[1] - cur[1]);
      while (cur[0] !== nxt[0] || cur[1] !== nxt[1]) {
        cur = [cur[0] + (cur[0] !== nxt[0] ? di : 0), cur[1] + (cur[0] === nxt[0] && cur[1] !== nxt[1] ? dj : 0)];
        uv.push(cur);
      }
    }
    return uv.map(([i, j]) => fromUV(g, i * g.su, j * g.sv));
  }

  function dedupe(path: LonLat[]): LonLat[] {
    return path.filter((p, k) => k === 0 || p[0] !== path[k - 1][0] || p[1] !== path[k - 1][1]);
  }

  /** Grid walk from → A → jogs → B → to, with vertices at every intersection. */
  function gridPath(from: LonLat, to: LonLat, dv: number, du: number): LonLat[] {
    const [ua, va] = toUV(g, from);
    const [ub, vb] = toUV(g, to);
    const iA = Math.round(ua / g.su), jA = Math.round(va / g.sv);
    const iB = Math.round(ub / g.su), jB = Math.round(vb / g.sv);
    const corners: Array<[number, number]> = [
      [iA, jA],
      [iA, jA + dv],
      [iB + du, jA + dv],
      [iB + du, jB],
      [iB, jB],
    ];
    return dedupe([from, ...walkCorners(corners), to]);
  }

  /**
   * Loops: rectangles of streets around the start (a blocks along the avenues × b along the
   * numbered streets, perimeter ≈ target) in all four quadrants; the three with the most
   * never-visited metres win, like the real engine's heading fan.
   */
  function loops(req: LoopRequest): RouteResult {
    const t0 = performance.now();
    const target = req.targetKm * 1000;
    const [u0, v0] = toUV(g, req.from);
    const i0 = Math.round(u0 / g.su), j0 = Math.round(v0 / g.sv);
    type Raw = { path: LonLat[]; len: number; newM: number };
    const raws: Raw[] = [];
    const maxA = Math.max(1, Math.floor(target / 2 / g.su));
    const stepA = Math.max(1, Math.ceil(maxA / 8));
    for (let a = 1; a <= maxA; a += stepA) {
      const b = Math.round((target / 2 - a * g.su) / g.sv);
      if (b < 1) continue;
      for (const [sa, sb] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        const corners: Array<[number, number]> = [[i0, j0], [i0 + sa * a, j0], [i0 + sa * a, j0 + sb * b], [i0, j0 + sb * b], [i0, j0]];
        const path = dedupe([req.from, ...walkCorners(corners), req.from]);
        const len = legLength(path);
        if (len < 0.75 * target || len > 1.25 * target) continue;
        raws.push({ path, len, newM: newMetres(path) });
      }
    }
    raws.sort((x, y) => y.newM - x.newM || Math.abs(x.len - target) - Math.abs(y.len - target));
    const picked: Raw[] = [];
    for (const r of raws) {
      if (picked.some((p) => Math.abs(p.newM - r.newM) < 40 && Math.abs(p.len - r.len) < 80)) continue;
      picked.push(r);
      if (picked.length === (req.maxCandidates ?? 3)) break;
    }
    const names: RouteCandidate['name'][] = ['Most new', 'Balanced', 'Direct'];
    const candidates: RouteCandidate[] = picked.map((r, i) => ({
      name: names[Math.min(i, 2)],
      coords: r.path,
      lengthM: Math.round(r.len),
      newM: Math.round(r.newM),
      pctNew: Math.round((100 * r.newM) / Math.max(1, r.len)),
      lambda: 1.5,
      etaMin: Math.round((r.len / 1000 / SPEED_KMH[req.mode]) * 60),
    }));
    return { candidates, shortestM: Math.round(target), budgetM: Math.round(1.25 * target), graphTiles: 4, ms: Math.round(performance.now() - t0) };
  }

  /** Same shape as the route worker's error: `name` tells the UI to offer a download. */
  function noCoverage(): Error {
    const e = new Error('No routing data for this area');
    e.name = 'NoCoverageError';
    return e;
  }

  function candidates(req: RouteRequest): RouteResult {
    const t0 = performance.now();
    type Raw = { path: LonLat[]; len: number; newM: number; key: string };
    const raws: Raw[] = [];
    for (let dv = -2; dv <= 2; dv++) {
      for (let du = -2; du <= 2; du++) {
        const path = gridPath(req.from, req.to, dv, du);
        raws.push({ path, len: legLength(path), newM: newMetres(path), key: `${dv}/${du}` });
      }
    }
    raws.sort((a, b) => a.len - b.len);
    const shortest = raws[0];
    const budget = shortest.len * (1 + req.detour);
    const within = raws.filter((r) => r.len <= budget + 1).sort((a, b) => b.newM - a.newM);
    const picked: Raw[] = [];
    for (const r of within) {
      if (r === shortest) continue;
      if (picked.some((p) => Math.abs(p.newM - r.newM) < 40 && Math.abs(p.len - r.len) < 80)) continue;
      picked.push(r);
      if (picked.length === (req.maxCandidates ?? 3) - 1) break;
    }
    picked.push(shortest);
    const names: RouteCandidate['name'][] = picked.length === 3 ? ['Most new', 'Balanced', 'Direct'] : picked.length === 2 ? ['Most new', 'Direct'] : ['Direct'];
    const lambdas = [3, 1, 0];
    const cands: RouteCandidate[] = picked.map((r, i) => ({
      name: names[i],
      coords: r.path,
      lengthM: Math.round(r.len),
      newM: Math.round(r.newM),
      pctNew: Math.round((100 * r.newM) / Math.max(1, r.len)),
      lambda: lambdas[i] ?? 0,
      etaMin: Math.round((r.len / 1000 / SPEED_KMH[req.mode]) * 60),
    }));
    return { candidates: cands, shortestM: Math.round(shortest.len), budgetM: Math.round(budget), graphTiles: 4, ms: Math.round(performance.now() - t0) };
  }

  return {
    async init() {},
    async listRegions() {
      return REGIONS;
    },
    async coverage(bbox: BBox): Promise<CoverageReport> {
      const [x0, y1] = lonLatToGraphTile(bbox[0], bbox[1]);
      const [x1, y0] = lonLatToGraphTile(bbox[2], bbox[3]);
      const needed = (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1);
      const c: LonLat = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
      const regions = REGIONS.filter((r) => inBBox(c, r.bbox)).map((r) => r.id);
      return { needed, available: covered(c) ? needed : 0, packable: 0, regions };
    },
    // No pack cache in mock mode: nothing is fetched, nothing is listed.
    async packsHasTile() {
      return false;
    },
    async packsFetchTiles(tiles) {
      return { fetched: 0, bytes: 0, uncovered: tiles.map(([x, y]) => `${x}/${y}`), failed: [], alreadyCached: 0 };
    },
    async packsListCached() {
      return [];
    },
    async packsEvict() {},
    async packsClear() {},
    async packsStatus() {
      return { indexAgeMs: Infinity, indexCells: 0, cells: [], totalBytes: 0, totalTiles: 0 };
    },
    async downloadRegion(regionId, onProgress) {
      const total = 24;
      for (let i = 1; i <= total; i++) {
        await sleep(60);
        onProgress?.({ phase: 'fetch', done: i, total });
      }
      const r = REGIONS.find((x) => x.id === regionId);
      return { tiles: total, bytes: r ? Math.round(r.stats.km * 900) : 0 };
    },
    async downloadArea(center, radiusKm, onProgress) {
      const phases: DownloadProgress['phase'][] = ['fetch', 'build', 'store'];
      for (const phase of phases) {
        const total = phase === 'fetch' ? 10 : 6;
        for (let i = 1; i <= total; i++) {
          await sleep(phase === 'fetch' ? 120 : 50);
          onProgress?.({ phase, done: i, total });
        }
      }
      const id = `area-${Date.now().toString(36)}`;
      const entry = { id, center, radiusKm, tiles: Math.max(1, Math.round((radiusKm * radiusKm) / 6)), bytes: Math.round(radiusKm * 380_000), builtAt: new Date().toISOString() };
      downloads.push(entry);
      return { tiles: entry.tiles, bytes: entry.bytes };
    },
    async listDownloads() {
      return downloads.slice();
    },
    async deleteDownload(id) {
      const i = downloads.findIndex((d) => d.id === id);
      if (i >= 0) downloads.splice(i, 1);
    },
    async route(req: RouteRequest): Promise<RouteResult> {
      await sleep(180);
      if (!covered(req.from) || !covered(req.to)) throw noCoverage();
      const far = distanceM(req.from[0], req.from[1], req.to[0], req.to[1]);
      if (far > 40_000) throw new Error('This destination is more than 40 km away. Pick something closer.');
      return candidates(req);
    },
    async directLine(req: RouteRequest): Promise<RouteResult> {
      await sleep(60);
      const path: LonLat[] = [req.from, req.to];
      const len = legLength(path), newM = newMetres(path);
      const direct: RouteCandidate = {
        name: 'Direct',
        coords: path,
        lengthM: Math.round(len),
        newM: Math.round(newM),
        pctNew: Math.round((100 * newM) / Math.max(1, len)),
        lambda: 0,
        etaMin: Math.round((len / 1000 / SPEED_KMH[req.mode]) * 60),
        parts: [{ kind: 'straight', coords: path, lengthM: len, newM }],
      };
      return { candidates: [direct], shortestM: direct.lengthM, budgetM: Math.round(len * (1 + req.detour)), graphTiles: 0, ms: 1 };
    },
    async loop(req: LoopRequest): Promise<RouteResult> {
      await sleep(150);
      if (!covered(req.from)) throw noCoverage();
      return loops(req);
    },
    async invalidateCells() {},
  };
}
