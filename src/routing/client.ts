/**
 * Main-thread handle on the route worker.
 *
 *   const routing = createRouteClient();
 *   await routing.init(import.meta.env.BASE_URL);
 *   const res = await routing.route({ from, to, mode: 'walk', detour: 0.25 });
 *
 * The returned object implements RouteApi directly: progress callbacks passed to
 * downloadRegion / downloadArea may be plain functions (they are wrapped with Comlink.proxy
 * here; wrapping them yourself is harmless). `remote` is the raw Comlink Remote if needed.
 *
 * Errors thrown in the worker arrive as Error instances with `name` and `message` preserved:
 * no graph data for a request → name 'NoCoverageError', message contains "coverage".
 */
import { proxy, wrap, type Remote } from 'comlink';
import type { DownloadProgress, RouteApi } from './api';

export interface RouteClient extends RouteApi {
  readonly remote: Remote<RouteApi>;
  readonly worker: Worker;
  terminate(): void;
}

export function createRouteClient(): RouteClient {
  const worker = new Worker(new URL('./route.worker.ts', import.meta.url), { type: 'module' });
  return wrapRouteApi(wrap<RouteApi>(worker), worker);
}

/** Adapt a Comlink Remote<RouteApi> to a plain RouteApi with callback proxying. */
export function wrapRouteApi(remote: Remote<RouteApi>, worker: Worker): RouteClient {
  const progress = (cb?: (p: DownloadProgress) => void) => (cb ? proxy(cb) : undefined);
  return {
    remote,
    worker,
    terminate: () => worker.terminate(),
    init: (baseUrl) => remote.init(baseUrl),
    listRegions: () => remote.listRegions(),
    coverage: (bbox) => remote.coverage(bbox),
    downloadRegion: (id, onProgress) => remote.downloadRegion(id, progress(onProgress)),
    downloadArea: (center, radiusKm, onProgress) => remote.downloadArea(center, radiusKm, progress(onProgress)),
    listDownloads: () => remote.listDownloads(),
    deleteDownload: (id) => remote.deleteDownload(id),
    route: (req) => remote.route(req),
    loop: (req) => remote.loop(req),
    invalidateCells: (version) => remote.invalidateCells(version),
  };
}

export { proxy as progressProxy };
