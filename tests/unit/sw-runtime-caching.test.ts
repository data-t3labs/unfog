/**
 * Service-worker runtime caching (vite.config.ts): the graph rule must claim the prebuilt tiles and
 * leave the coverage-v2 packs alone — packs-index.json is fetched `no-cache` and kept in IndexedDB,
 * and a `.ufp` pack is read by byte range (a cached full body answered to a Range request breaks
 * the 206 contract). Nothing on the shard sites or on other hosts is cached by these rules either;
 * IndexedDB `unfog-packs` is the pack cache.
 */
import { describe, expect, it } from 'vitest';
import { runtimeCaching } from '../../vite.config';

/** The rule (by cache name) that would handle a GET of `url`, or null. */
function claims(url: string): string | null {
  const u = new URL(url);
  const request = new Request(url);
  for (const rule of runtimeCaching) {
    const p = rule.urlPattern;
    const hit = typeof p === 'function' ? Boolean(p({ url: u, request, event: undefined as unknown as ExtendableEvent, sameOrigin: u.origin === 'https://data-t3labs.github.io' })) : p instanceof RegExp ? p.test(url) : p === url;
    if (hit) return (rule.options as { cacheName?: string } | undefined)?.cacheName ?? '(unnamed)';
  }
  return null;
}

describe('service-worker runtime caching rules', () => {
  it('caches prebuilt graph tiles and the basemaps, never the packs index or a pack', () => {
    expect(claims('https://data-t3labs.github.io/unfog/graph/nyc/12/1206/1539.ufg')).toBe('graph');
    expect(claims('https://data-t3labs.github.io/unfog/graph/index.json')).toBe('graph');
    expect(claims('https://data-t3labs.github.io/unfog/graph/nyc/manifest.json')).toBe('graph');
    expect(claims('https://tiles.openfreemap.org/styles/bright')).toBe('basemap');
    expect(claims('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/12345/9876')).toBe('satellite');
    // Coverage v2: the packs index (app origin) and any pack, on the app site or a shard site.
    expect(claims('https://data-t3labs.github.io/unfog/graph/packs/packs-index.json')).toBeNull();
    expect(claims('https://data-t3labs.github.io/unfog/graph/packs/6-18-24.ufp')).toBeNull();
    expect(claims('https://data-t3labs.github.io/unfog-graph-1/packs/6-18-24.ufp')).toBeNull();
    expect(claims('https://data-t3labs.github.io/unfog-graph-5/packs/packs-index.json')).toBeNull();
    // Range requests on a cache rule would be answered from a stored full body: no rule may use one for packs.
    for (const rule of runtimeCaching) expect((rule.options as { plugins?: unknown[] } | undefined)?.plugins ?? []).toEqual([]);
  });
});
