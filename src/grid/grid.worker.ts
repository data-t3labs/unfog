/**
 * Grid worker: the only writer of the `unfog` database, and the fog/heat tile renderer. Exposes
 * GridApi (api.ts) over Comlink; the main thread talks to it through client.ts.
 */
/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { renderOverlayTile } from '../render/tiles';
import type { GridApi, RenderSettings, RenderTileRequest } from './api';
import { CellStore } from './store';
import type { CellCounts, Level } from './types';

const store = new CellStore();

async function renderTile(req: RenderTileRequest, settings: RenderSettings): Promise<ImageBitmap | Uint8ClampedArray> {
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
  getTileCounts,
  listBaseTiles: () => store.listBaseTiles(),
  exportBackup: () => store.exportBackup(),
  importBackup: (bytes) => store.importBackup(bytes),
  listTracks: () => store.listTracks(),
  getTrack: (id) => store.getTrack(id),
  deleteTrack: (id) => store.deleteTrack(id),
  deleteAll: () => store.deleteAll(),
};

Comlink.expose(api);
