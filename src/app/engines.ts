/**
 * Engine loading: the real grid/route workers (agents A and C) when their client modules exist
 * and boot, otherwise the in-page mocks. `?mock=1` forces the mocks. The import worker is ours
 * (src/app/import.worker.ts) and picks the real importers or the mock the same way.
 */
import * as Comlink from 'comlink';
import type { GridApi } from '../grid/api';
import type { LonLat, RouteApi } from '../routing/api';
import type { ImportFile, ImportOutcome, ImportProgressCb } from './import-types';
import type { ImportWorkerApi } from './import.worker';
import { createMockGrid } from './mock/grid';
import { createMockRoute } from './mock/route';
import { SynthCells } from './mock/synth';

export interface Engines {
  grid: GridApi;
  route: RouteApi;
  gridMock: boolean;
  routeMock: boolean;
  forceMock: boolean;
  importFiles(files: ImportFile[], onProgress?: ImportProgressCb): Promise<ImportOutcome[]>;
  /** Wrap a callback so it can cross a worker boundary (Comlink.proxy). Safe for in-page mocks too. */
  proxy<T extends object>(cb: T): T;
}

const gridMods = import.meta.glob<{ createGridClient: () => GridApi | Promise<GridApi> }>('../grid/client.ts');
const routeMods = import.meta.glob<{ createRouteClient: () => RouteApi | Promise<RouteApi> }>('../routing/client.ts');

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then((v) => { window.clearTimeout(t); resolve(v); }, (e) => { window.clearTimeout(t); reject(e); });
  });
}

async function loadRealGrid(): Promise<GridApi | null> {
  const loader = gridMods['../grid/client.ts'];
  if (!loader) return null;
  const mod = await withTimeout(loader(), 15_000, 'grid client import');
  const grid = await mod.createGridClient();
  await withTimeout(grid.init(), 20_000, 'grid.init');
  return grid;
}

async function loadRealRoute(baseUrl: string): Promise<RouteApi | null> {
  const loader = routeMods['../routing/client.ts'];
  if (!loader) return null;
  const mod = await withTimeout(loader(), 15_000, 'route client import');
  const route = await mod.createRouteClient();
  await withTimeout(route.init(baseUrl), 20_000, 'route.init');
  return route;
}

export async function loadEngines(opts: { forceMock: boolean; center: LonLat; baseUrl: string }): Promise<Engines> {
  let grid: GridApi | null = null;
  let route: RouteApi | null = null;
  const problems: string[] = [];
  if (!opts.forceMock) {
    const [g, r] = await Promise.allSettled([loadRealGrid(), loadRealRoute(opts.baseUrl)]);
    if (g.status === 'fulfilled') grid = g.value;
    else problems.push(`grid: ${String((g.reason as Error)?.message ?? g.reason)}`);
    if (r.status === 'fulfilled') route = r.value;
    else problems.push(`route: ${String((r.reason as Error)?.message ?? r.reason)}`);
  }
  let synth: SynthCells | null = null;
  const gridMock = !grid;
  const routeMock = !route;
  if (!grid) {
    const mg = createMockGrid(opts.center);
    synth = mg.synth;
    grid = mg;
    await grid.init();
  }
  if (!route) {
    route = createMockRoute(synth ?? new SynthCells(opts.center));
    await route.init(opts.baseUrl);
  }
  if (problems.length) console.warn('[unfog] engine fallback to mock:', problems.join('; '));

  let importWorker: Comlink.Remote<ImportWorkerApi> | null = null;
  const getImportWorker = () => {
    if (!importWorker) {
      const w = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
      importWorker = Comlink.wrap<ImportWorkerApi>(w);
    }
    return importWorker;
  };

  return {
    grid,
    route,
    gridMock,
    routeMock,
    forceMock: opts.forceMock,
    proxy: (cb) => Comlink.proxy(cb),
    async importFiles(files, onProgress) {
      const w = getImportWorker();
      const buffers = files.map((f) => f.bytes.buffer as ArrayBuffer);
      const payload = Comlink.transfer(files, buffers);
      return w.importFiles(payload, onProgress ? Comlink.proxy(onProgress) : undefined, opts.forceMock);
    },
  };
}
