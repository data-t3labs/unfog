# Unfog routing-graph packs — Pages shard

This repository is one of the sibling GitHub Pages sites that host the routing-graph packs
(`6-<x>-<y>.ufp`, one per zoom-6 cell) of **[Unfog](https://data-t3labs.github.io/unfog/)**, a
novelty-routing PWA. The app reads the packs by HTTP byte range from
`https://data-t3labs.github.io/<this repo>/packs/`; the list of cells this shard serves is in
`packs/index.json` on the site.

**No data lives in git.** The only content here is `mirror-shard.mjs` and its workflow
(`.github/workflows/mirror.yml`, run manually or daily at 06:00 UTC), which downloads this shard's
cells from the [`graphs-v1` release](https://github.com/data-t3labs/unfog/releases/tag/graphs-v1)
of `data-t3labs/unfog` — the storage of record — verifies their size and sha256 against the
release's `packs-index.json`, and publishes them as a GitHub Pages artifact. Which cells belong to
which shard is decided by `tools/build-graph/pages-shards.json` in `data-t3labs/unfog` (see its
`docs/coverage-runbook.md` § Hosting).

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under
the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/). Extracts by
[Geofabrik](https://download.geofabrik.de/).
