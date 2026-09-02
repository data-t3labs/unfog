# Coverage runbook — routing graph packs (coverage v2)

How the North-America (and later, world) routing graph gets built, merged at extract borders,
packed into zoom-6 packs and published as GitHub release assets that the app byte-ranges into.
Design + measurements: `docs/BUILD-PLAN.md` §2.4 "Coverage v2"; report: task artifact
`reports/coverage-2.md`.

## What gets produced

```
tools/build-graph/cache/geofabrik/<slug>-latest.osm.pbf(.md5|.ok)   Geofabrik extracts (gitignored)
tools/build-graph/cache/north-america/
  state.json                 per-extract fetch/build/borders timings + stats, merge + pack + upload state (resumable)
  log.txt                    every driver + child log line, timestamped
  extracts/<slug>/           z12 tiles + manifest.json per extract (cli.js output), extracts/index.json
  borders/plan.json          border tiles B, rebuild set R = ring1(B) per z6 cell, wayTiles = ring2(R), contributing extracts
  borders/<cell>/<slug>.json ways of one extract that touch a cell's wayTiles (input of the merge)
  merged/<cell>/             tiles of R rebuilt from the union of ways (exact at borders)
  packs/6-<x>-<y>.ufp        one pack per z6 cell (UFP1: index + deflated UFG1 tiles) — the release assets
  packs/packs-index.json     cells → asset URL, bytes, indexBytes, tiles, builtAt, source, sha256
```
Release: `https://github.com/data-t3labs/unfog/releases/tag/graphs-v1` (prerelease) — the
**storage of record**. Asset URLs `https://github.com/data-t3labs/unfog/releases/download/graphs-v1/<name>`
redirect (302) to `release-assets.githubusercontent.com`, which answers `Range` with 206 but sends
**no CORS headers** on either hop: a browser on the app's origin gets `TypeError: Failed to fetch`
(measured 2026-09-02 with curl and headless Chromium on https://data-t3labs.github.io/unfog/).
So the app reads packs from **GitHub Pages on its own origin**: the deploy workflow
(`.github/workflows/deploy.yml`) runs `tools/build-graph/mirror-packs.mjs`, which downloads the
cells listed in `tools/build-graph/pages-mirror.json` from the release into `dist/graph/packs/`
and writes a `packs-index.json` whose URLs point at
`https://data-t3labs.github.io/unfog/graph/packs/` (Range → 206 verified there; nothing is stored
in git). `PackSource` loads `${BASE_URL}graph/packs/packs-index.json`.

Pages limits: ≈ 1 GB per site (soft; `mirror-packs.mjs` refuses above 950 MB), 100 GB/month
bandwidth (soft). The pilot (428 MB) fits the app's own site. The whole continent (≈ 2.5–3 GB) does
not: shard it over sibling Pages sites of the same account (`unfog-packs-1..n`, each < 1 GB, each
deployed by the same mirror script with its own cell list and `--base`) — every project site of
`data-t3labs.github.io` is the same origin, and `packs-index.json` carries an absolute URL per
pack, so the client needs no change. Creating those repos is data's call (not done).

## Prerequisites

- Node 24, `curl`, `gh` logged in with write access to `data-t3labs/unfog` (`gh auth status`).
- Disk: extracts ≈ 13 GB (NA), per-extract tiles ≈ 3 GB, border ways ≈ 2 GB, packs ≈ 3 GB → keep ≥ 40 GB free.
- RAM: child heap = 12 × PBF size (min 4 GB); `--jobs 3` peaks around 3 × the largest (California ≈ 15 GB). 32 GB is comfortable; on 16 GB use `--jobs 1`.
- Bundle the CLIs once per code change: `npx vite build --config tools/build-graph/vite.config.ts`
  → `tools/build-graph/dist/{cli,continent}.js`.

## Commands

```
C=tools/build-graph/dist/continent.js
node $C status                                   # what is done
node $C fetch    [--only us/washington,british-columbia]   # resume-safe curl -C -, md5-verified
node $C build    [--only …] [--jobs 3]           # cli.js per extract → extracts/<slug>/
node $C borders  [--only …] [--jobs 2]           # plan.json over ALL built extracts, then per-extract way files
node $C merge                                    # per border cell: union → rebuild → merged/<cell>/
node $C pack                                     # packs/*.ufp + packs-index.json (merged tiles override extract tiles)
node $C publish  [--release graphs-v1] [--dry-run]   # gh release create (if needed) + upload, index last
node $C all --publish                            # everything, in order
```
Every step is idempotent; re-running continues where it stopped (`state.json`). `--force` redoes
steps whose outputs exist. Anything longer than ~2 min runs detached (survives the session):

```
bash ~/.openclaw/workspace/scripts/core/run-detached.sh TASK-<id>-na node $PWD/tools/build-graph/dist/continent.js all --publish --jobs 3
tmux ls | grep job-TASK-<id>-na          # alive?
tail -f ~/.openclaw/jobs/TASK-<id>-na-*.log
node tools/build-graph/dist/continent.js status
```

### Order matters for borders
`borders` plans over every extract that has a finished build. Run it (and `merge`, `pack`) after
ALL extracts of the continent are built; adding extracts later changes the plan — `borders`
re-extracts only the extracts whose cells changed (plan hash per extract), `merge` only the cells
whose inputs changed, `pack` only the cells whose tiles changed. Publishing again re-uploads only
packs whose sha256 changed, then `packs-index.json`.

## Measured rates (M2 Max, 2026-09-02, island connection at 11 MB/s ≈ 88 Mbit/s)

| step | rate / figure |
|---|---|
| fetch | 11–15 MB/s; NA total 68 extracts ≈ 13 GB → ≈ 20 min |
| build (cli.js) | ≈ 10–20 MB of PBF per second per process; RSS 2–11 × PBF; WA 362 MB → 36 s, NY 496 MB → 43 s, BC 1.24 GB → 55 s |
| borders (way extraction) | same cost as a build's two PBF passes; under 3 concurrent children + a running download BC's node pass went 28 s → 251 s, so use `--jobs 2` for this step |
| merge | 0.2–11 s per cell (NYC's cell: 883 k ways, 10.8 s) |
| pack | 26 packs / 428 MB in 1.3 s |
| publish | limited by uplink; curl + REST API per file with 4 attempts (`gh release upload` dials uploads.github.com and times out from this network while curl reaches the same IPs in 0.1 s) |
| pilot (WA, NY, BC, OR, NJ, ID) | 6 builds 71 s wall; 8 border cells (476 border tiles, 1,356 rebuilt); 26 packs, 428 MB |

The link is variable: the same session later fell to 0.36 MB/s for one 292 MB extract (823 s), so
budget the fetch by the worst hour you see, not the best. Under load (a 1.2 GB extract building in
parallel plus other sessions on the machine) individual builds stretched from ~30 s to ~450 s; the
driver's resumability is what makes that harmless.

Continent estimates from those rates: fetch 20 min · build ≈ 13 GB ÷ ~15 MB/s ÷ 3 jobs ≈ 5–10 min ·
borders ≈ 10–20 min at `--jobs 2` · merge ≈ 5–10 min · pack ≈ 1 min · publish ≈ 3 GB ÷ uplink.
Tile bytes are 0.16–0.32 × PBF for US states, so **NA ≈ 2.5–3 GB of packs**; the densest z6 cell
(NYC + Philadelphia + NJ) is a few hundred MB — fine for byte ranges (2 GB per asset cap), and the
client never downloads a whole pack.

## Refreshing the data

Geofabrik extracts update daily. To rebuild: `trash tools/build-graph/cache/geofabrik/*.ok` (or
`--force` on `fetch`) so the md5s are re-checked and changed files re-downloaded, then
`all --publish`. `packs-index.json` carries `builtAt` per pack; the client re-reads the index after
24 h (`PackSource` `indexMaxAgeMs`) and drops a cell's cached pack index when its `sha256`/`builtAt`
changed (cached tiles stay usable until evicted by the prefetch budget or refetched).

## Adding a continent

1. Add its extract ids to `CONTINENTS` in `tools/build-graph/fetch-extracts.ts` and, if the
   Geofabrik path is not `<continent>/<id>-latest.osm.pbf`, teach `extractSpec` the path.
2. `node $C all --publish --continent <id>` — the work dir is `cache/<continent>/`.
3. Packs are keyed by global z6 cell, so continents never collide; a cell straddling two continents
   (none in NA) would need one continent to own it — run both continents' `build`, then a single
   `borders`/`merge`/`pack` over the union (not automated yet).

## Troubleshooting

- `md5 mismatch`: Geofabrik replaced the file mid-download; the driver re-downloads once, else `trash` the `.pbf` + `.ok` and re-run `fetch`.
- child `FATAL ERROR: … heap out of memory`: raise the multiplier in `heapFor()` (build-continent.ts) or run `--jobs 1`.
- `build <id>: SKIP, no extract`: `fetch` first (or the bulk shell fetch in the report).
- Very slow `pass 2` lines in borders: memory-bandwidth contention — lower `--jobs`.
- `publish` throws after failed uploads: re-run `publish`; it uploads only what is missing/changed and writes `packs-index.json` last, so a partial run never publishes an index that points at missing packs.
- Verify the Pages mirror still serves ranges:
  `curl -sI -H 'Range: bytes=0-31' https://data-t3labs.github.io/unfog/graph/packs/<name>` → `HTTP/2 206`, `content-range: bytes 0-31/<bytes>`.
- Re-check whether release assets gained CORS (they had none on 2026-09-02): from a page on the app
  origin, `fetch('<asset url>', { headers: { Range: 'bytes=0-31' } })` must resolve with status 206. If
  it does one day, `PackSource` can read the release directly and the mirror step becomes optional.
- Local dry run of the mirror step: `node tools/build-graph/mirror-packs.mjs --out /tmp/packs` (needs the release).
