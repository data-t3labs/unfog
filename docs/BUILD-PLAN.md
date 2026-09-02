# Unfog — build plan (working spec)

Owner: Claude Code [m2], TASK-20260901-2355. Product brief + research: `~/.openclaw/workspace/memory/tasks/artifacts/TASK-20260901-2355/`.
This file is the single spec every implementer reads. Contracts live in code (`src/grid/cell.ts`, `src/grid/types.ts`,
`src/routing/graph-format.ts`); this doc explains how the pieces fit and what each wave delivers.

## 1. Product in one paragraph

A PWA (iPhone Safari, Home Screen install) for Jacob (NYC). Imports his Fog of World history (Sync.zip / raw Sync files / .fwss),
GPX (Apple Health, Strava), Google Timeline JSON, and Unfog backups. Shows a **fog** layer (light OpenFreeMap "bright" basemap under
soft dark fog, lifted with a feathered edge wherever he has been), a **heat** layer (amber→red glow by visit count over a dimmed map),
and — the point — **novelty routing**: pick a destination, choose walk/bike/drive and a detour budget (+10…+100 %, default +25 %),
get 2–3 candidate routes that maximise never-visited street distance, tap Go and follow on the map. Foreground **Record** sessions
(Wake Lock) add visits live; sessions export as GPX for Fog of World's Import folder. Everything on-device; **backup/restore** via
the share sheet. Routing graphs are prebuilt for NYC metro + Metro Vancouver and downloadable on demand anywhere (Overpass).

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
  scale, then two blurs: narrow σ≈0.9 cell → `core = smoothstep(0.30, 0.85, narrow)`, wide σ≈3.5 cells →
  `halo = 0.5 · smoothstep(0.03, 0.5, wide)`; `clear = max(core, halo)`; fog RGBA = (16,20,30, 0.80·(1−clear)).
  Settings expose feather (wide σ 2…5 cells) and halo strength (0…0.7). Below z≈12 skip the narrow pass (cells < 1 px).
- **Heat**: intensity = 0.22 + 0.78·(count−1)/7 (cap 1) per cell, blurred σ≈1 cell, ramp
  0.08→(255,214,120,.55) 0.3→(255,168,70,.85) 0.55→(255,104,56,.92) 0.8→(255,56,70,.96) 1→(255,40,120,1), composited over a dim
  layer (12,15,24, 0.68). Legend: 1 · 2–3 · 4–6 · 7+.
- Basemap: OpenFreeMap `bright` (default), `dark` optional; POI/transit symbol layers hidden; street labels stay ABOVE the fog
  layer (insert the raster layer before the first symbol layer). `raster-resampling: linear`, fade 0.
- Routes: selected = 5.5 px accent `#ff8a3d` with white casing 9 px and a glow (18 px, blur 10, 0.55); alternatives = 4 px
  amber `#ffc857` / blue `#7fb2ff` with white casing.

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
  footways; no turn restrictions in v1). Snap origin/destination to the nearest arc (grid-bucketed), split virtually.
- Loop mode (stretch): heading fan of 8, 2 via-points on a circle of radius T/4, own-route arcs ×5, keep 3 best.
- Budget: < 2 s for a 10 km city route on an iPhone; graphs never materialise per-edge objects.

### 2.4 Graph build (`tools/build-graph`, `src/routing/graph-build.ts`)
- Inputs: OSM PBF (BBBike extracts: `NewYork.osm.pbf` 153 MB bbox −74.36,40.48,−73.67,40.96; `Vancouver.osm.pbf` 65 MB bbox
  −123.31,49.00,−122.67,49.42) via a pure-JS PBF reader (`pbf` + hand-written decoders for BlobHeader/Blob/PrimitiveBlock/DenseNodes/Way,
  zlib via node:zlib); or Overpass JSON (`out geom`), the same path the in-app "download this area" uses.
- Way filter (Wandrer-style, so a street counts once): keep `highway` in {motorway…residential, living_street, unclassified, service (named
  only), pedestrian, footway (NOT footway=sidewalk|crossing), path, cycleway, track, steps, bridleway}; drop construction/proposed/
  raceway/platform/bus_stop/elevator/corridor; access=private|no drops unless mode-specific tags allow. Per-mode bits from tags (see
  `osm-rules.ts` — the single rule table with unit tests).
- Topology: graph nodes = way endpoints + nodes shared by ≥2 kept ways; arcs = way runs between graph nodes; shape = intermediate nodes.
- Tiling: arcs stored in the tile of their from-node; foreign endpoints included as FOREIGN nodes. Output `public/graph/<region>/`.

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
- vite-plugin-pwa autoUpdate; precache app shell; runtime CacheFirst for basemap + graph; "Download region" pre-fills the graph cache.
- `navigator.storage.persist()` on first import; export nag when last backup > 14 days.
- Not standalone on iOS → install card (Share → Add to Home Screen → Add) with a "continue in Safari" link.
- Location only from a user gesture; on PERMISSION_DENIED show the Settings path + the iOS 26 "Reset Location & Privacy" tip.
- Wake Lock re-acquired on visibilitychange; fixes persisted continuously; accuracy > 50 m dropped.

## 3. Waves

Wave 0 (done inline): scaffold, contracts, CI.
Wave 1 (parallel subagents, disjoint dirs, same working tree, NO `npm install`):
  A grid store + rasteriser + stats + backup + grid.worker (+ render pipeline per §2.2)
  B importers (fow, gpx, timeline) with fixtures
  C routing engine (graph merge, novelty, search, candidates, route.worker) with synthetic + Williamsburg fixtures
  D graph builder (PBF reader, Overpass JSON, osm-rules, tiling, CLI) validated on BBBike Vancouver
Wave 2: map + UI (per mockups), PWA polish, icons.
Wave 3: integration, e2e, prebuilt graphs (NYC, Vancouver), deploy, iPhone checklist.
