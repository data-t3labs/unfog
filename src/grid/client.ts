/**
 * Main-thread handle to the grid worker. One worker per app; call `init()` once before use.
 *
 *   const grid = createGridClient();
 *   await grid.init();
 *   const bitmap = await grid.renderTile({ z, x, y, mode: 'fog' }, settings);
 */
import * as Comlink from 'comlink';
import type { GridApi } from './api';

export type GridClient = Comlink.Remote<GridApi>;

export function createGridClient(): GridClient {
  return createGridWorker().api;
}

/** Same, but also returns the Worker so the app can terminate it (tests, hot reload). */
export function createGridWorker(): { api: GridClient; worker: Worker } {
  const worker = new Worker(new URL('./grid.worker.ts', import.meta.url), { type: 'module', name: 'unfog-grid' });
  return { api: Comlink.wrap<GridApi>(worker), worker };
}
