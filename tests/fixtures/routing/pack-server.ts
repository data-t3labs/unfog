/**
 * A fake static host for graph packs (coverage v2), for unit tests of PackSource / RouteEngine:
 * answers `Range` with 206 + Content-Range like GitHub Pages (or 200 + the whole body when
 * `ignoreRange`), 404 for unknown URLs, throws when `fail` (network down). `publishPacks` turns
 * graph tiles into one pack per z6 cell plus the packs-index.json that names them.
 */
import type { GraphTileInput } from '../../../src/routing/graph-format';
import { packGraphTile } from '../../../src/routing/graph-format';
import { cellKey, cellOf, encodePack, parseCellKey, type PacksIndex } from '../../../src/routing/pack-format';

export interface FakePackServer {
  fetch: typeof fetch;
  calls: Array<{ url: string; range: string | null }>;
  /** When true the server ignores Range and answers 200 with the whole body. */
  ignoreRange: boolean;
  fail: boolean;
  files: Map<string, Uint8Array | object>;
}

export function fakePackServer(files: Map<string, Uint8Array | object>): FakePackServer {
  const s: FakePackServer = { calls: [], ignoreRange: false, fail: false, files, fetch: null as unknown as typeof fetch };
  s.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const range = headers.get('range');
    s.calls.push({ url, range });
    if (s.fail) throw new TypeError('network down');
    const body = files.get(url);
    if (body === undefined) return new Response(null, { status: 404 });
    if (!(body instanceof Uint8Array)) return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (range && !s.ignoreRange) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(m[1]), end = Math.min(Number(m[2]), body.length - 1);
      return new Response(body.slice(start, end + 1).buffer as ArrayBuffer, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } });
    }
    return new Response(body.slice().buffer as ArrayBuffer, { status: 200 });
  }) as typeof fetch;
  return s;
}

export interface PublishedPacks {
  files: Map<string, Uint8Array | object>;
  index: PacksIndex;
  packs: Map<string, ReturnType<typeof encodePack>>;
  indexUrl: string;
}

/**
 * One pack per z6 cell of `tiles`, at `${base}6-<cx>-<cy>.ufp`, and `${base}packs-index.json`.
 * `packUrl` overrides where a cell's pack lives (the index carries absolute URLs; shards).
 */
export function publishPacks(
  tiles: GraphTileInput[],
  opts: { base?: string; builtAt?: string; source?: string; packUrl?: (cell: string, name: string) => string } = {},
): PublishedPacks {
  const base = opts.base ?? 'https://example.test/release/';
  const builtAt = opts.builtAt ?? '2026-09-02T00:00:00Z';
  const byCell = new Map<string, GraphTileInput[]>();
  for (const t of tiles) {
    const [cx, cy] = cellOf(t.tx, t.ty);
    const k = cellKey(cx, cy);
    (byCell.get(k) ?? byCell.set(k, []).get(k)!).push(t);
  }
  const files = new Map<string, Uint8Array | object>();
  const packs = new Map<string, ReturnType<typeof encodePack>>();
  const index: PacksIndex = { version: 1, zoom: 12, packZoom: 6, builtAt, release: 'test', packs: {} };
  for (const [k, list] of byCell) {
    const [cx, cy] = parseCellKey(k)!;
    const p = encodePack([cx, cy], list.map((t) => ({ tx: t.tx, ty: t.ty, bytes: packGraphTile(t) })));
    packs.set(k, p);
    const name = `6-${cx}-${cy}.ufp`;
    const url = opts.packUrl ? opts.packUrl(k, name) : `${base}${name}`;
    files.set(url, p.bytes);
    index.packs[k] = { url, bytes: p.bytes.length, indexBytes: p.index.indexBytes, tiles: p.index.tileCount, builtAt, source: opts.source ?? 'lattice' };
  }
  const indexUrl = `${base}packs-index.json`;
  files.set(indexUrl, index);
  return { files, index, packs, indexUrl };
}
