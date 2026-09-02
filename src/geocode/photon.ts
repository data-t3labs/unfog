/**
 * Photon (komoot) typeahead geocoding. https://photon.komoot.io — free, no key, OSM data.
 * Biased towards a lon/lat (the map centre) so "Domino Park" finds the Brooklyn one first.
 */

export interface GeoResult {
  name: string;
  /** "Williamsburg, Brooklyn" — second line in the result list. */
  locality: string;
  lon: number;
  lat: number;
  kind: string;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | number | undefined>;
}

const ENDPOINT = 'https://photon.komoot.io/api/';

export async function geocode(
  query: string,
  bias: { lon: number; lat: number } | null,
  signal?: AbortSignal,
  limit = 6,
): Promise<GeoResult[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const params = new URLSearchParams({ q, limit: String(limit), lang: 'en' });
  if (bias) {
    params.set('lat', bias.lat.toFixed(5));
    params.set('lon', bias.lon.toFixed(5));
  }
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const json = (await res.json()) as { features?: PhotonFeature[] };
  const out: GeoResult[] = [];
  const seen = new Set<string>();
  for (const f of json.features ?? []) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const name = String(p.name ?? street ?? p.city ?? p.country ?? 'Unnamed');
    const parts: string[] = [];
    for (const k of ['district', 'locality', 'city', 'county', 'state', 'country'] as const) {
      const v = p[k];
      if (v && typeof v === 'string' && !parts.includes(v) && v !== name) parts.push(v);
      if (parts.length === 3) break;
    }
    if (street && street !== name && !parts.includes(street)) parts.unshift(street);
    const locality = parts.slice(0, 3).join(', ');
    const key = `${name}|${locality}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, locality, lon, lat, kind: String(p.osm_value ?? p.osm_key ?? '') });
  }
  return out;
}
