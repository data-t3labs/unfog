/**
 * Satellite basemap (feedback-1 item 4): Esri World Imagery raster tiles with the OpenFreeMap
 * `bright` style's label layers on top — street names, places, water names — restyled white on a
 * dark halo so they read over a photo. Pure functions: the map fetches the bright style JSON (the
 * service worker caches it) and composes; without it (offline before it was ever cached) the
 * imagery goes up alone and the labels are added once the JSON arrives.
 *
 * Layer order: ground → imagery → (fog/heat + routes, inserted by map.ts before the first symbol
 * layer) → labels.
 */
import type { LayerSpecification, StyleSpecification, SymbolLayerSpecification } from 'maplibre-gl';

export const ESRI_IMAGERY_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
/** Esri's required credit line for World Imagery. */
export const ESRI_ATTRIBUTION = 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
export const SATELLITE_STYLE_NAME = 'unfog-satellite';
export const IMAGERY_SOURCE = 'esri-imagery';
export const IMAGERY_LAYER = 'esri-imagery';
/** Ground under the imagery (shows while tiles load and where none exist): a dark slate. */
export const SATELLITE_GROUND = '#1d2229';
/** Bright-style symbol layers left out over imagery: POIs, transit, house numbers, one-way arrows. */
const HIDE_LABELS = /^poi|transit|housenumber|airport|station|road_oneway/;

/** Imagery only — the first paint, and the whole style when the label JSON is unavailable. */
export function satelliteBaseStyle(): StyleSpecification {
  return {
    version: 8,
    name: SATELLITE_STYLE_NAME,
    sources: {
      [IMAGERY_SOURCE]: {
        type: 'raster',
        tiles: [ESRI_IMAGERY_TILES],
        tileSize: 256,
        maxzoom: 19,
        attribution: ESRI_ATTRIBUTION,
      },
    },
    layers: [
      { id: 'unfog-ground', type: 'background', paint: { 'background-color': SATELLITE_GROUND } },
      { id: IMAGERY_LAYER, type: 'raster', source: IMAGERY_SOURCE, paint: { 'raster-fade-duration': 150 } },
    ],
  };
}

/** A bright-style label layer restyled for imagery: white text (light blue on water) on a dark halo. */
function restyleLabel(l: SymbolLayerSpecification): SymbolLayerSpecification {
  const water = /water|waterway/.test(l.id);
  const paint = { ...(l.paint ?? {}) } as Record<string, unknown>;
  if ('text-color' in paint || l.layout?.['text-field']) {
    paint['text-color'] = water ? '#cfe6ff' : '#ffffff';
    paint['text-halo-color'] = 'rgba(0, 0, 0, 0.85)';
    paint['text-halo-width'] = 1.4;
    paint['text-halo-blur'] = 0.4;
  }
  return { ...l, paint: paint as SymbolLayerSpecification['paint'] };
}

/**
 * Imagery + the bright style's vector label layers. `bright` is the OpenFreeMap bright style JSON
 * (its `openmaptiles` source, glyphs and sprite are reused); anything but its symbol layers is
 * dropped, so no fill or line of the vector map shows over the photo.
 */
export function composeSatelliteStyle(bright: StyleSpecification): StyleSpecification {
  const base = satelliteBaseStyle();
  const vector = bright.sources?.openmaptiles;
  if (!vector) return base;
  const labels: LayerSpecification[] = bright.layers
    .filter((l): l is SymbolLayerSpecification => l.type === 'symbol' && !HIDE_LABELS.test(l.id) && l.source === 'openmaptiles')
    .map(restyleLabel);
  const style: StyleSpecification = {
    ...base,
    sources: { ...base.sources, openmaptiles: vector },
    layers: [...base.layers, ...labels],
  };
  if (bright.glyphs) style.glyphs = bright.glyphs;
  if (bright.sprite) style.sprite = bright.sprite;
  return style;
}

/** Whether a loaded style is the satellite style with its labels already on. */
export function hasSatelliteLabels(style: StyleSpecification | undefined): boolean {
  return Boolean(style && style.name === SATELLITE_STYLE_NAME && style.sources?.openmaptiles);
}
