# Unfog — iPhone acceptance checklist

Real-device pass on the friend's phone (iOS 26.x, Safari). Each item: do the step, compare with the expected
result, note the iOS build if something differs. Caveats at the end come from the iOS PWA research
(task artifact `research/ios-pwa-research.md`).

Before starting: `https://data-t3labs.github.io/unfog/` deployed from `main`; a `Sync.zip` (Files → iCloud Drive →
Fog of World → long-press **Sync** → Compress) on the phone; a charged phone with Low Power Mode **off**.

| # | Step | Expected | Result / iOS build |
|---|------|----------|--------------------|
| 1 | Open the URL in Safari. | Map loads (OpenFreeMap bright), fog over the whole map (nothing visited yet), "Where to?" pill, Fog/Heat/Off, locate button, stat chip "0.00 km² explored / 0 cells" with the hint "Import your Fog of World history or tap Record" above it (tap → Data), Record, tab bar. Install card appears at the bottom (Safari, not installed). Stats shows "Nothing explored yet" with a Go to Data button. | |
| 2 | Safari: page menu → Website Settings → Location → **Allow** (optional, avoids re-prompts in the tab). | Setting saved. | |
| 3 | Share → **Add to Home Screen** → keep "Open as Web App" on → Add. | Icon "Unfog" (navy, fog + orange route) on the Home Screen. | |
| 4 | Launch from the Home Screen. | Full screen, no Safari chrome, status bar over the map, controls clear of the notch and home indicator. Install card does NOT appear. | |
| 5 | Tap the locate button. | iOS location prompt → Allow. Blue dot with halo at your position, map eases to it, locate icon turns blue (follow). Pan the map → follow turns off. | |
| 6 | Data → Import files → Choose File → pick `Sync.zip`. | Progress text, then "N new cells, X km² added" toast (above the tab bar, never over Import files) and per-file lines ("Sync.zip: Fog of World — N tiles"). Map: fog lifted along your history with soft edges; stat chip "X km² explored / N cells"; the empty-state hint is gone. Re-import the same zip → "0 new cells" (no double counting). | |
| 7 | Zoom in/out around your area (z12 → z18). | Overlay stays seamless across tile edges, labels stay above the fog, no blocky cells; pinch/zoom stays smooth (no WebGL context loss). | |
| 8 | Fog → **Heat**. | Amber→red glow by visit count over a dimmed map; legend "visits 1 · 2–3 · 4–6 · 7+". **Off** removes the overlay. | |
| 9 | Help → Settings: Dark basemap, fog softness, reveal, fog strength, tight core, miles. | Each change re-renders the overlay; chrome switches light/dark with the basemap; distances switch units. Settings survive a relaunch. | |
| 10 | "Where to?" → type a nearby place (≥3 letters). | Photon results with name + neighbourhood, biased to the map area. Tap one. | |
| 11 | Route sheet. | Title + "x km direct", Walk/Bike/Drive, detour slider "+25% · up to y km", 2–3 candidates (Most new / Balanced / Direct) with "km · min" and "% new / km unexplored"; selected route orange with glow, alternatives amber/blue; pin at the destination; camera fits the routes above the sheet. Move the slider / switch mode → routes recompute. | |
| 11b | "Where to?" → **Explore a loop from here** (also offered in the route sheet when no route is found). | Sheet "Explore from here · loops of about 3 km": Walk/Bike/Drive, length chips 2 / 3 / 5 / 8 km + a 1–15 km slider, then 1–3 rows "Loop A / B / C" with "km · min" and "% new / km unexplored"; round trips starting at the blue dot (a pin marks the start only when there is no location and the map centre is used), drawn with the same orange/amber/blue styling and fitted above the sheet; pill reads "Loop from here". Tap **5 km** → loops recompute near 5 km; drag the slider → the label follows and loops recompute when you let go; the length is remembered next time. **Go** → follow bar "Loop A · x km · y min", "z% new · round trip from here"; **End** restores the chrome. | |
| 12 | Route somewhere with no graph coverage (outside NYC/Vancouver). | "No routing data for this area yet" with **Download this area** (progress) and/or a region download; after it finishes routes appear. | |
| 13 | Tap **Go**. | Sheet collapses to a bar (route name · km · min, **End**); the map follows the blue dot; selected route stays. Walk 50 m → dot moves, map follows. **End** restores the chrome. | |
| 14 | Long-press the map. | Destination pin dropped, route sheet opens ("Dropped pin"). Clear with × next to the search pill. | |
| 15 | Tap **Record**, walk ~5 minutes with the screen on. | Red banner: elapsed, distance, "+N new". Screen does not auto-lock (wake lock). Walking a street you have never walked lifts fog behind you after the first checkpoint (≤60 s). | |
| 16 | While recording: press the side button (lock), wait 30 s, unlock and return. | Banner still there; fixes resume; the gap is not bridged with a straight line if > 500 m. Wake lock re-acquired (screen stays on again). | |
| 17 | While recording: switch to another app for 2 minutes, come back. | Either the session is still running, or the app relaunches and offers "Unfinished recording — Resume / Finish and save / Discard". Resume continues with the same session. | |
| 18 | Tap **Stop**. | Summary sheet: distance, time, new cells, ≈ new area, "Export GPX" → share sheet → Save to Files. Data → Recorded sessions lists it with GPX export and delete. | |
| 19 | Data → **Export backup**. | Share sheet with `unfog-backup-YYYYMMDD.zip` → Save to Files / iCloud Drive. "Last backup today" under the button. Stats → Last backup date updated. | |
| 20 | Delete the Home Screen icon, reinstall from Safari, open, Data → Import → pick the backup zip. | Everything restored (same area in the stat chip; sessions listed). | |
| 21 | Airplane mode, relaunch from the Home Screen, pan around your area. | App loads offline; previously viewed basemap tiles show; unvisited basemap areas are blank but the fog/heat overlay still renders; search shows "needs a connection". | |
| 22 | Data → Routing data → Download New York City (on Wi-Fi), then airplane mode → plan a route in NYC. | Progress to 100 %; "Offline since …" line; routing works offline. | |
| 23 | Wait for a new deploy, relaunch. | "Update available — Reload" toast; Reload loads the new version without losing data. | |
| 24 | Import GPX (Apple Health export `workout-routes/*.gpx`) and a Google Timeline JSON. | Each shows as "1 track" / "N tracks"; stats list the sources. | |

## Things the headless suite cannot prove — check on the phone

The real-engine e2e suite (`tests/e2e/real.spec.ts`, Chromium with an iPhone 15 profile) drives the same
code paths, but a few behaviours only exist on iOS. Do these explicitly:

| # | Step | Expected | Result / iOS build |
|---|------|----------|--------------------|
| A1 | Data → Import files → in the Files picker, navigate to iCloud Drive → Fog of World → Sync and try to multi-select two **raw tile files** (no extension, e.g. `23e4lltkkoke`). | Files are selectable (the picker honours `application/octet-stream` in the `accept` list). If they are greyed out, that is an iOS `accept` filter problem: note it, then use Sync.zip instead (the zip path is always allowed). | |
| A2 | Same picker: pick `Sync.zip` **and** a `.gpx` in one go. | Both import; the result list has one line per file. | |
| A3 | Data → Export backup → in the share sheet tap **Cancel** (swipe it away). | Toast "Backup cancelled"; "No backup yet" / the old date stays; Stats → Last backup unchanged. (A dismissed share sheet must not count as a backup.) | |
| A4 | Export backup → **Save to Files** → iCloud Drive. Then Stop a recording → Export GPX → Save to Files. | Files land with the names `unfog-backup-YYYYMMDD.zip` / `unfog-YYYY-MM-DD-HHMM.gpx`; the app toasts "Backup shared" / "GPX shared". In a Safari tab (not installed) the share sheet still offers files; if it does not, the app falls back to a download banner. | |
| A5 | Fresh install, Home Screen app, location never granted: tap **Record** first (not the locate button). | One iOS prompt; after Allow the banner appears within a few seconds and the first fix is the first point (the dot appears where you stand). Deny → toast with the Help link, no banner, Record stays idle. | |
| A6 | Record indoors / just after launch (coarse first fixes). | Fixes worse than 50 m are dropped silently — the banner distance stays 0 m until accuracy improves; the summary shows "N dropped". Walk to a window if it never starts. | |
| A7 | Record, then lock the phone for 2 minutes. | On unlock the banner is still there and the elapsed time kept running; distance only grows again after the next fix (iOS gives none while locked). | |
| A8 | Record, switch to Camera for 5+ minutes (or take several photos), come back. | If iOS killed the app: relaunch shows "Unfinished recording · N fixes" with Resume / Finish and save / Discard (the sheet cannot be dismissed by tapping outside). Resume keeps the same session; Finish saves every point. | |
| A9 | Airplane mode **before the very first launch** of a fresh install (worst case: basemap style never cached). | The app still opens: plain grey ground instead of streets, fog/heat overlay renders over it, stats + Data work, routing works where graph data is cached. Turning networking back on swaps in the real basemap without a relaunch. | |
| A10 | Airplane mode → "Where to?" → type a place. | Status "Search needs a connection", no crash; long-press still drops a pin and routes if graph data is cached. | |
| A11 | Route somewhere in NYC that was never opened online, while offline, **without** having downloaded the region. | "No routing data for this area yet" with the region/area download buttons; tapping one fails with a clear "Download failed" line (no spinner stuck). | |
| A12 | Help → Settings → change a slider with a finger drag (not a tap). | The value label follows the drag; the overlay re-renders only when the finger lifts (one re-render per gesture, no stutter). | |
| A13 | Delete the Home Screen icon → Safari → same URL. | Data is gone (separate container) and the install card is back; importing the backup restores everything. | |
| A14 | Trigger two toasts in a row (e.g. Data → Export backup → Cancel the share sheet, then straight away Export again → Save), and one while a route sheet / the Heat legend is up. | Toasts show one at a time (the second waits for the first), sit just above the tab bar / stat chip / sheet — never over a button — and never touch the locate button or the legend. With the phone in landscape the sheets, screens and search panel keep clear of the notch (safe-area padding). | |

## Known iOS caveats (design expectations, not bugs)

- **No background location.** Recording only works in the foreground with the screen on. Locking the phone or switching apps pauses fixes; long gaps are not bridged. Fill gaps with Apple Health / Strava GPX or Google Timeline imports.
- **Process death.** After a long time in the background the app relaunches from scratch (WebGL-heavy pages are killed first). The session is persisted on every fix and offered for resume; the camera position is restored.
- **Wake lock** fails in Low Power Mode / critical battery (banner shows the hint) and is released on every hide; it is re-requested when the app becomes visible again. Works in Home Screen apps only since iOS 18.4.
- **Location permission.** No install-time prompt; the first request comes from a tap. `permissions.query` is unreliable on WebKit, so the app always asks and handles "denied" with the Help panel. iOS 26.0.x had an installed-app "denied" regression — Settings › General › Transfer or Reset › Reset › Reset Location & Privacy fixes it. Precise Location off ⇒ accuracy in km ⇒ fixes are dropped (> 50 m).
- **Separate container.** The Home Screen app does not share storage or permissions with the Safari tab; importing/allowing must be done inside the installed app. Deleting the icon deletes the data — hence the backup nag after 14 days.
- **No install prompt / share target.** Install is manual (Share → Add to Home Screen); files cannot be shared *to* Unfog, only picked from Files. No orientation lock (manifest `orientation` is ignored), no splash image unless `apple-touch-startup-image` PNGs are added.
- **Cross-origin links** (attribution) open an in-app browser overlay, not Safari.
- **Storage.** Home Screen apps get a large quota and `persist()` is auto-granted; the ITP 7-day wipe applies to the Safari-tab version only — install, don't bookmark.
