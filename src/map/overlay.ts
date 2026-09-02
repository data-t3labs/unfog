/**
 * `fog://` and `heat://` MapLibre protocols: `fog://{z}/{x}/{y}?v=N` → grid.renderTile → ImageBitmap.
 * The `v` query param is only there to bust MapLibre's tile cache when the grid version or the
 * render settings change (see map.ts bumpOverlay).
 */
import { addProtocol, type GetResourceResponse, type RequestParameters } from 'maplibre-gl';
import type { GridApi, OverlayMode, RenderSettings } from '../grid/api';

interface Provider {
  grid: GridApi;
  settings: () => RenderSettings;
}

let provider: Provider | null = null;
let registered = false;

/**
 * Pipeline counters (main-thread view: request → worker render → bitmap back), exposed as
 * `window.__unfog.perf` for the perf scripts / e2e. `ms` is the sum of round-trip latencies of
 * completed tiles, so during a pan `ms / done` is the average wait per tile including queueing.
 */
export const overlayPerf = { requested: 0, done: 0, aborted: 0, cancelled: 0, errors: 0, ms: 0, maxMs: 0 };
let nextRenderId = 1;

export function registerOverlayProtocols(grid: GridApi, settings: () => RenderSettings): void {
  provider = { grid, settings };
  if (registered) return;
  registered = true;
  addProtocol('fog', (p, a) => load('fog', p, a));
  addProtocol('heat', (p, a) => load('heat', p, a));
}

export function overlayTileUrl(mode: OverlayMode, version: number): string {
  return `${mode}://{z}/{x}/{y}?v=${version}`;
}

function abortError(): DOMException {
  return new DOMException('Tile request aborted', 'AbortError');
}

async function load(mode: OverlayMode, params: RequestParameters, abort: AbortController): Promise<GetResourceResponse<ImageBitmap>> {
  const m = /^(?:fog|heat):\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
  if (!m || !provider) throw new Error(`Bad overlay tile URL: ${params.url}`);
  if (abort.signal.aborted) throw abortError();
  const z = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
  const grid = provider.grid;
  const id = nextRenderId++;
  overlayPerf.requested++;
  // MapLibre aborts a tile that scrolled away: tell the worker so a render still queued is dropped.
  const onAbort = () => { void grid.cancelRender?.(id)?.catch(() => undefined); };
  abort.signal.addEventListener('abort', onAbort, { once: true });
  const t0 = performance.now();
  let result: ImageBitmap | Uint8ClampedArray;
  try {
    result = await grid.renderTile({ z, x, y, mode, size: 512, id }, provider.settings());
  } catch (e) {
    if (abort.signal.aborted) {
      overlayPerf.cancelled++; // dropped before it rendered
      throw abortError();
    }
    overlayPerf.errors++;
    throw e;
  } finally {
    abort.signal.removeEventListener('abort', onAbort);
  }
  if (abort.signal.aborted) {
    overlayPerf.aborted++; // rendered, but no longer wanted
    if (result instanceof ImageBitmap) result.close();
    throw abortError();
  }
  const dt = performance.now() - t0;
  overlayPerf.done++;
  overlayPerf.ms += dt;
  if (dt > overlayPerf.maxMs) overlayPerf.maxMs = dt;
  if (result instanceof ImageBitmap) return { data: result };
  const bytes = result as Uint8ClampedArray<ArrayBuffer>;
  const data = await createImageBitmap(new ImageData(bytes, 512, 512));
  return { data };
}
