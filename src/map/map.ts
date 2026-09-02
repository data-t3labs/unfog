/**
 * MapLibre setup: basemap (OpenFreeMap bright / fiord for "Dark map"), fog/heat raster overlay via the custom
 * protocols, route layers, user dot + destination pin, follow mode, long-press, camera memory.
 */
import * as maplibregl from 'maplibre-gl';
import type { RasterTileSource, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 resolves its worker as `./maplibre-gl-worker.mjs` next to import.meta.url, which
// neither Vite's dev pre-bundle nor the production chunk provides. Bundle the worker (with its
// shared chunk) through Vite and point MapLibre at it.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(maplibreWorkerUrl);
import type { GridApi, OverlayMode, RenderSettings } from '../grid/api';
import type { LonLat, RouteCandidate } from '../routing/api';
import type { Basemap, OverlayLayer } from '../app/settings';
import { readJSON, writeJSON } from '../app/settings';
import { icons } from '../app/icons';
import { overlayTileUrl, registerOverlayProtocols } from './overlay';
import { RouteLayers } from './routes';
import { SATELLITE_GROUND, composeSatelliteStyle, hasSatelliteLabels, satelliteBaseStyle } from './satellite';
import { overlayTileIdsFor } from './tile-ids';
import type { Fix } from './location';

/**
 * "Dark map" uses OpenFreeMap `fiord`, not `dark`: `dark` paints ground, buildings and roads
 * within ~10 L* of black, so nothing survives under a fog and visited streets are invisible;
 * `fiord` is a navy ground with roads lighter than the ground, which a dark fog can carve out
 * (docs/BUILD-PLAN.md §2.2, night mode). The setting value stays `dark`. Satellite is composed
 * at runtime (src/map/satellite.ts) from Esri imagery and the bright style's labels.
 */
export const STYLE_URLS: Record<Exclude<Basemap, 'satellite'>, string> = {
  bright: 'https://tiles.openfreemap.org/styles/bright',
  dark: 'https://tiles.openfreemap.org/styles/fiord',
};

/** The bright style JSON, fetched once per page for the satellite labels (the service worker caches the request). */
let brightStyleJson: StyleSpecification | null = null;
let brightStyleFetch: Promise<StyleSpecification | null> | null = null;
function fetchBrightStyle(): Promise<StyleSpecification | null> {
  if (brightStyleJson) return Promise.resolve(brightStyleJson);
  brightStyleFetch ??= fetch(STYLE_URLS.bright)
    .then((r) => (r.ok ? (r.json() as Promise<StyleSpecification>) : null))
    .then((json) => {
      brightStyleJson = json;
      return json;
    })
    .catch(() => null)
    .finally(() => {
      brightStyleFetch = null;
    });
  return brightStyleFetch;
}
/** Night mode: fiord's building footprints (fill-opacity .25) are pushed back so lit blocks read as light, not texture. */
const NIGHT_BUILDING_OPACITY = 0.15;

/** Bedford Av & N 7th St, Williamsburg — the default view before we know where the user is. */
export const DEFAULT_CENTER: LonLat = [-73.9568, 40.7176];
export const DEFAULT_ZOOM = 15;

const CAMERA_KEY = 'unfog.camera';
const OVERLAY_SOURCE = 'unfog-overlay';
const OVERLAY_LAYER = 'unfog-overlay';
const OVERLAY_MIN_ZOOM = 2;
const OVERLAY_MAX_ZOOM = 18;
/** More touched tiles than this since the last full reload → reload everything instead. */
const MAX_PARTIAL_REFRESH = 48;
const HIDE_SYMBOLS = /^poi|transit|housenumber|airport|station/;

/**
 * Basemap-less style used when the OpenFreeMap style cannot be fetched (offline before the service
 * worker cached it, host down). Without a loaded style MapLibre never fires `load`, so the fog
 * overlay, the route layers and everything gated on `onReady` would never appear. A plain ground
 * keeps the fog/heat overlay and routing usable; the real style is retried on `online`.
 */
export const FALLBACK_STYLE_NAME = 'unfog-fallback';
const FALLBACK_GROUND: Record<Basemap, string> = { bright: '#e9e6df', dark: '#45516e', satellite: SATELLITE_GROUND };
function fallbackStyle(basemap: Basemap): StyleSpecification {
  return {
    version: 8,
    name: FALLBACK_STYLE_NAME,
    sources: {},
    layers: [{ id: 'unfog-ground', type: 'background', paint: { 'background-color': FALLBACK_GROUND[basemap] } }],
  };
}

interface SavedCamera {
  c: LonLat;
  z: number;
  b?: number;
}

/** Style for a basemap: a URL for the vector maps; for satellite the composed style, or imagery alone until the label JSON is in memory. */
function styleFor(b: Basemap): string | StyleSpecification {
  if (b !== 'satellite') return STYLE_URLS[b];
  return brightStyleJson ? composeSatelliteStyle(brightStyleJson) : satelliteBaseStyle();
}

/** The last saved map centre (used to seed the mock engines before the map exists). */
export function savedCenter(): LonLat | null {
  const saved = readJSON<SavedCamera | null>(CAMERA_KEY, null);
  return saved && Array.isArray(saved.c) && saved.c.length === 2 ? saved.c : null;
}

export interface UnfogMapOptions {
  container: HTMLElement;
  grid: GridApi;
  renderSettings: () => RenderSettings;
  basemap: Basemap;
  layer: OverlayLayer;
}

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export class UnfogMap {
  readonly map: maplibregl.Map;
  readonly routes: RouteLayers;
  private layer: OverlayLayer;
  private version = 1;
  private basemap: Basemap;
  private readonly userEl: HTMLElement;
  private readonly userMarker: maplibregl.Marker;
  private destMarker: maplibregl.Marker | null = null;
  private longPressCb: ((ll: LonLat) => void) | null = null;
  private followCb: ((on: boolean) => void) | null = null;
  private readyCbs: Array<() => void> = [];
  private ready = false;
  private routeMode = false;
  /** A style (real or fallback) has loaded at least once. */
  private styleLoaded = false;
  /** The fallback style is showing instead of the basemap. */
  private onFallback = false;
  follow = false;
  lastFix: Fix | null = null;

  constructor(opts: UnfogMapOptions) {
    registerOverlayProtocols(opts.grid, opts.renderSettings);
    this.layer = opts.layer;
    this.basemap = opts.basemap;
    const saved = readJSON<SavedCamera | null>(CAMERA_KEY, null);
    const map = new maplibregl.Map({
      container: opts.container,
      style: styleFor(opts.basemap),
      center: saved?.c ?? DEFAULT_CENTER,
      zoom: saved?.z ?? DEFAULT_ZOOM,
      bearing: saved?.b ?? 0,
      pitch: 0,
      maxPitch: 0,
      pixelRatio: Math.min(2, window.devicePixelRatio || 1),
      attributionControl: false,
      maxZoom: 19,
      minZoom: 2,
      dragRotate: false,
      touchPitch: false,
      fadeDuration: 0,
    });
    const attribution = new maplibregl.AttributionControl({ compact: true });
    map.addControl(attribution, 'bottom-left');
    map.once('load', () => {
      // MapLibre opens the compact attribution on small screens; start it collapsed (the ⓘ toggles it).
      const c = (attribution as unknown as { _container?: HTMLElement })._container;
      c?.classList.remove('maplibregl-compact-show');
      c?.removeAttribute('open');
    });
    map.touchZoomRotate.disableRotation();
    this.map = map;
    this.routes = new RouteLayers(map);

    this.userEl = document.createElement('div');
    this.userEl.className = 'user-dot';
    this.userEl.innerHTML = '<div class="user-dot-halo"></div><div class="user-dot-core"></div>';
    this.userMarker = new maplibregl.Marker({ element: this.userEl, anchor: 'center' });

    map.on('style.load', () => {
      this.styleLoaded = true;
      this.onFallback = map.getStyle()?.name === FALLBACK_STYLE_NAME;
      this.onStyleLoad();
    });
    map.on('load', () => {
      this.ready = true;
      for (const cb of this.readyCbs) cb();
      this.readyCbs = [];
    });
    map.on('moveend', () => this.saveCamera());
    map.on('dragstart', () => this.userMoved());
    map.on('wheel', () => this.userMoved());
    map.on('error', (e) => {
      const msg = e.error?.message ?? '';
      // Before any style has loaded, an error that is not about a tile/source is the style request
      // itself failing (offline, host down): fall back to the plain ground so the app still works.
      const ev = e as unknown as Record<string, unknown>;
      if (!this.styleLoaded && !('tile' in ev) && !('sourceId' in ev) && !('source' in ev)) {
        console.warn('[map] basemap style unavailable, using the plain fallback:', msg);
        this.useFallbackStyle();
        return;
      }
      // Tile errors are noisy offline; keep the console useful.
      if (!/tile|fetch|network/i.test(msg)) console.warn('[map]', msg);
    });
    window.addEventListener('online', () => this.retryBasemap());
    this.installLongPress();
    if (opts.basemap === 'satellite') void this.ensureSatelliteLabels();
  }

  private useFallbackStyle(): void {
    this.onFallback = true;
    this.map.setStyle(fallbackStyle(this.basemap), { diff: false });
  }

  /** Connectivity is back: swap the fallback ground for the real basemap; fetch the satellite labels. */
  private retryBasemap(): void {
    if (this.onFallback) this.map.setStyle(styleFor(this.basemap), { diff: false });
    else if (this.basemap === 'satellite') void this.ensureSatelliteLabels();
  }

  /**
   * Satellite starts as imagery alone when the bright style JSON is not in memory yet; once it
   * arrives (network or the service worker's cache) the composed style — imagery + labels — replaces
   * it. A full style load (no diff): the overlay and route layers come back through onStyleLoad.
   */
  private async ensureSatelliteLabels(): Promise<void> {
    if (this.basemap !== 'satellite' || hasSatelliteLabels(this.map.getStyle())) return;
    const bright = await fetchBrightStyle();
    if (!bright || this.basemap !== 'satellite' || hasSatelliteLabels(this.map.getStyle())) return;
    this.map.setStyle(composeSatelliteStyle(bright), { diff: false });
  }

  /** True while the plain fallback ground is showing instead of the basemap. */
  get basemapUnavailable(): boolean {
    return this.onFallback;
  }

  onReady(cb: () => void): void {
    if (this.ready) cb();
    else this.readyCbs.push(cb);
  }

  private onStyleLoad(): void {
    const map = this.map;
    const style = map.getStyle();
    for (const l of style.layers) {
      if (l.type === 'symbol' && HIDE_SYMBOLS.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
    }
    if (this.basemap === 'dark' && map.getLayer('building')) map.setPaintProperty('building', 'fill-opacity', NIGHT_BUILDING_OPACITY);
    // The overlay goes above every area fill (ground, water, buildings) and below the labels: the
    // first symbol layer AFTER the last fill. Plain "first symbol" is the same layer in `bright`
    // and `fiord`, but OpenFreeMap `dark` lists `water_name` before `building`, which put the fog
    // under the buildings and roads.
    const lastFill = style.layers.map((l) => l.type).lastIndexOf('fill');
    const firstSymbol = style.layers.find((l, i) => l.type === 'symbol' && i > lastFill)?.id;
    if (!map.getSource(OVERLAY_SOURCE)) {
      this.tileMode = this.overlayMode();
      this.pendingTouched.clear(); // fresh source: every tile renders from the current store
      map.addSource(OVERLAY_SOURCE, {
        type: 'raster',
        tiles: [overlayTileUrl(this.tileMode, this.version)],
        tileSize: 512,
        minzoom: OVERLAY_MIN_ZOOM,
        maxzoom: OVERLAY_MAX_ZOOM,
        attribution: '',
      });
    }
    if (!map.getLayer(OVERLAY_LAYER)) {
      map.addLayer(
        {
          id: OVERLAY_LAYER,
          type: 'raster',
          source: OVERLAY_SOURCE,
          layout: { visibility: this.layer === 'off' ? 'none' : 'visible' },
          paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0, 'raster-opacity': this.routeMode ? 0.9 : 1 },
        },
        firstSymbol,
      );
    }
    this.routes.ensure();
  }

  private overlayMode(): OverlayMode {
    return this.layer === 'heat' ? 'heat' : 'fog';
  }

  /** Fog / Heat / Off. */
  setLayer(layer: OverlayLayer): void {
    this.layer = layer;
    if (!this.map.getLayer(OVERLAY_LAYER)) return;
    this.map.setLayoutProperty(OVERLAY_LAYER, 'visibility', layer === 'off' ? 'none' : 'visible');
    // A hidden source is not updated by MapLibre: tiles touched while it was off are stale.
    if (layer !== 'off' && (this.overlayMode() !== this.tileMode || this.pendingTouched.size)) this.reloadOverlay();
  }

  /** Grid data or render settings changed: re-render every overlay tile. */
  bumpOverlay(): void {
    this.version++;
    this.reloadOverlay();
  }

  /**
   * Base (z14) cell tiles changed (a recording checkpoint): re-render only the overlay tiles in
   * view that cover them — `map.refreshTiles` reloads matching tiles in place, the old bitmap
   * staying up until the new one lands, so the fog follows the walk without a full reload every
   * few seconds. Touched tiles accumulate until the next full reload (bumpOverlay / layer or
   * style change): a tile that scrolls back into view after it changed is refreshed on the next
   * checkpoint, and MapLibre's retained-tile cache is dropped by the full reload.
   */
  refreshOverlay(touched: ReadonlyArray<{ tx: number; ty: number }>): void {
    for (const t of touched) this.pendingTouched.set(`${t.tx}/${t.ty}`, t);
    if (this.layer === 'off' || !this.map.getSource(OVERLAY_SOURCE)) return;
    if (this.pendingTouched.size > MAX_PARTIAL_REFRESH) {
      this.bumpOverlay();
      return;
    }
    this.map.refreshTiles(OVERLAY_SOURCE, overlayTileIdsFor(this.pendingTouched.values(), OVERLAY_MIN_ZOOM, OVERLAY_MAX_ZOOM));
  }

  /** The mode the raster source's tile URLs currently point at. */
  private tileMode: OverlayMode = 'fog';
  /** z14 tiles changed since the last full overlay reload (see refreshOverlay). */
  private readonly pendingTouched = new Map<string, { tx: number; ty: number }>();

  private reloadOverlay(): void {
    const src = this.map.getSource(OVERLAY_SOURCE) as RasterTileSource | undefined;
    if (!src) return;
    this.tileMode = this.overlayMode();
    this.pendingTouched.clear();
    src.setTiles([overlayTileUrl(this.tileMode, this.version)]);
  }

  setBasemap(b: Basemap): void {
    if (b === this.basemap) return;
    this.basemap = b;
    this.onFallback = false;
    // The render settings change with the basemap (night / satellite look): new tile URLs, so no
    // tile rendered for the other look is reused. Overlay/route layers are re-added by
    // onStyleLoad; markers survive a style swap.
    this.version++;
    this.map.setStyle(styleFor(b), { diff: false });
    if (b === 'satellite') void this.ensureSatelliteLabels();
  }

  /** Whether the satellite basemap currently shows its street/place labels (false while they load or offline). */
  get satelliteLabelsOn(): boolean {
    return hasSatelliteLabels(this.map.getStyle());
  }

  /** Dim the overlay slightly while routes are shown (as in the route mockup). */
  setRouteMode(on: boolean): void {
    this.routeMode = on;
    if (this.map.getLayer(OVERLAY_LAYER)) this.map.setPaintProperty(OVERLAY_LAYER, 'raster-opacity', on ? 0.9 : 1);
  }

  // ------------------------------------------------------------------ location

  setUserPosition(fix: Fix | null): void {
    this.lastFix = fix;
    if (!fix) {
      this.userMarker.remove();
      return;
    }
    this.userMarker.setLngLat([fix.lon, fix.lat]);
    if (!this.userEl.isConnected) this.userMarker.addTo(this.map);
    this.userEl.classList.toggle('coarse', fix.accuracy > 100);
    if (this.follow) this.map.easeTo({ center: [fix.lon, fix.lat], duration: 700, essential: true });
  }

  setFollow(on: boolean, zoomTo?: number): void {
    if (this.follow === on) {
      if (on && this.lastFix) this.map.easeTo({ center: [this.lastFix.lon, this.lastFix.lat], zoom: zoomTo ?? this.map.getZoom(), duration: 600 });
      return;
    }
    this.follow = on;
    if (on && this.lastFix) {
      this.map.easeTo({ center: [this.lastFix.lon, this.lastFix.lat], zoom: zoomTo ?? Math.max(this.map.getZoom(), 15), duration: 600 });
    }
    this.followCb?.(on);
  }

  onFollowChange(cb: (on: boolean) => void): void {
    this.followCb = cb;
  }

  private userMoved(): void {
    if (this.follow) {
      this.follow = false;
      this.followCb?.(false);
    }
  }

  // ------------------------------------------------------------------ routes

  setDestination(ll: LonLat | null): void {
    if (!ll) {
      this.destMarker?.remove();
      this.destMarker = null;
      return;
    }
    if (!this.destMarker) {
      const el = document.createElement('div');
      el.className = 'dest-pin';
      el.innerHTML = icons.pinMarker;
      this.destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' });
    }
    this.destMarker.setLngLat(ll).addTo(this.map);
  }

  showRoutes(candidates: RouteCandidate[], selected: number): void {
    this.routes.ensure();
    this.routes.set(candidates, selected);
  }

  clearRoutes(): void {
    this.routes.clear();
  }

  fitCoords(coords: LonLat[], padding: Padding, maxZoom = 16.5): void {
    if (!coords.length) return;
    let w = 180, s = 90, e = -180, n = -90;
    for (const [x, y] of coords) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
    this.follow = false;
    this.map.fitBounds([[w, s], [e, n]], { padding, duration: 600, maxZoom });
  }

  // ------------------------------------------------------------------ camera / gestures

  center(): LonLat {
    const c = this.map.getCenter();
    return [c.lng, c.lat];
  }

  zoom(): number {
    return this.map.getZoom();
  }

  flyTo(ll: LonLat, zoom?: number): void {
    this.follow = false;
    this.map.easeTo({ center: ll, zoom: zoom ?? Math.max(this.map.getZoom(), 15), duration: 700 });
  }

  private saveCamera(): void {
    const c = this.map.getCenter();
    writeJSON(CAMERA_KEY, { c: [c.lng, c.lat], z: this.map.getZoom(), b: this.map.getBearing() } satisfies SavedCamera);
  }

  onLongPress(cb: (ll: LonLat) => void): void {
    this.longPressCb = cb;
  }

  private installLongPress(): void {
    const map = this.map;
    let timer = 0;
    let start: maplibregl.Point | null = null;
    const cancel = () => {
      window.clearTimeout(timer);
      timer = 0;
      start = null;
    };
    const begin = (e: maplibregl.MapTouchEvent | maplibregl.MapMouseEvent) => {
      cancel();
      if ('touches' in e.originalEvent && e.originalEvent.touches.length !== 1) return;
      if (!('touches' in e.originalEvent) && (e.originalEvent as MouseEvent).button !== 0) return;
      start = e.point;
      const ll: LonLat = [e.lngLat.lng, e.lngLat.lat];
      timer = window.setTimeout(() => {
        timer = 0;
        start = null;
        this.longPressCb?.(ll);
      }, 550);
    };
    const move = (e: maplibregl.MapTouchEvent | maplibregl.MapMouseEvent) => {
      if (start && e.point.dist(start) > 8) cancel();
    };
    map.on('touchstart', begin);
    map.on('mousedown', begin);
    map.on('touchmove', move);
    map.on('mousemove', move);
    for (const ev of ['touchend', 'touchcancel', 'mouseup', 'dragstart', 'zoomstart', 'mouseout'] as const) map.on(ev, cancel);
    map.on('contextmenu', (e) => {
      if (!('touches' in e.originalEvent)) {
        e.preventDefault();
        this.longPressCb?.([e.lngLat.lng, e.lngLat.lat]);
      }
    });
  }

  resize(): void {
    this.map.resize();
  }
}
