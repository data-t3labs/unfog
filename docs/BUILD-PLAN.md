# Unfog — build plan (working spec)

Owner: Claude Code [m2], TASK-20260901-2355. Product brief + research: `~/.openclaw/workspace/memory/tasks/artifacts/TASK-20260901-2355/`.
This file is the single spec every implementer reads. Contracts live in code (`src/grid/cell.ts`, `src/grid/types.ts`,
`src/routing/graph-format.ts`); this doc explains how the pieces fit and what each wave delivers.

## 1. Product in one paragraph

A PWA (iPhone Safari, Home Screen install) for Jacob (NYC). Imports his Fog of World history (Sync.zip / raw Sync files / .fwss),
GPX (Apple Health, Strava), Google Timeline JSON, and Unfog backups. Shows a **fog** layer (light OpenFreeMap "bright" basemap under
soft dark fog, lifted with a feathered edge wherever he has been), a **heat** layer (amber→red glow by visit count over a dimmed map),
and — the point — **novelty routing**: pick a destination and a detour budget (+10…+100 %, default +25 %), get 2–3 candidate
routes that maximise never-visited street distance, tap Go and follow on the map. One travel mode (feedback-2, 2026-09-02): routes
follow paths where they exist and straight lines where they don't, timed at walking pace. **Track my movement** (a switch in
Settings, feedback-2) records passively whenever the app is open and on screen (Wake Lock), clearing fog live; sessions export as
GPX for Fog of World's Import folder. Everything on-device; **backup/restore** via the share sheet. Routing graphs are prebuilt for
NYC metro + Metro Vancouver and downloadable on demand anywhere (Overpass).

Settled decisions (data, 2026-09-02): name Unfog; public repo `data-t3labs/unfog`; URL `https://data-t3labs.github.io/unfog/`;
no build ceremony — Claude's judgment; smooth high-res rendering (NOT blocky cells); FoW cell grid kept as the data model.

## 2. Architecture

```
src/
  main.ts                  boot: SW registration, storage.persist(), workers, map, UI
  app/                     UI (vanilla TS + CSS): shell, search, route sheet, layers, record, data (import/export), stats, help/install
  map/                     MapLibre setup, fog:// heat:// protocols → grid worker, route layers, location marker, camera
  grid/                    cell math (DONE), store (IndexedDB), overview pyramid, rasteriser, stats, backup format, grid.worker
  render/                  tile renderer (cells → RGBA → ImageBitmap) with feathering; runs inside grid.worker
  import/                  fow.ts (Sync/.fwss), gpx.ts, timeline.ts, backup.ts → ImportPayload
  export/                  backup.ts, gpx.ts (session → GPX)
  routing/                 graph-format (DONE), graph (merge tiles → CSR), novelty, search (penalised A*), candidates, loop, route.worker
  routing/graph-build.ts   OSM ways (from PBF or Overpass JSON) → graph tiles (shared by tools/ and the in-app downloader)
  record/                  geolocation session, wake lock, gap handling → tracks
  geocode/                 Photon typeahead
tools/build-graph/         Node CLI: PBF reader (pure JS, `pbf`) or Overpass → tiles into public/graph/<region>/
public/graph/<region>/     prebuilt tiles (committed): manifest.json + 12/x/y.ufg
tests/e2e/                 Playwright (Chromium, iPhone profile)
docs/                      this plan, iphone-checklist.md
```

Workers: **grid.worker** owns the cell store (all writes) and renders fog/heat tiles; **route.worker** loads graph tiles, scores
novelty (reads the same IndexedDB read-only, invalidated by a version bump) and searches. Main thread: UI + MapLibre only.
Comlink for both.

### 2.1 Cell grid (data model — fixed)
- Cell = z22 Web-Mercator pixel (`src/grid/cell.ts`). Store tile = z14 tile of 256×256 `Uint8` visit counts (0 = never, saturate 255).
- IndexedDB `unfog` v1, stores: `tiles` (key `"level/tx/ty"`, value `{ level, tx, ty, data: Uint8Array (fflate-deflated), n, updated }`),
  `meta` (stats, version, settings), `tracks` (imported/recorded tracks, for stats + GPX export), `imports` (provenance log).
- Overview levels 14/10/6/2 (`src/grid/types.ts`), max-pooled, updated write-through on every base write.
- Semantics: FoW import → `count = max(count, 1)`. A track/session increments each touched cell ONCE (dedupe per track).
- Stats: visitedCells, areaM2 (Σ per-cell area), tiles, version.

### 2.2 Rendering (the look data approved — mockups in the task artifact)
Raster tiles 512×512 for `fog://{z}/{x}/{y}?v={version}` and `heat://…`, rendered in the grid worker from the cell tiles at
`levelForZoom(z)`, with a margin of neighbouring cells so blur is seamless across tile edges.
- **Fog**: coverage field = cells (count>0) drawn as a 3-cell-wide core (the cell + 8 neighbours), rendered at the tile's pixel
  scale, then two blurs: narrow σ≈0.9 cell → `core = smoothstep(0.30, 0.85, narrow)`, wide σ≈4.5 cells →
  `halo = 0.65 · smoothstep(0.03, 0.5, wide)`; `clear = max(core, halo)`; fog RGBA = (16,20,30, 0.80·(1−clear)).
  Settings expose feather (wide σ 2…6 cells) and halo strength (0…0.8). Defaults 4.5 / 0.65 = docs/mockups/fog.jpg (data's pick, 2026-09-02). Below z≈12 skip the narrow pass (cells < 1 px).
- **Heat**: intensity = 0.22 + 0.78·(count−1)/7 (cap 1) per cell, blurred σ≈1 cell, ramp
  0.08→(255,214,120,.55) 0.3→(255,168,70,.85) 0.55→(255,104,56,.92) 0.8→(255,56,70,.96) 1→(255,40,120,1), composited over a dim
  layer (12,15,24, 0.68). Legend: 1 · 2–3 · 4–6 · 7+.
- Basemap: OpenFreeMap `bright` (default), `dark` optional; POI/transit symbol layers hidden; street labels stay ABOVE the fog
  layer (insert the raster layer before the first symbol layer). `raster-resampling: linear`, fade 0.
- Routes: selected = 5.5 px accent `#ff8a3d` with white casing 9 px and a glow (18 px, blur 10, 0.55); alternatives = 4 px
  amber `#ffc857` / blue `#7fb2ff` with white casing.
- **Night mode** ("Dark map", 2026-09-02): the basemap is OpenFreeMap `fiord` (navy ground `#45516E`, roads lighter than the
  ground, labels hsl(223,31%,61%) on a dark halo) — `dark` paints ground, buildings and roads within ~10 L* of black, so a
  fog over it reads as mud and visited streets vanish. The reading stays the daytime one — unknown = dark, known = light —
  but inverted in medium: the fog is a navy ink (6,9,22) at the user's fog strength, and the cleared ground is LIT by a
  cream light (255,232,200) at 0.32·clear composited over the remaining fog (`RenderSettings.clearColor/clearAlpha`; absent
  = the daytime path, byte-identical). Buildings are pushed back (`fill-opacity` 0.15) so lit blocks read as light, not
  texture. Heat keeps its ramp and legend; the dim layer is the same ink at 0.50 (0.68 by day). Tokens live in
  `src/app/settings.ts` `NIGHT_RENDER`. The overlay is inserted before the first symbol layer AFTER the last fill (plain
  "first symbol" put it under the buildings in `dark`). Routes keep their daytime paint (white casing on navy).
- **Satellite** ("Basemap: Map / Dark / Satellite", feedback-1 2026-09-02): Esri World Imagery raster tiles (256 px, maxzoom 19,
  credit "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community") composed at runtime with the
  OpenFreeMap `bright` style's symbol layers (street/place/water names, white on a dark halo; POI/transit/one-way arrows dropped)
  — `src/map/satellite.ts`; imagery alone until the bright JSON is in memory. Overlay between imagery and labels. Render preset
  `SATELLITE_RENDER`: near-black fog (6,8,12) at 0.9× the user's strength (0.80 → 0.72 — the photo is much darker than the bright map,
  so full strength turned unexplored blocks into a black hole while the cleared edge was already obvious), cleared ground shows the
  photo untinted; heat dim 0.72. Chrome theme dark. Tiles cached by the SW (`satellite` runtime cache, 3000 entries / 30 days).
- **Live fog** (feedback-1): the recorder checkpoints every 5 s when points arrived and reports the touched z14 tiles; the map
  reloads only the overlay tiles in view that cover them (`map.refreshTiles`, `src/map/tile-ids.ts`), the old bitmap staying up until
  the new one lands; Stop / import / delete still do the full version-bump reload.

### 2.3 Routing
- Graph tiles (`graph-format.ts`) z12, directed arcs with per-direction mode bits; merged in-memory per request set
  (tiles covering the s–t ellipse bbox + 1 ring).
- Novelty per arc: sample the arc geometry every 6 m; a sample is "seen" if its cell or any 8-neighbour has count>0; `nov = unseen/samples`.
  Cached per graph version.
- Cost `len·(1 + λ·(1−nov))`; A* with Euclidean lower bound (admissible: cost ≥ len); prune nodes outside the ellipse
  `d(s,v)+eucl(v,t) > 1.05·B`; B = (1+D)·L₀ with L₀ = shortest length (λ=0).
- λ sweep {0.35, 0.7, 1, 1.5, 2, 3, 4, 6, 9}; keep paths with len ≤ B; dedupe (shared-arc fraction > 0.6 = duplicate);
  rank by new metres; return ≤3: "Most new", "Balanced", "Direct" (Direct = shortest, always present).
- Modes: walk (ignores oneway; steps allowed), bike (oneway unless `oneway:bicycle=no`; steps = dismount), drive (oneway, no
  footways; no turn restrictions in v1). **The app asks for `walk` only** (feedback-2, data: "one mode, the most permissive —
  don't even have the other modes buried somewhere"): the Walk/Bike/Drive chips, the mode preference and every mode mention in
  the UI/docs are gone (`src/app/route-sheet.ts` `TRAVEL_MODE`); the engine keeps its Mode type + per-mode bits for tools/tests.
- Turn penalty (2026-09-02, sweep-tuned): walk/bike searches add 12 m-equivalent per direction change ≥ ~40° (arc-labelled exact A*,
  admissible); Direct (λ=0) is never penalised; drive 0; loops 0 by default (straight legs thin loops). Cost ≈ 2.2× per penalised search.
- Loop ranking: by pctNew (ties → closest to target length); loop names 'Most new'/'Balanced' (UI shows Loop A/B/C). Snap origin/destination to the nearest arc (grid-bucketed), split virtually.
- **Off the network (feedback-1, 2026-09-02):** a pin snaps to the nearest usable arc up to 5 km away and the route carries a straight
  `offroad` part between the pin and the snap point ("you walk to the street"): counted in lengthM, scored by cells along the line
  (6 m samples, same 8-neighbour rule as arcs), walked at 4.8 km/h in every mode, drawn dashed, noted on the sheet when ≥ 50 m. An end
  is only *moved* into the other end's component within 300 m (the cemetery case). Ends the network cannot join — different components,
  a one-way trap, or no arc within 5 km of one end — get ONE Direct candidate: streets from the origin to its component's node nearest
  the destination, a `straight` gap to the destination component's node nearest that exit, streets from there (`gapCandidate`); the
  gap goes at the mode's speed. `RouteCandidate.parts` carries the kinds; NoRouteError is gone. No tile at all still throws
  NoCoverageError, and the sheet offers "Route anyway (straight line)" (`RouteApi.directLine`) next to the downloads. Fog clears
  along straight parts only when the user records there — a route is a suggestion. Loops are unchanged (SnapError within 5 km).
- Loop mode ("Explore from here", shipped 2026-09-02): heading fan of 8, 2 via-points on a circle of radius ~0.22·T, own-route arcs ×5, ±25 % length window, keep 3 best; UI chips 2/3/5/8 km + 1–15 km slider.
- Budget: < 2 s for a 10 km city route on an iPhone; graphs never materialise per-edge objects.

- Route joins (sweep round 3, 2026-09-03): a cut within 1 cm of a shape point is that point (no duplicate vertices or a→b→a at
  the off-road join). A pin > 300 m off the network snaps to whichever of the 3 nearest connected streets within 1.5× the nearest
  distance gives the shortest walk + street path to the other end (the nearest as the crow flies may be across a river). A loop
  start whose nearest road is an island without a cycle moves to the nearest cyclic street within 300 m. Sweep tool:
  `tools/route-sweep/` (single mode, 3 regions, named cases, loop seeds, flags); results under the task artifact route-quality-3/.
- **"Straight across" (route-quality 4, 2026-09-03):** when Direct's street part is > 2.5× the crow-flies distance between the two
  snaps and that distance is ≥ 1 km (Tottenville → NJ: 72 km for 13.5 km, no walkway on the Outerbridge; Commercial Drive →
  Lonsdale Quay: 12.3 km for 4.5 km, no SeaBus in the graph; a fifth of the NYC sweep's box-uniform pairs — Hudson / East River
  crossings), `acrossCandidate` adds a first candidate `Straight across` (`RouteCandidate.kind: 'gap'`): streets to an exit, a
  `straight` leg, streets from an entry. Exit/entry are chosen among the two snaps plus the nearest connected street to each of
  ≤ 22 samples (every 200 m) along the straight line, then 8 more along the winning leg, minimising streets + 2.5 × straight
  (a straight metre weighs what the trigger tolerates in walking, so the leg is as short as walking to a better exit can make it
  and the pin-to-pin line always beats Direct); every search is a λ=0 A* bounded by best − crow-flies remainder, exits searched
  nearest-the-origin-first and entries nearest-the-destination-first (≤ 32 points, 2–30 ms on the M2 where the sweep's own
  searches take 70–190). Novelty on the walked parts only (pctNew = new / (length − straight)); the straight leg is timed at
  walking pace. Direct stays last (and the budget/title still follow it); Most new / Balanced keep their slots; nothing changes
  for routes under the trigger, for two-component gaps or for loops. Sheet: teal row "Straight across · 5.3 km · 66 min ·
  2.8 km straight", status "Straight across crosses 2.8 km the street map has no way over (dashed); the walk round is 12 km.";
  Google Maps hand-off cuts at straight legs (`handoff.ts splitCandidate`)
  and says the straight leg is not a walking route. Trade-off, documented in the route-quality-4 report: with the weight at 2.5 an
  exit whose walk costs more than 2.5× the straight it saves is not taken (NYC pair 2: the leg starts 250 m from the pin and
  crosses Riverside Park because the Greenway there is a 2 km walk away in the graph).

### 2.4 Graph build (`tools/build-graph`, `src/routing/graph-build.ts`)
- Inputs: OSM PBF (BBBike extracts: `NewYork.osm.pbf` 153 MB bbox −74.36,40.48,−73.67,40.96; `Vancouver.osm.pbf` 65 MB bbox
  −123.31,49.00,−122.67,49.42) via a pure-JS PBF reader (`pbf` + hand-written decoders for BlobHeader/Blob/PrimitiveBlock/DenseNodes/Way,
  zlib via node:zlib); or Overpass JSON (`out geom`), the same path the in-app "download this area" uses.
- Way filter (Wandrer-style, so a street counts once): keep `highway` in {motorway…residential, living_street, unclassified, service (named
  only), pedestrian, footway (NOT footway=sidewalk|crossing), path, cycleway, track, steps, bridleway}; drop construction/proposed/
  raceway/platform/bus_stop/elevator/corridor; access=private|no drops unless mode-specific tags allow. Per-mode bits from tags (see
  `osm-rules.ts` — the single rule table with unit tests).
- GLUE connectors (review F1, 2026-09-02): sidewalks, crossings, traffic islands, driveways, parking aisles and unnamed service roads
  are OSM's only links between bridge walkways / park paths / plazas and the street grid — dropping them all split NYC's walk network
  at the East River. They enter the build as *candidates*; graph-build keeps only the segments that join otherwise separate parts of
  the walk or bike network (Kruskal over per-mode union-find, shortest first, dangling ends trimmed) and flags them `ArcFlag.GLUE`:
  walk + bike (dismount per tags), never drive; the engine prices them at plain length with 0 new metres and `stats.km` excludes them.
  Result: NYC walk connectivity 31 % → 95 % for +18 % arcs and 0 km change. `--no-sidewalk-glue` / `--no-service-glue` opt out.
- Connectivity on island regions (D5, 2026-09-03): Salt Spring (Overpass bbox −123.62,48.72,−123.4,48.9) measures walk 71.7 % /
  bike 70.6 % / drive 77.6 % over 35 walk components, and that is the correct reading of OSM, not a build defect. `out geom`
  returns whole ways touching the bbox, so the 1,917-node island network is joined in the tally by 438 + 193 nodes of Vancouver
  Island across Sansum Narrows (Maple Bay, Cowichan Bay) and 33 nodes of a neighbouring island; on-island walk connectivity is
  1917/2010 = 95 %. The remaining islands are trail clusters behind `access=private` roads (Nose Point / Maracaibo Estates,
  Musgrave Landing — dropped like the OSRM foot profile does) and real OSM gaps (the Vesuvius dock walkway ends 25 m short of
  Vesuvius Bay Road). No cross-component node pair lies within 2 m, so an endpoint "snap-join" would join nothing there and was
  not added. `graph-output.test.ts` guards the island with landmark probes (three ferry terminals, Burgoyne Bay, Mount Maxwell,
  Beddis in Ganges' walk + bike component) plus a pct bar 3 points under the measurement.
- Topology: graph nodes = way endpoints + nodes shared by ≥2 kept ways; arcs = way runs between graph nodes; shape = intermediate nodes.
- Tiling: arcs stored in the tile of their from-node; foreign endpoints included as FOREIGN nodes. Output `public/graph/<region>/`.

#### How to run (wave 1 D)
```
# 1. extracts (gitignored cache; skip if present)
curl -L -o tools/build-graph/cache/Vancouver.osm.pbf https://download.bbbike.org/osm/bbbike/Vancouver/Vancouver.osm.pbf
curl -L -o tools/build-graph/cache/NewYork.osm.pbf   https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf
# 2. build the CLI (Vite SSR bundle → tools/build-graph/dist/cli.js) and run it
npm run build-graph -- --pbf tools/build-graph/cache/Vancouver.osm.pbf --region vancouver --name "Metro Vancouver"
npm run build-graph -- --pbf tools/build-graph/cache/NewYork.osm.pbf   --region nyc       --name "New York City"
# any bbox via Overpass (the in-app download path), e.g. Williamsburg:
npm run build-graph -- --overpass -73.978,40.703,-73.938,40.729 --region williamsburg --name "Williamsburg"
```
Options: `--out <dir>` (default `public/graph/<region>`), `--bbox w,s,e,n` (PBF: keep only ways touching the box; also the
manifest bbox), `--source "<text>"`, `--index <file>` (default `public/graph/index.json`). Output: `12/<x>/<y>.ufg`
(`packGraphTile`), `manifest.json` (`RegionManifest` with per-tile bytes), and the region merged into `index.json`
(manifests without `tiles`, plus `tileCount` + `bytes`). Stale tiles from a previous build of the same region are removed.
The PBF reader streams blob by blob (two passes: highway ways, then only the referenced nodes), so memory is set by the
kept graph plus the glue candidates: Vancouver (65 MB) builds in ≈ 5 s / 0.9 GB peak RSS and NYC (153 MB) in ≈ 10 s / 1.4 GB
on the M2 with Node's default heap. The CLI prints per-mode connectivity (largest component / walk-reachable nodes) after
every build — expect ≥ 95 % walk for a city extract; a drop means a rule change cut the network.
For bigger extracts (a state/province) raise the heap: `NODE_OPTIONS=--max-old-space-size=8192 npm run build-graph -- …`.
Only zlib-compressed PBFs are supported (BBBike/Geofabrik default); re-encode others with
`osmium cat in.pbf -o out.pbf --output-format pbf,pbf_compression=zlib`.
Tests: `npx vitest run src/routing tools` — the Vancouver cross-check and the prebuilt-region sanity checks skip when the
extract / `public/graph/<region>` is absent.

#### Coverage v2 — North America graph packs + auto-fetch (2026-09-02)
data's ruling: the app always has low-res data of the whole world (straight-line floor, separate lane) and gets the
high-res graph of the places you are automatically — no clicks; at least North America. Runbook: `docs/coverage-runbook.md`.
- **Packs** (`src/routing/pack-format.ts`, "UFP1"): one file per z6 cell = 32 B header + 16 B/tile index (tx, ty, offset,
  length; Morton order so a 5×5 neighbourhood is a few byte runs) + the deflated UFG1 z12 tiles. Published as assets of
  ONE GitHub release (`graphs-v1`, prerelease) with `packs-index.json` (cells → url, bytes, indexBytes, tiles, builtAt,
  source, sha256) — the storage of record. **Release assets serve `Range` as 206 but carry no CORS headers** on either
  hop (github.com 302 → release-assets.githubusercontent.com): headless Chromium on the app origin fails every fetch
  (measured 2026-09-02). So the deploy workflow mirrors the cells in `tools/build-graph/pages-mirror.json` from the
  release into Pages sites on the app's origin, nothing in git. **Decision (2026-09-03): sibling Pages sites `unfog-graph-N`**
  (same origin `data-t3labs.github.io`, Range → 206 + ACAO `*` verified): five shards of ≈ 707 MB (cap 900) serve all 262
  packs; `tools/build-graph/pages-shards.json` (stable planner `shard-plan.mjs`) says which cell lives where, each shard repo
  (template `tools/build-graph/shard-repo/`) mirrors its cells from the release by workflow, and the app's own site serves
  only `packs-index.json` with the shard URLs (`mirror-packs.mjs`, `--check` guards the deploy). `continent.js mirror` runs
  the plan → shard workflows → verification; runbook § Hosting.
  A client reads a pack's index with one range request (`bytes=0-<indexBytes-1>`) and then only the tiles it needs.
  Prebuilt `public/graph/{nyc,vancouver,saltspring}` stay as offline-precached regions; packs are the universal layer beneath.
- **Pipeline** (`tools/build-graph/build-continent.ts` → `dist/continent.js`, resumable, `state.json`): `fetch` (Geofabrik
  state/province/country extracts, `curl -C -`, md5) → `build` (cli.js per extract in a child with heap = 12× PBF, `--jobs`)
  → `borders` → `merge` → `pack` → `publish` (gh, per-file retries, index uploaded last).
- **Border merge is a way-level union, not a tile union** (`merge-tiles.ts`): each build only knows the junctions with its own
  extract's streets, so at a border WA emits a→c (skipping OR-only junction b) and OR emits a'→b (skipping WA-only junction
  a) — no union of tiles contains a→b. Tiles emitted by ≥ 2 extracts (B) plus their 1-ring are rebuilt from the union of
  the ways touching ring2 of them (every way is complete in some extract → exact junctions). merge-tiles.test.ts: Williamsburg
  split into two complete-way halves — per-half border tiles ≠ full build, naive union has junction-skipping arcs, union
  rebuild == full build byte for byte (z12 and z15).
- **Client** (not wired yet): `src/routing/pack-source.ts` `PackSource` — packs-index cached in IndexedDB `unfog-packs`
  (`meta`, refreshed after 24 h), pack indexes per cell, tiles by coalesced byte ranges (≤ 32 KB gaps share a request, 4 in
  flight), cached in store `tiles` ("x/y", size, lastUsed); `tilesFor(bbox)` / `getTile` / `coverage` / `fetchTiles` /
  `listCached` / `evict`; tolerates a server that ignores Range. `src/routing/prefetch.ts` — pure policy + `Prefetcher`:
  position (or idle map centre) enters a new z12 tile → 5×5 ring, centre first, ≤ 25 tiles per round, ≥ 5 s between
  rounds for the same centre, position fixes out-rank map pans for 60 s, never offline or on `navigator.connection.saveData`,
  150 MB budget with LRU eviction that spares the current ring. Tests: pack-source.test.ts (format, range math, PackSource
  over fake fetch + fake-indexeddb), prefetch.test.ts (ring, throttle, budget, priorities).
- Measured (pilot WA/NY/BC/OR/NJ/ID): builds 16–55 s each, RSS 2–11× PBF, tile bytes 0.16–0.32× PBF → NA ≈ 2.5–3 GB of packs.

**Wired (2026-09-03).** `RouteEngine` owns a `PackSource` next to `TileSource` and installs it as the tile fallback: memory → prebuilt region → downloaded area → pack cache (IndexedDB `unfog-packs`); the engine, not the fallback, touches the network — `graphFor` fetches the box's locally-missing tiles from their packs first (one coalesced byte-range round per pack, ≤ 4 in flight, 60 s deadline per range) so a first route in a new city costs a handful of requests. `coverage(bbox)` reports `packable` (a pack covers it, not on the device yet); `NoCoverageError` only when `available + packable === 0`, and `route()` answers "a pack covers this but nothing loaded" (offline with nothing cached, a shard not deployed → 404) with the straight-line floor, no prompt — outside every pack the download offer stays; loops keep NoCoverageError. Boot: `packs.init({ refreshTimeoutMs: 5000 })` — a slow packs-index.json never stalls `route.init` (the refresh lands in the background; `cache: 'no-cache'`, 30 s abort). The main thread's `src/app/prefetch-driver.ts` (`startPrefetchDriver(ctx)`, one call in main.ts) feeds the `Prefetcher`: geolocation fixes, every `moveend` (the policy's far-pan rule, polish round 2: within 60 s of a fix a map centre < 5 km from it is a glance around and is ignored, a farther one — another city on a phone with a live watch — counts, tracking or not; the next fix re-centres the ring), the map centre at start; a round every 10 s, on `online`, and when the centre tile changes; never offline or on `navigator.connection.saveData`; 150 MB LRU budget sparing the current ring; never moves the map (reads centres only). RouteApi grew `packsHasTile/packsFetchTiles/packsListCached/packsEvict/packsClear/packsStatus` (Comlink; mock = no-ops). Data → Routing data (`src/app/packs-data.ts`): "Automatic: the streets around you download as you go (Wi-Fi and mobile; paused on Low Data Mode)", cached streets grouped by cell as "Streets near New York (US) · 12 MB · used today" (one region per cell, one line — polish round 2: `src/app/pack-label.ts` votes the cell's cached tiles through the build-time region table `src/routing/pack-regions.json`, `continent.js regions`, instead of listing every extract the cell's `source` names), Clear, "Coverage list updated N h ago"; Regions and Downloaded areas unchanged beneath it. Service worker: the `graph` CacheFirst rule excludes `/unfog/graph/packs/` (the index must reach the network; a cached full body answered to a Range request would break the 206 contract) — guarded by `tests/unit/sw-runtime-caching.test.ts`; pack bytes never enter a SW cache. Tests: pack-source / tiles-source / williamsburg (engine over packs: coalesced fetch, offline cache, 404 floor, loop NoCoverage, Clear) / prefetch (driver) unit tests; `tests/e2e/packs.spec.ts` serves a fake packs-index + real packs built from public/graph/{nyc,vancouver} through `context.route` on sibling paths (absolute per-cell URLs, Range → 206).

### 2.5 Imports / exports
- FoW: `src/import/fow.ts` — accept .zip (any nesting; match tile files by NAME pattern; skip `.`/`__MACOSX`/`FoW-Sync-Lock`), bare tile
  files (multi-select), `.fwss` (`Model/*/` entries only). Real fixtures: `tests/fixtures/fow/23e4lltkkoke`, `cd36lltksiwo` (MIT, fog-machine).
  Spec: task artifact `research/fow-research.md` §2 + `research/fow-format-validation.md`.
- GPX: `<trkpt lat lon>` + `<time>`; also `<rtept>`/`<wpt>` ignored. Apple Health export zips contain `workout-routes/*.gpx`.
- Google Timeline: new on-device export (`semanticSegments[].timelinePath[].point "geo:lat,lng"` + `visit.topCandidate.placeLocation`)
  and legacy Takeout `Records.json` (`locations[].latitudeE7/longitudeE7`). Split into per-day tracks; gaps > 500 m not joined.
- Backup: `unfog-backup-YYYYMMDD.zip` = `meta.json` + `tiles/<level>_<tx>_<ty>.bin` (base level only) + `tracks.json`; import merges (max).
- Session → GPX (for FoW's Import folder).

### 2.6 PWA / iOS
- vite-plugin-pwa prompt mode (`registerType: 'prompt'` + workbox `clientsClaim`): a new worker installs and waits; the open page keeps its own worker and precache (lazy chunks still resolve after a deploy) until "Update available — Reload" sends SKIP_WAITING → `controllerchange` → one reload — never on its own, never mid-recording (`src/app/pwa.ts`); precache app shell; runtime CacheFirst for basemap + graph; "Download region" pre-fills the graph cache.
- `navigator.storage.persist()` on first import; export nag when last backup > 14 days.
- Not standalone on iOS → install card (Share → Add to Home Screen → Add) with a "continue in Safari" link.
- Location only from a user gesture; on PERMISSION_DENIED show the Settings path + the iOS 26 "Reset Location & Privacy" tip.
- Wake Lock re-acquired on visibilitychange; fixes persisted continuously; accuracy > 50 m dropped.
- **Tracking** (feedback-2, 2026-09-02 — "this tracks your movements passively from the moment you turn it on"): no Record
  button. `settings.tracking` is a persisted switch (Help → Settings, also offered once on first run after the install card);
  while on, `src/app/tracking.ts` starts a session at boot and keeps it running whenever the page is visible (the location watch
  pauses/resumes with visibility, the wake lock is re-acquired on return). No Start/Stop, no summary sheet: sessions roll over at
  local midnight and on every launch — the persisted session of the previous run is saved as a track first
  (`saveUnfinishedSession`), so a crash / iOS kill / update reload loses ≤ one checkpoint. The map shows only a quiet
  "Tracking" pill (paused / waiting-for-GPS variants); Settings carries the honest note that iOS only records while the app is
  open and on screen, pointing to Help → "Always recording" (Fog of World via Dropbox and Overland, pulled every time the app opens — src/sync, Data → Sources).
  The service-worker update no longer refuses Reload mid-session.

## 3. Waves

Wave 0 (done inline): scaffold, contracts, CI.
Wave 1 (parallel subagents, disjoint dirs, same working tree, NO `npm install`):
  A grid store + rasteriser + stats + backup + grid.worker (+ render pipeline per §2.2)
  B importers (fow, gpx, timeline) with fixtures
  C routing engine (graph merge, novelty, search, candidates, route.worker) with synthetic + Williamsburg fixtures
  D graph builder (PBF reader, Overpass JSON, osm-rules, tiling, CLI) validated on BBBike Vancouver
Wave 2: map + UI (per mockups), PWA polish, icons.
Wave 3: integration, e2e, prebuilt graphs (NYC, Vancouver), deploy, iPhone checklist.
