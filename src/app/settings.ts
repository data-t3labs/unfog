/**
 * App settings: persisted in localStorage, observable. Render-related settings are turned into
 * the RenderSettings the grid worker consumes (see ../grid/api.ts).
 */
import { DEFAULT_RENDER_SETTINGS, type RenderSettings } from '../grid/api';

/** Map (OpenFreeMap bright), Dark (OpenFreeMap fiord, night look), Satellite (Esri World Imagery + OpenFreeMap labels). */
export type Basemap = 'bright' | 'dark' | 'satellite';
export type Units = 'metric' | 'imperial';
export type OverlayLayer = 'fog' | 'heat' | 'off';

export interface AppSettings {
  basemap: Basemap;
  units: Units;
  layer: OverlayLayer;
  /** Wide-feather sigma in cells, 2..6 (default 4.5). */
  feather: number;
  /** Halo strength 0..0.8 (default 0.65). */
  halo: number;
  /** 1 = cell + neighbours (~20 m core), 0 = the cell only (tight). */
  coreRadius: 0 | 1;
  /** Fog strength over never-visited ground, 0.5..0.95. */
  fogAlpha: number;
}

const KEY = 'unfog.settings';

export const DEFAULT_SETTINGS: AppSettings = {
  basemap: 'bright',
  units: 'metric',
  layer: 'fog',
  feather: DEFAULT_RENDER_SETTINGS.feather,
  halo: DEFAULT_RENDER_SETTINGS.halo,
  coreRadius: DEFAULT_RENDER_SETTINGS.coreRadius,
  fogAlpha: DEFAULT_RENDER_SETTINGS.fogAlpha,
};

type Listener = (s: AppSettings, changed: Array<keyof AppSettings>) => void;
const listeners = new Set<Listener>();
let current: AppSettings = load();

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return sanitize({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
}

function sanitize(s: AppSettings): AppSettings {
  return {
    basemap: s.basemap === 'dark' || s.basemap === 'satellite' ? s.basemap : 'bright',
    units: s.units === 'imperial' ? 'imperial' : 'metric',
    layer: s.layer === 'heat' || s.layer === 'off' ? s.layer : 'fog',
    feather: clamp(s.feather, 2, 6, DEFAULT_SETTINGS.feather),
    halo: clamp(s.halo, 0, 0.8, DEFAULT_SETTINGS.halo),
    coreRadius: s.coreRadius === 0 ? 0 : 1,
    fogAlpha: clamp(s.fogAlpha, 0.5, 0.95, DEFAULT_SETTINGS.fogAlpha),
  };
}

export function getSettings(): AppSettings {
  return current;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = sanitize({ ...current, ...patch });
  const changed = (Object.keys(next) as Array<keyof AppSettings>).filter((k) => next[k] !== current[k]);
  if (changed.length === 0) return current;
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode / quota — settings just don't persist */
  }
  for (const l of listeners) l(current, changed);
  return current;
}

export function onSettingsChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Keys whose change requires re-rendering the overlay tiles. */
export const RENDER_KEYS: ReadonlyArray<keyof AppSettings> = ['basemap', 'feather', 'halo', 'coreRadius', 'fogAlpha'];

/**
 * Night look ("Dark map", docs/BUILD-PLAN.md §2.2): the unknown stays dark — a navy ink at the
 * user's fog strength over the OpenFreeMap `fiord` basemap — and the streets you have walked are
 * LIT: a warm cream light laid over the cleared ground (the inverse of the daytime hole in dark
 * fog, same reading: unknown = dark, known = light). The heat dim layer is the same ink, a
 * little lighter than by day so the ramp sits on navy rather than on black.
 */
export const NIGHT_RENDER: Pick<RenderSettings, 'fogColor' | 'clearColor' | 'clearAlpha' | 'heatDim' | 'heatDimColor'> = {
  fogColor: [6, 9, 22],
  clearColor: [255, 232, 200],
  clearAlpha: 0.32,
  heatDim: 0.5,
  heatDimColor: [6, 9, 22],
};

/**
 * Satellite look (feedback-1 item 4): the photo is the reward, so cleared ground shows the imagery
 * untinted (no night light) under a near-black fog — the Fog of World reading. Imagery is far
 * darker than the bright basemap (rooftops, asphalt, trees), so the fog goes on at 0.9× the
 * user's strength (default 0.80 → 0.72): unexplored blocks keep a trace of street structure
 * instead of turning into a black hole, while the edge against a revealed block stays obvious.
 * The heat dim layer is the same ink at 0.72 (a lighter dim reads as haze over a photo).
 */
export const SATELLITE_RENDER: Pick<RenderSettings, 'fogColor' | 'heatDim' | 'heatDimColor'> = {
  fogColor: [6, 8, 12],
  heatDim: 0.72,
  heatDimColor: [6, 8, 12],
};
export const SATELLITE_FOG_SCALE = 0.9;

/** The RenderSettings handed to grid.renderTile for the current settings. */
export function renderSettings(s: AppSettings = current): RenderSettings {
  if (s.basemap === 'dark') {
    return {
      ...DEFAULT_RENDER_SETTINGS,
      ...NIGHT_RENDER,
      fogAlpha: s.fogAlpha,
      feather: s.feather,
      halo: s.halo,
      coreRadius: s.coreRadius,
    };
  }
  if (s.basemap === 'satellite') {
    return {
      ...DEFAULT_RENDER_SETTINGS,
      ...SATELLITE_RENDER,
      fogAlpha: Math.round(s.fogAlpha * SATELLITE_FOG_SCALE * 100) / 100,
      feather: s.feather,
      halo: s.halo,
      coreRadius: s.coreRadius,
    };
  }
  return {
    ...DEFAULT_RENDER_SETTINGS,
    fogAlpha: s.fogAlpha,
    feather: s.feather,
    halo: s.halo,
    coreRadius: s.coreRadius,
  };
}

/** Small typed helpers for other localStorage-backed state (camera, backup dates, sessions). */
export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
