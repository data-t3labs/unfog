`williamsburg.json.gz` — Overpass `out geom` JSON (1,760 ways) fetched 2026-09-02 for bbox 40.703,-73.978,40.729,-73.938 with
  way["highway"~"^(primary|secondary|tertiary|residential|living_street|unclassified|pedestrian|cycleway|path|footway)$"]["footway"!~"^(sidewalk|crossing)$"]
Data © OpenStreetMap contributors, ODbL. Used for routing + graph-build tests. Home = Bedford Av & N 7th (-73.9568, 40.7176),
destination = Domino Park (-73.9678, 40.7142); mockup result: direct 1,379 m / 56 % new, most-new (λ=1.5) 1,672 m / 79 % new.

`nelson-3km.json.gz` — the exact Overpass response the app's "Download this area" sends for Nelson, BC (centre -117.29, 49.49,
  3 km radius → bbox 49.46287,-117.33151,49.51713,-117.24849; query = `overpassQuery()` in src/routing/overpass.ts), fetched
  2026-09-02 from overpass-api.de (1,234 ways, 1.4 MB raw). Data © OpenStreetMap contributors, ODbL. Served by page.route in
  tests/e2e/flows.spec.ts so the download-area flow runs hermetically; the real-network variant of that flow is gated on Overpass
  answering. Home = Stanley St & Victoria St (-117.2964, 49.4927), destination = Mill Street (-117.2831, 49.4920).
