# Greenwich Reach Watch

A live map of boats on the Thames around Greenwich, plus
what's moored at **Greenwich Ship Tier** and when it next moves.

## Run it locally

Needs Node 22 or newer. The app runs on Cloudflare Workers, and Wrangler
simulates Workers on your machine.

```sh
npm install
cp .env.example .env   # then paste your aisstream.io key into it
npm run dev            # http://localhost:8787
```

Without an API key the site still runs. It shows the Greenwich Tier status
and leaves the map empty.

### Getting the free AIS key

1. Go to <https://aisstream.io> and sign in (GitHub login works).
2. Open **API Keys** and create a key.
3. Put it in `.env` as `AISSTREAM_API_KEY=...`.

## Deploy to Cloudflare

This fits in the Workers free plan.

```sh
npx wrangler login
npx wrangler secret put AISSTREAM_API_KEY
npm run deploy
```

`npm run tail` streams the live logs.

## Data sources

All of these are free. I checked each one before choosing it.

| Need | Source | Cost / access | Notes |
| --- | --- | --- | --- |
| Greenwich Tier status and schedule | [PLA ship list](https://shiplist.pla.co.uk/shiplist.cfm), the data behind [pla.co.uk/ship-movements](https://pla.co.uk/ship-movements) | Free, no key | No API. These are plain HTML tables, and the server scrapes them every 5 minutes. They send no CORS headers, so a browser can't fetch them directly. |
| Live boat positions | [aisstream.io](https://aisstream.io) WebSocket | Free, needs a key | Filtered to a bounding box. Browser connections aren't allowed, so the server holds the socket and relays data over Server-Sent Events. No SLA. |
| Map | [OpenFreeMap](https://openfreemap.org) vector tiles with MapLibre GL | Free, no key | CARTO basemaps now need an API key, so they aren't used. |

Rejected sources:

- **AISHub.** Free only if you run your own AIS receiver and share its feed.
- **MarineTraffic and VesselFinder.** Paid or credit-based.
- **VesselAPI.** Has a free tier, but its limits aren't published.

### PLA ship list pages

| `flag=` | List | Used for |
| --- | --- | --- |
| 4 | In port | What's moored at `GREENWICH TIER` now, and when it berthed |
| 5 | Expected arrivals | Arrivals where *To* is the tier |
| 6 | Expected departures | Departures where *From* is the tier |
| 7 | Expected movements | Shifts to or from the tier within the port |
| 2 / 3 | Arrivals / departures in the last 24 h | Not used |

The forecast lists give the date as `dd/mm` with no year. The server infers
the year and treats times as UK local time (`Europe/London`).

## How it fits together

```
aisstream.io ──WebSocket (only while someone is viewing)──┐
                                                          ├─► River Durable Object ──SSE /api/stream──► browser
PLA ship list ──HTTP, at most every 5 min─────────────────┘
```

- `src/worker.js` is the Worker entry point. Workers Static Assets serves
  `public/`, and the Worker only handles `/api/stream`, `/api/tier` and
  `/api/vessels`.
- `src/river.js` holds the `River` Durable Object. A single instance holds
  the aisstream connection, the vessel state and the cached Tier status, and
  relays updates to every open page. It connects to aisstream when the first
  viewer arrives and disconnects 10 minutes after the last one leaves, so it
  uses little of the free plan's Durable Object allowance. That allowance is
  shared with any other Durable Objects on the account. The last known
  vessels and Tier status are saved to the object's storage, so a returning
  viewer sees boats straight away.
- `src/ais.js` is the aisstream client and vessel tracking. It drops vessels
  not heard from in 30 minutes.
- `src/pla.js` scrapes and parses the PLA lists and builds the Greenwich Tier
  status.
- `public/` is the front end, with no build step.

## Configuration

| Setting | Where | Meaning |
| --- | --- | --- |
| `AISSTREAM_API_KEY` | `.env` locally, `wrangler secret put` in production | Required for live positions |
| `BBOX` | `vars` in `wrangler.jsonc` | Area to watch: `south,west,north,east`. The default `51.468,-0.060,51.512,0.020` covers the river around Greenwich, out to the O2. |

## Caveats

- After a quiet spell, the map fills in gradually. Moving boats report every
  few seconds, but moored ones report only every 3 to 6 minutes. Boat types
  arrive only every 6 minutes.
- Small craft without AIS won't appear.
- The Greenwich Tier marker sits at plus code `9C3XFXMM+HP` (51.4839, -0.0157).
- A ship at the tier is highlighted on the map when its AIS name matches the
  PLA listing.
- Scraping the PLA list is polite (one request per list every 5 minutes), but
  it will break if the PLA changes the page layout.
