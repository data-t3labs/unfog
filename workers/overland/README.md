# Unfog Overland receiver

A Cloudflare Worker with a KV namespace that receives the location batches the free
[Overland](https://overland.p3k.app/) iOS app sends in the background, keeps them for 30 days, and
hands them to the Unfog app when it opens (Data → Sources → Overland → "Pull now", and on every
open). Runs on Cloudflare's free plan: no card, no server to maintain.

This folder is its own tiny package; the app does not depend on it. The Worker source is
`src/worker.ts`; its handlers are unit-tested from the app's suite with an in-memory KV double
(`tests/unit/overland-worker.test.ts`, `npx vitest run` at the repo root).

## Deploy (once, ~10 minutes)

You need a free Cloudflare account (https://dash.cloudflare.com/sign-up) and Node.

```sh
cd workers/overland
npm install                                  # wrangler (Cloudflare's CLI); or use `npx wrangler` throughout
npx wrangler login                           # opens the browser once
npx wrangler kv namespace create OVERLAND_KV # prints:  id = "…"  → paste into wrangler.toml
openssl rand -hex 16                         # the token for one phone; keep it
npx wrangler secret put OVERLAND_TOKENS      # paste the token (several phones: comma-separated)
npx wrangler deploy                          # prints  https://unfog-overland.<account>.workers.dev
```

Check it: open the printed URL in a browser — it answers "Unfog Overland receiver…". Then give the
phone two things: that URL and the token.

Everything can be redone: `wrangler secret put` replaces the tokens; `wrangler deploy` updates the
code; `wrangler tail` streams live requests while you test.

`APP_ORIGIN` in `wrangler.toml` lists the browser origins allowed to pull (the GitHub Pages site
and localhost). Change it if Unfog is hosted elsewhere.

## Overland app settings (on the phone)

1. App Store → **Overland GPS Tracker** (free). Allow location **Always** with **Precise** on.
2. Settings → **Server URL**: the Worker URL. **Access Token**: the token.
3. **Tracking Enabled** on. **Continuous Tracking Mode**: Standard (Both also works; Significant
   Location alone is too sparse for fog).
4. **Send Interval**: 5 min or longer. **Locations per Batch**: 100. (Free KV allows 1 000 writes a
   day; the receiver writes one KV entry per batch.)
5. Leave "Consider HTTP 2XX Successful" **off**: the receiver answers `{"result":"ok"}`, which is
   what Overland waits for before deleting a batch from the phone.

In Unfog: Data → Sources → Overland → paste the URL and token → Save → **Test** ("Receiver OK — N
batches stored"). From then on Unfog pulls new batches every time it opens and every 15 minutes
while open. Points land on the map as one track per day ("Overland 2026-09-03").

## API

Bearer token per phone, in the header only: `Authorization: Bearer <token>` (Overland sends it that
way). A token in the URL is refused — Cloudflare's request logs and `wrangler tail` keep URLs.

| Method | Path | Purpose | Reply |
|---|---|---|---|
| POST | `/` | Overland batch (`{"locations": [GeoJSON Feature…]}`) | `{"result":"ok"}` |
| GET | `/pull?since=<cursor>&limit=25` | up to 25 batches after the cursor, oldest first | `{result, batches:[{key, received, points:[{t, lon, lat, acc?, speed?}]}], cursor, hasMore}` |
| GET | `/status` | how many batches are stored, newest time | `{result, batches, latest}` |
| DELETE | `/` | delete up to 40 of this token's batches; repeat while `more` | `{result, deleted, more}` |
| GET | `/` | banner (no auth) | text |

`key` and `cursor` are `<epochMs13>-<seq5>` — the token is never part of them, because the cursor
goes into the next pull's URL. (A cursor saved by an older app, `<token>/<epochMs13>-<seq5>`, is
still accepted.) Unfog keeps pulling pages while `hasMore` is true, so a night's backlog arrives
in a few requests.

Storage: key `<token>/<epochMs13>-<seq5>`, value `{v:1, received, device, points}`, expiring after
`BATCH_TTL_DAYS` (30). Points keep only what Unfog uses: time (ms), lon, lat, horizontal accuracy,
speed. Nothing else about the phone is stored.

Wipe everything for a token (repeat until `"more":false`):

```sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" https://unfog-overland.<account>.workers.dev/
```

## Free-plan limits that matter

- Subrequests: 50 per request, and every KV call is one. That is why `/pull` serves at most 25
  batches (plus up to 20 list pages) and `DELETE` removes 40 per call — a request that went over
  would fail outright and nothing would ever drain.
- KV: 1 000 writes/day (one per batch), 100 000 reads/day, 1 GB. A phone sending every 5 minutes
  writes at most 288 a day.
- Workers: 100 000 requests/day.
- Batches older than 30 days expire on their own; Unfog pulls long before that.
