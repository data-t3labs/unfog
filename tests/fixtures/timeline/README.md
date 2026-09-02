Synthetic Google Timeline fixtures (Williamsburg → Midtown, NYC) for `src/import/timeline.test.ts`:

- `semantic-segments.json` — the current on-device export (Android shape): `semanticSegments[]` with a HOME visit, a `timelinePath` (one malformed point), a short WALKING activity, a long IN_SUBWAY activity (start/end 5 km apart → not joined), an UNKNOWN visit, an empty `timelineMemory` segment and a visit with no location; plus `rawSignals` (one good fix, one 800 m-accuracy fix, one activity record).
- `records.json` — legacy Takeout `Records.json`: `latitudeE7`/`longitudeE7`, `timestamp` and `timestampMs` spellings, one 1200 m-accuracy fix, one fix without coordinates, one with a garbage coordinate; two days, a 4.7 km jump within the first day.
