/**
 * Route candidate line layers — paint ported from docs/mockups/mock.js (the approved route look).
 * Street parts are solid; off-road and straight-gap parts (RouteCandidate.parts, feedback-1) are
 * dashed in the same colour so a route that leaves the network reads as "walk across here".
 */
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import type { RouteCandidate } from '../routing/api';

/** Minimal GeoJSON typing (no @types/geojson dependency). */
interface LineFeature {
  type: 'Feature';
  properties: { i: number; color: string; sel: boolean; dash: boolean };
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
const LAYERS = [
  'unfog-routes-alt-casing', 'unfog-routes-alt', 'unfog-routes-alt-dash',
  'unfog-routes-sel-glow', 'unfog-routes-sel-casing', 'unfog-routes-sel', 'unfog-routes-sel-dash',
] as const;

type FC = { type: 'FeatureCollection'; features: LineFeature[] };

const EMPTY: FC = { type: 'FeatureCollection', features: [] };

/** One feature per part (or one for the whole line when the candidate has no parts). */
function featuresOf(c: RouteCandidate, i: number, color: string, sel: boolean): LineFeature[] {
  const pieces = c.parts?.length ? c.parts.map((p) => ({ coords: p.coords, dash: p.kind !== 'street' })) : [{ coords: c.coords, dash: false }];
  return pieces
    .filter((p) => p.coords.length >= 2)
    .map((p) => ({ type: 'Feature', properties: { i, color, sel, dash: p.dash }, geometry: { type: 'LineString', coordinates: p.coords } }));
}

export class RouteLayers {
  private data: FC = EMPTY;

  constructor(private readonly map: maplibregl.Map) {}

  /** Add the source + layers if the current style lacks them (called after every style load). */
  ensure(): void {
    const map = this.map;
    if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'geojson', data: this.data });
    const round = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
    const butt = { 'line-cap': 'butt' as const, 'line-join': 'round' as const };
    const alt: maplibregl.FilterSpecification = ['all', ['!', ['get', 'sel']], ['!', ['get', 'dash']]];
    const altDash: maplibregl.FilterSpecification = ['all', ['!', ['get', 'sel']], ['get', 'dash']];
    const sel: maplibregl.FilterSpecification = ['all', ['get', 'sel'], ['!', ['get', 'dash']]];
    const selDash: maplibregl.FilterSpecification = ['all', ['get', 'sel'], ['get', 'dash']];
    const anySel: maplibregl.FilterSpecification = ['get', 'sel'];
    if (!map.getLayer(LAYERS[0])) {
      map.addLayer({ id: LAYERS[0], type: 'line', source: SOURCE, filter: alt, layout: round, paint: { 'line-color': '#fff', 'line-width': 6.5, 'line-opacity': 0.85 } });
      map.addLayer({ id: LAYERS[1], type: 'line', source: SOURCE, filter: alt, layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.95 } });
      map.addLayer({ id: LAYERS[2], type: 'line', source: SOURCE, filter: altDash, layout: butt, paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.95, 'line-dasharray': [1.5, 1.5] } });
      map.addLayer({ id: LAYERS[3], type: 'line', source: SOURCE, filter: anySel, layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 18, 'line-blur': 10, 'line-opacity': 0.55 } });
      map.addLayer({ id: LAYERS[4], type: 'line', source: SOURCE, filter: sel, layout: round, paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': 0.9 } });
      map.addLayer({ id: LAYERS[5], type: 'line', source: SOURCE, filter: sel, layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 5.5 } });
      map.addLayer({ id: LAYERS[6], type: 'line', source: SOURCE, filter: selDash, layout: butt, paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-dasharray': [1.4, 1.4] } });
    }
  }

  set(candidates: RouteCandidate[], selected: number): void {
    const n = candidates.length;
    // Selected feature last so it draws on top of the alternatives within its own layers.
    const order = candidates.map((_, i) => i).sort((a, b) => Number(a === selected) - Number(b === selected));
    this.data = {
      type: 'FeatureCollection',
      features: order.flatMap((i) => featuresOf(candidates[i], i, candidateColor(i, n), i === selected)),
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
