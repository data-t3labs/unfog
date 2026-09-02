/** Route candidate line layers — paint ported from docs/mockups/mock.js (the approved route look). */
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import type { RouteCandidate } from '../routing/api';

/** Minimal GeoJSON typing (no @types/geojson dependency). */
interface LineFeature {
  type: 'Feature';
  properties: { i: number; color: string; sel: boolean };
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
}

export const ROUTE_COLORS = ['#ff8a3d', '#ffc857', '#7fb2ff'] as const;

/** Colour of candidate i of n: 3 → orange/amber/blue, 2 → orange/blue, 1 → orange. */
export function candidateColor(i: number, n: number): string {
  if (n <= 1) return ROUTE_COLORS[0];
  if (n === 2) return i === 0 ? ROUTE_COLORS[0] : ROUTE_COLORS[2];
  return ROUTE_COLORS[Math.min(i, 2)];
}

const SOURCE = 'unfog-routes';
const LAYERS = ['unfog-routes-alt-casing', 'unfog-routes-alt', 'unfog-routes-sel-glow', 'unfog-routes-sel-casing', 'unfog-routes-sel'] as const;

type FC = { type: 'FeatureCollection'; features: LineFeature[] };

const EMPTY: FC = { type: 'FeatureCollection', features: [] };

export class RouteLayers {
  private data: FC = EMPTY;

  constructor(private readonly map: maplibregl.Map) {}

  /** Add the source + layers if the current style lacks them (called after every style load). */
  ensure(): void {
    const map = this.map;
    if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'geojson', data: this.data });
    const round = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
    const alt: maplibregl.FilterSpecification = ['!', ['get', 'sel']];
    const sel: maplibregl.FilterSpecification = ['get', 'sel'];
    if (!map.getLayer(LAYERS[0])) {
      map.addLayer({ id: LAYERS[0], type: 'line', source: SOURCE, filter: alt, layout: round, paint: { 'line-color': '#fff', 'line-width': 6.5, 'line-opacity': 0.85 } });
      map.addLayer({ id: LAYERS[1], type: 'line', source: SOURCE, filter: alt, layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.95 } });
      map.addLayer({ id: LAYERS[2], type: 'line', source: SOURCE, filter: sel, layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 18, 'line-blur': 10, 'line-opacity': 0.55 } });
      map.addLayer({ id: LAYERS[3], type: 'line', source: SOURCE, filter: sel, layout: round, paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': 0.9 } });
      map.addLayer({ id: LAYERS[4], type: 'line', source: SOURCE, filter: sel, layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 5.5 } });
    }
  }

  set(candidates: RouteCandidate[], selected: number): void {
    const n = candidates.length;
    // Selected feature last so it draws on top of the alternatives within its own layers.
    const order = candidates.map((_, i) => i).sort((a, b) => Number(a === selected) - Number(b === selected));
    this.data = {
      type: 'FeatureCollection',
      features: order.map((i) => ({
        type: 'Feature',
        properties: { i, color: candidateColor(i, n), sel: i === selected },
        geometry: { type: 'LineString', coordinates: candidates[i].coords },
      })),
    };
    this.push();
  }

  clear(): void {
    this.data = EMPTY;
    this.push();
  }

  get empty(): boolean {
    return this.data.features.length === 0;
  }

  private push(): void {
    const src = this.map.getSource(SOURCE) as GeoJSONSource | undefined;
    if (src) src.setData(this.data);
  }
}
