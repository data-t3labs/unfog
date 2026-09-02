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
  const result = await provider.grid.renderTile({ z, x, y, mode, size: 512 }, provider.settings());
  if (abort.signal.aborted) {
    if (result instanceof ImageBitmap) result.close();
    throw abortError();
  }
  if (result instanceof ImageBitmap) return { data: result };
  const bytes = result as Uint8ClampedArray<ArrayBuffer>;
  const data = await createImageBitmap(new ImageData(bytes, 512, 512));
  return { data };
}
