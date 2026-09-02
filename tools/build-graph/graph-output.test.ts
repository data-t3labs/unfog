/**
 * Sanity checks on the prebuilt graphs in public/graph/<region>/ (skipped when a region has not
 * been built — CI without the BBBike extracts).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArcFlag, NodeFlag, graphTileBounds, graphTilePath, lonLatToGraphTile, unpackGraphTile, type RegionManifest } from '../../src/routing/graph-format';

const GRAPH_DIR = fileURLToPath(new URL('../../public/graph/', import.meta.url));
const INDEX = join(GRAPH_DIR, 'index.json');

const regions = existsSync(GRAPH_DIR)
  ? readdirSync(GRAPH_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(GRAPH_DIR, d.name, 'manifest.json'))).map((d) => d.name)
  : [];

describe.skipIf(regions.length === 0)('prebuilt graph regions (skipped when public/graph/<region>/manifest.json is absent)', () => {
  it('index.json lists every built region without tile lists', () => {
    const index = JSON.parse(readFileSync(INDEX, 'utf8')) as Array<Record<string, unknown>>;
    for (const id of regions) {
      const entry = index.find((e) => e.id === id);
      expect(entry, id).toBeDefined();
      expect(entry).not.toHaveProperty('tiles');
      expect(typeof entry!.tileCount).toBe('number');
      expect(typeof entry!.bytes).toBe('number');
      const manifest = JSON.parse(readFileSync(join(GRAPH_DIR, id, 'manifest.json'), 'utf8')) as RegionManifest;
      expect(entry!.tileCount).toBe(manifest.tiles.length);
      expect(entry!.bytes).toBe(manifest.tiles.reduce((n, [, , b]) => n + b, 0));
      expect(entry!.stats).toEqual(manifest.stats);
    }
  });

  for (const id of regions) {
    describe(id, () => {
      const dir = join(GRAPH_DIR, id);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as RegionManifest;

      it('manifest is complete and every listed tile exists with the recorded size', () => {
        expect(manifest.id).toBe(id);
        expect(manifest.zoom).toBe(12);
        expect(manifest.name.length).toBeGreaterThan(0);
        expect(manifest.tiles.length).toBeGreaterThan(0);
        expect(manifest.stats.nodes).toBeGreaterThan(0);
        expect(manifest.stats.arcs).toBeGreaterThan(0);
        expect(manifest.stats.km).toBeGreaterThan(0);
        expect(Date.parse(manifest.builtAt)).toBeGreaterThan(0);
        const [w, s, e, n] = manifest.bbox;
        expect(w).toBeLessThan(e); expect(s).toBeLessThan(n);
        for (const [tx, ty, bytes] of manifest.tiles) {
          const f = join(dir, graphTilePath(tx, ty, manifest.zoom));
          expect(existsSync(f), f).toBe(true);
          expect(readFileSync(f).length).toBe(bytes);
        }
      });

      it('the largest tile and a median tile decode to well-formed CSR graphs', () => {
        const sorted = [...manifest.tiles].sort((p, q) => q[2] - p[2]);
        let totalLocal = 0, totalArcs = 0;
        for (const [tx, ty] of [sorted[0], sorted[Math.floor(sorted.length / 2)]]) {
          const t = unpackGraphTile(new Uint8Array(readFileSync(join(dir, graphTilePath(tx, ty, manifest.zoom)))));
          expect([t.tx, t.ty, t.zoom]).toEqual([tx, ty, manifest.zoom]);
          const n = t.nodeId.length;
          expect(n).toBeGreaterThan(0);
          expect(t.arcStart.length).toBe(n + 1);
          expect(t.arcStart[n]).toBe(t.arcTo.length);
          const b = graphTileBounds(tx, ty, manifest.zoom);
          let local = 0, foreign = 0, walk = 0, prevId = -1;
          for (let i = 0; i < n; i++) {
            expect(t.nodeId[i]).toBeGreaterThan(prevId); // sorted by OSM id, unique
            prevId = t.nodeId[i];
            const lon = t.nodeLon[i] / 1e7, lat = t.nodeLat[i] / 1e7;
            if (t.nodeFlags[i] & NodeFlag.FOREIGN) {
              foreign++;
              expect(lonLatToGraphTile(lon, lat, manifest.zoom)).not.toEqual([tx, ty]);
              expect(t.arcStart[i + 1]).toBe(t.arcStart[i]);
            } else {
              local++;
              expect(lon).toBeGreaterThanOrEqual(b.west - 1e-6); expect(lon).toBeLessThanOrEqual(b.east + 1e-6);
              expect(lat).toBeGreaterThanOrEqual(b.south - 1e-6); expect(lat).toBeLessThanOrEqual(b.north + 1e-6);
              expect(t.arcStart[i + 1]).toBeGreaterThan(t.arcStart[i]);
            }
            for (let a = t.arcStart[i]; a < t.arcStart[i + 1]; a++) {
              expect(t.arcTo[a]).toBeLessThan(n);
              expect(t.arcShapeStart[a]).toBeLessThanOrEqual(t.arcShapeEnd[a]);
              expect(t.arcShapeEnd[a]).toBeLessThanOrEqual(t.shapeLon.length);
              expect(t.arcWay[a]).toBeGreaterThan(0);
              if (t.arcFlags[a] & ArcFlag.WALK) walk++;
            }
          }
          expect(local).toBeGreaterThan(0);
          expect(foreign).toBeGreaterThan(0); // a city tile always borders another
          expect(walk).toBeGreaterThan(t.arcTo.length / 2); // most arcs are walkable
          totalLocal += local; totalArcs += t.arcTo.length;
        }
        expect(totalArcs).toBeGreaterThan(totalLocal); // avg degree > 1
      });

      it('per-tile local node + arc counts add up to the manifest stats', { timeout: 120_000 }, () => {
        let nodes = 0, arcs = 0;
        for (const [tx, ty] of manifest.tiles) {
          const t = unpackGraphTile(new Uint8Array(readFileSync(join(dir, graphTilePath(tx, ty, manifest.zoom)))));
          for (let i = 0; i < t.nodeId.length; i++) if (!(t.nodeFlags[i] & NodeFlag.FOREIGN)) nodes++;
          arcs += t.arcTo.length;
        }
        expect(nodes).toBe(manifest.stats.nodes);
        expect(arcs).toBe(manifest.stats.arcs);
      });
    });
  }
});
