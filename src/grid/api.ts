/**
 * Contract between the main thread and the grid worker (Comlink). Fixed in wave 0 so the UI
 * (wave 2) and the store/renderer (wave 1) can be built in parallel. Implementations live in
 * src/grid/grid.worker.ts; the main thread wraps it in src/grid/client.ts.
 */
import type { CellCounts, GridStats, ImportPayload, Level, Track } from './types';

export type OverlayMode = 'fog' | 'heat';

/** User-tunable look of the overlays (persisted in settings; defaults = the approved mockups). */
export interface RenderSettings {
  /** Fog opacity over never-visited ground, 0..1. Default 0.80. */
  fogAlpha: number;
  /** Fog colour RGB. Default [16, 20, 30]. */
  fogColor: [number, number, number];
  /** Wide-feather sigma in cells (the deep halo). Default 4.5, range 2..6. */
  feather: number;
  /** How much of the fog the halo lifts, 0..0.8. Default 0.65. */
  halo: number;
  /** Cleared core: 1 = cell + 8 neighbours (~3 cells ≈ 20 m, default), 0 = the cell only (~7 m). */
  coreRadius: 0 | 1;
  /** Heat mode: dim layer alpha over the basemap. Default 0.68. */
  heatDim: number;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  fogAlpha: 0.8,
  fogColor: [16, 20, 30],
  feather: 4.5,
  halo: 0.65,
  coreRadius: 1,
  heatDim: 0.68,
};

export interface RenderTileRequest {
  z: number;
  x: number;
  y: number;
  mode: OverlayMode;
  /** Output pixels per side. Default 512. */
  size?: 256 | 512;
  /** Caller-chosen id so a render still waiting in the worker's queue can be dropped (`cancelRender`). */
  id?: number;
}

export interface TrackSummary {
  id: string;
  source: string;
  name?: string;
  points: number;
  startMs?: number;
  endMs?: number;
  lengthM: number;
}

export interface ApplyResult {
  stats: GridStats;
  /** Base tiles touched by this operation (for map refresh). */
  touched: Array<{ tx: number; ty: number }>;
}

export interface GridApi {
  /** Open the database, load stats. Idempotent. */
  init(): Promise<GridStats>;
  getStats(): Promise<GridStats>;
  /** Merge an import (FoW cell tiles = max(count,1); tracks = +1 per touched cell per track). */
  applyPayload(payload: ImportPayload): Promise<ApplyResult>;
  /** Add one track (a recording session or a single imported track). */
  markTrack(track: Track): Promise<ApplyResult>;
  /**
   * Render one overlay tile as premultiplied-free RGBA. Returns an ImageBitmap when the worker
   * supports createImageBitmap, otherwise the raw RGBA bytes (size×size×4) for the main thread
   * to wrap. Either is transferred, not copied.
   */
  renderTile(req: RenderTileRequest, settings: RenderSettings): Promise<ImageBitmap | Uint8ClampedArray>;
  /**
   * The map no longer needs the render queued under `RenderTileRequest.id` (it scrolled away):
   * drop it if it has not started; its `renderTile` promise then rejects. No-op otherwise.
   */
  cancelRender?(id: number): Promise<void>;
  /** Raw counts for one tile (any level) or null if empty. Used by stats views and tests. */
  getTileCounts(level: Level, tx: number, ty: number): Promise<CellCounts | null>;
  /** Base-level tiles with data, as [tx, ty] pairs — for "where is my data" bounds. */
  listBaseTiles(): Promise<Array<[number, number]>>;
  /** Backup zip bytes (see docs/BUILD-PLAN.md §2.5). */
  exportBackup(): Promise<Uint8Array>;
  importBackup(bytes: Uint8Array): Promise<ApplyResult>;
  listTracks(): Promise<TrackSummary[]>;
  getTrack(id: string): Promise<Track | null>;
  deleteTrack(id: string): Promise<GridStats>;
  /** Wipe everything (asks for confirmation in the UI, never here). */
  deleteAll(): Promise<GridStats>;
}
