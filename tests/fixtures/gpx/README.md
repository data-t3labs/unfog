Synthetic GPX fixtures (Williamsburg, NYC) for `src/import/gpx.test.ts`:

- `minimal.gpx` — one track, one segment, timed points, entity in the name.
- `apple-health-route.gpx` — Apple Health `workout-routes` style: `lon` before `lat`, `<metadata><time>`, per-point `<extensions>` (speed/hAcc/vAcc/course).
- `multiseg.gpx` — Strava style: single-quoted attributes, Garmin extensions, two tracks (three segments), a comment containing a fake `<trkpt>`, `<wpt>`/`<rte>` to ignore, CDATA name, self-closing untimed point.
- `notimes.gpx` — GPX 1.0 with a namespace prefix on every element and no `<time>`.
