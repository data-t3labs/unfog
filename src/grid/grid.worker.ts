/**
 * Grid worker: the only writer of the `unfog` database, and the fog/heat tile renderer. Exposes
 * GridApi (api.ts) over Comlink; the main thread talks to it through client.ts.
 *
 * Renders go through a queue, one at a time, with a yield to the event loop between tiles:
 * MapLibre aborts tiles that scroll or zoom away, the main thread forwards that as
 * `cancelRender(id)`, and a cancelled tile still waiting in the queue is dropped instead of
 * rendered (a z11→z17 zoom sweep used to spend 26 % of its renders on tiles nobody would see).
 */
/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { renderOverlayTile } from '../render/tiles';
import type { GridApi, RenderSettings, RenderTileRequest } from './api';
import { CellStore } from './store';
import type { CellCounts, Level } from './types';

const store = new CellStore();

type RenderResult = ImageBitmap | Uint8ClampedArray;

interface RenderJob {
  req: RenderTileRequest;
  settings: RenderSettings;
  resolve: (r: RenderResult) => void;
  reject: (e: Error) => void;
}

const queue: RenderJob[] = [];
let pumping = false;
/** Cancelled renders skipped before they started (diagnostics, via perf()). */
let cancelledRenders = 0;

// A MessageChannel hop yields to the event loop without the timer clamp: messages that arrived
// from the main thread during a render (cancels, other calls) are handled before the next tile.
const yieldChannel = new MessageChannel();
function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => {
    yieldChannel.port1.onmessage = () => resolve();
    yieldChannel.port2.postMessage(0);
  });
}

async function renderNow(req: RenderTileRequest, settings: RenderSettings): Promise<RenderResult> {
  const size = req.size ?? 512;
  const rgba = await renderOverlayTile(req, settings, store);
  // ImageBitmap when the worker can make one (Safari 15+, Chrome); the main thread then uploads it
  // straight to the GPU. Otherwise the raw bytes travel (transferred, not copied).
  if (typeof createImageBitmap === 'function' && typeof ImageData === 'function') {
    const bitmap = await createImageBitmap(new ImageData(rgba, size, size));
    return Comlink.transfer(bitmap, [bitmap]);
  }
  return Comlink.transfer(rgba, [rgba.buffer]);
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const job = queue.shift() as RenderJob;
      try {
        job.resolve(await renderNow(job.req, job.settings));
      } catch (e) {
        job.reject(e as Error);
      }
      if (queue.length) await yieldToEvents();
    }
  } finally {
    pumping = false;
  }
}

function renderTile(req: RenderTileRequest, settings: RenderSettings): Promise<RenderResult> {
  return new Promise<RenderResult>((resolve, reject) => {
    queue.push({ req, settings, resolve, reject });
    void pump();
  });
}

async function cancelRender(id: number): Promise<void> {
  const i = queue.findIndex((j) => j.req.id === id);
  if (i < 0) return; // already rendering or done
  const [job] = queue.splice(i, 1);
  cancelledRenders++;
  const err = new Error('Render cancelled');
  err.name = 'AbortError';
  job.reject(err);
}

async function getTileCounts(level: Level, tx: number, ty: number): Promise<CellCounts | null> {
  // The store hands out its cached array; copy so the caller owns what it receives.
  const counts = await store.getTile(level, tx, ty);
  return counts ? counts.slice() : null;
}

const api: GridApi = {
  init: () => store.init(),
  getStats: () => store.getStats(),
  applyPayload: (payload) => store.applyPayload(payload),
  markTrack: (track) => store.markTrack(track),
  renderTile,
  cancelRender,
  getTileCounts,
  listBaseTiles: () => store.listBaseTiles(),
  exportBackup: () => store.exportBackup(),
  importBackup: (bytes) => store.importBackup(bytes),
  listTracks: () => store.listTracks(),
  getTrack: (id) => store.getTrack(id),
  deleteTrack: (id) => store.deleteTrack(id),
  deleteAll: () => store.deleteAll(),
};

// `perf()` is a diagnostics extra outside GridApi (the perf scripts read it as `grid.perf()`).
Comlink.expose(Object.assign(api, { perf: () => ({ ...store.perf, cancelledRenders, queued: queue.length }) }));
