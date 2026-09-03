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
So the app reads packs from **GitHub Pages on its own origin**: the sibling sites
`https://data-t3labs.github.io/unfog-graph-N/packs/` (§ Hosting) serve the packs, and the deploy
workflow (`.github/workflows/deploy.yml`) runs `tools/build-graph/mirror-packs.mjs`, which writes
`dist/graph/packs/packs-index.json` with each cell's shard URL (plus, optionally, the cells of
`tools/build-graph/pages-mirror.json` mirrored into the app's own site — none today) and then
`--check`s every URL. Nothing is stored in git. `PackSource` loads
`${BASE_URL}graph/packs/packs-index.json`.

Pages limits: ≈ 1 GB per site (soft; `mirror-packs.mjs` refuses above 950 MB), 100 GB/month
bandwidth (soft). The pilot (428 MB) fitted the app's own site; the whole continent (3.5 GB) does
not, so the packs live on sibling Pages sites of the same account — § Hosting below. Every project
site of `data-t3labs.github.io` is the same origin, and `packs-index.json` carries an absolute URL
per pack, so the client needs no change.

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
node $C mirror   [--no-wait] [--force] [--dry-run]   # shard plan → shard workflows → verify (§ Hosting)
node $C all --publish                            # everything, in order (publish, then mirror)
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
`all --publish` (which ends with `mirror`, so the shard sites pick up the new packs; then push main
or `gh workflow run deploy.yml` so the app's index follows — § Hosting). `packs-index.json` carries
`builtAt` per pack; the client re-reads the index after 24 h (`PackSource` `indexMaxAgeMs`) and
drops a cell's cached pack index when its `sha256`/`builtAt` changed (cached tiles stay usable
until evicted by the prefetch budget or refetched).

## Hosting — Pages shards

**Why.** Release assets answer `Range` but send no CORS headers (above), and one Pages site should
stay under ~1 GB. So the 262 NA packs (3,536.8 MB, 2026-09-03) are served by five sibling GitHub
Pages sites of the account, `unfog-graph-1 … 5` (≈ 707 MB each; 5 rather than 4 so a data refresh
has ~190 MB of headroom per shard before anything must move). All sites of `data-t3labs.github.io`
are the app's origin, and Pages sends `access-control-allow-origin: *` and `Range → 206` anyway
(verified per shard, `reports/coverage-3-shards.md`). The app's own site serves only
`graph/packs/packs-index.json`, whose per-cell `url` points at the right shard. The release stays
the storage of record; the shard sites are caches rebuilt from it — **no pack bytes in any git repo**.

Pieces:

| piece | role |
|---|---|
| `tools/build-graph/pages-shards.json` | cell → shard plan: `{ capMB: 900, shards: { "unfog-graph-1": { base, cells[] }, … } }`. The shard workflows read it from `main` via raw.githubusercontent.com |
| `tools/build-graph/shard-plan.mjs` (+ `shard-planner.mjs`, tested) | updates the plan from a packs-index **stably**: kept assignments never move, cells gone from the index are dropped, new cells (largest first) go to the shard with the most free space that fits; exit 1 naming the bytes when nothing fits |
| `tools/build-graph/shard-repo/` | template of a shard repo: `mirror.yml` (`workflow_dispatch` + daily 06:00 UTC), `mirror-shard.mjs`, README (ODbL credit), `.gitignore`. The workflow downloads its cells from the release with curl (retries, size + sha256 check → exit 1), writes `site/packs/<name>.ufp`, `site/packs/index.json` (its own cells, a valid partial packs-index), `site/index.html`, `.nojekyll`, and deploys with `upload-pages-artifact` + `deploy-pages`. It skips the download + deploy when the live `packs/index.json` already matches the release (bytes + sha256); the `force` input overrides |
| `tools/build-graph/mirror-packs.mjs` (deploy.yml) | writes the app's `packs-index.json` with shard URLs (cells of `pages-mirror.json` — normally none — are mirrored into the app's site and win); `--check` HEADs every shard URL (16 at a time, `Accept-Encoding: identity`) and exits 1 on a missing pack or a size mismatch — deploy.yml runs it as a second step, so a broken index never ships |
| `continent.js mirror` | the operator's one command: re-plans from `<work>/packs/packs-index.json`, commits + pushes the plan if it changed (only that path; refuses if the git index has other staged changes), `gh workflow run mirror.yml` per shard, waits for the runs (`--no-wait` to return early; 40 min ceiling) and verifies each site (index.json 200; largest/median/smallest pack: HEAD length = index bytes, `Range: bytes=0-1023` → 206 + ACAO). Result per shard in `state.json` → `shards`, shown by `status` |

**Order (chicken-and-egg).** The app's index must point only at packs that are already served,
and the shard workflows read the plan from `main`:

1. `node $C publish` — packs + `packs-index.json` on the release (`all --publish` does 1 + 2).
2. `node $C mirror` — plan → push plan → shard workflows → verify. Each shard run takes ≈ 2 min
   (checkout, ≈ 700 MB curl, Pages deploy); an unchanged shard finishes in ≈ 30 s without deploying.
3. Push `main` (or `gh workflow run deploy.yml -R data-t3labs/unfog`) — the deploy writes the app's
   `packs-index.json` with the shard URLs and its `--check` step proves every URL before publishing.
   Verify: `curl -s https://data-t3labs.github.io/unfog/graph/packs/packs-index.json | grep -c unfog-graph-` → 262.

**Adding a shard** (planner exits 1 with "fit in no shard"): add `"unfog-graph-6": { "base":
"https://data-t3labs.github.io/unfog-graph-6/packs/", "cells": [] }` to `pages-shards.json`, then

```
gh repo create data-t3labs/unfog-graph-6 --public --description "Unfog routing-graph packs, shard 6 (© OpenStreetMap contributors, ODbL)"
mkdir /tmp/g6 && cp -R tools/build-graph/shard-repo/. /tmp/g6 && git -C /tmp/g6 init -b main && git -C /tmp/g6 add -A && git -C /tmp/g6 commit -m "Shard 6" && git -C /tmp/g6 remote add origin https://github.com/data-t3labs/unfog-graph-6.git && git -C /tmp/g6 push -u origin main
gh api -X POST repos/data-t3labs/unfog-graph-6/pages -f build_type=workflow    # "already exists" is fine
node $C mirror                                                                  # plans the new cells into it, pushes the plan, runs all shards
```
Updating the template later: copy the changed files into each `unfog-graph-N` repo and push (they
are independent clones; nothing syncs them automatically).

**Re-running.** `node $C mirror` any time (idempotent: unchanged shards skip their deploy);
`--force` passes `force=true` so every shard redeploys; a single shard by hand:
`gh workflow run mirror.yml -R data-t3labs/unfog-graph-3 && gh run watch -R data-t3labs/unfog-graph-3`.
The daily 06:00 UTC schedule re-checks each shard against the release (≈ 30 s when nothing
changed). GitHub pauses scheduled workflows in repos without activity for 60 days — `mirror` (or
any push there) re-enables them.

**Troubleshooting.**
- App index shows a shard URL that is 404: the shard has not deployed that cell yet (plan pushed,
  workflow not run or still running). `gh run list -R data-t3labs/unfog-graph-N`; the app deploy's
  `--check` step fails until it is served — that is the guard working. Order above.
- `shard-plan: … fit in no shard`: cap exceeded — add a shard (above). A kept shard over `capMB`
  after a refresh is only warned about (assignments never move on their own): either raise `capMB`
  slightly (Pages tolerates ~1 GB) or move a few cells to a shard with room by editing the JSON
  (the shard workflows adapt on the next run) and re-run `mirror`.
- `gh workflow run … could not find any workflows named mirror.yml` / HTTP 404: the shard repo does
  not exist or its first push has not landed; `mirror` records `not-triggered` for it and fails at
  the end — create it from the template and re-run.
- Shard run fails at `mirror-shard: … sha256 … ≠ index`: a release asset was replaced while the
  index was not (or a truncated download twice) — re-run `publish` (index last), then `mirror`.
- Shard run says `shard "unfog-graph-N" is not in the plan`: the plan on `main` predates the shard
  entry — push `pages-shards.json` (raw.githubusercontent.com is fetched with a cache-busting
  query, so a fresh push is visible within seconds).
- `mirror` refuses with "git index already has staged changes": another session is mid-commit in
  this clone — let it finish, or commit + push `tools/build-graph/pages-shards.json` yourself and
  re-run `mirror` (the plan is then unchanged and it goes straight to the workflows).
- Deleting a shard site: remove its entry from `pages-shards.json` only after moving its cells
  (the planner drops nothing by itself when an entry disappears — cells of a removed shard become
  "new" and get re-placed), run `mirror`, then archive the repo.

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
- Verify a shard still serves ranges:
  `curl -sI -H 'Range: bytes=0-31' https://data-t3labs.github.io/unfog-graph-1/packs/6-18-24.ufp` → `HTTP/2 206`, `content-range: bytes 0-31/<bytes>`, `access-control-allow-origin: *`;
  all 262 at once: `node tools/build-graph/mirror-packs.mjs --check --out /tmp/packs` (exit 0 ⇔ every shard URL answers 200 with the index's byte count).
- Re-check whether release assets gained CORS (they had none on 2026-09-02): from a page on the app
  origin, `fetch('<asset url>', { headers: { Range: 'bytes=0-31' } })` must resolve with status 206. If
  it does one day, `PackSource` can read the release directly and the mirror step becomes optional.
- Local dry run of the index step: `node tools/build-graph/mirror-packs.mjs --out /tmp/packs` (needs the release; writes only `packs-index.json` while `pages-mirror.json` is empty).
