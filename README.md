# Greenwich Reach Watch

A live map of boats on the Thames around Greenwich, plus
what's moored at **Greenwich Ship Tier** and when it next moves.

## Run it locally

Needs Node 22 or newer. The app runs on Cloudflare Workers. Vite, with the
Cloudflare Vite plugin, runs the Worker in the real Workers runtime on your
machine and serves the page with hot reload.

```sh
npm install
cp .env.example .env   # then paste your aisstream.io key into it
npm run dev            # http://localhost:5173
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

Pushes to `main` also deploy through GitHub Actions once the checks and build
pass. The workflow needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as
repository secrets.

## Data sources

All of these are free. I checked each one before choosing it.

| Need                               | Source                                                                                                                                 | Cost / access     | Notes                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greenwich Tier status and schedule | [PLA ship list](https://shiplist.pla.co.uk/shiplist.cfm), the data behind [pla.co.uk/ship-movements](https://pla.co.uk/ship-movements) | Free, no key      | No API. These are plain HTML tables, and the server scrapes them every 5 minutes. They send no CORS headers, so a browser can't fetch them directly. |
| Live boat positions                | [aisstream.io](https://aisstream.io) WebSocket                                                                                         | Free, needs a key | Filtered to a bounding box. Browser connections aren't allowed, so the server holds the socket and relays data over Server-Sent Events. No SLA.      |
| Map                                | [OpenFreeMap](https://openfreemap.org) vector tiles with MapLibre GL                                                                   | Free, no key      | CARTO basemaps now need an API key, so they aren't used.                                                                                             |
| River centreline                   | [OpenStreetMap](https://www.openstreetmap.org) via the [Overpass API](https://overpass-api.de)                                         | Free, no key      | The middle of the Thames, so moving boats follow its bends between reports. Built into the page; see below.                                          |
| Port names                         | [UN/LOCODE](https://unece.org/trade/uncefact/unlocode), via the [datasets/un-locode](https://github.com/datasets/un-locode) CSV mirror | Free, no key      | Turns the PLA's port codes (`GBLOW`) into names (Lowestoft). Built into the Worker; see below.                                                       |

Rejected sources:

- **AISHub.** Free only if you run your own AIS receiver and share its feed.
- **MarineTraffic and VesselFinder.** Paid or credit-based.
- **VesselAPI.** Has a free tier, but its limits aren't published.

### PLA ship list pages

| `flag=` | List                        | Used for                                                   |
| ------- | --------------------------- | ---------------------------------------------------------- |
| 4       | In port                     | What's moored at `GREENWICH TIER` now, and when it berthed |
| 5       | Expected arrivals           | Arrivals where _To_ is the tier                            |
| 6       | Expected departures         | Departures where _From_ is the tier                        |
| 7       | Expected movements          | Shifts to or from the tier within the port                 |
| 3       | Departures in the last 24 h | Dropping forecast departures that have already happened    |
| 2       | Arrivals in the last 24 h   | Not used                                                   |

The forecast lists keep a move for hours after it happens. The server drops a
forecast departure once list 3 shows the ship leaving the tier, and a forecast
arrival once list 4 shows it berthed there.

The forecast lists give the date as `dd/mm` with no year. The server infers
the year and treats times as UK local time (`Europe/London`).

## How it fits together

```
aisstream.io ──WebSocket (only while someone is viewing)──┐
                                                          ├─► River Durable Object ──SSE /api/stream──► browser
PLA ship list ──HTTP, at most every 5 min─────────────────┘
```

Everything is TypeScript. `npm run build` uses Vite to build the Worker and
the page into `dist/`, and `npm run deploy` builds before deploying.
`npm run preview` serves that build locally in the Workers runtime.

- `src/server/worker.ts` is the Worker entry point. Workers Static Assets
  serves the page (`index.html`, the bundled `src/client/` code and the
  files in `public/`), and the Worker only handles `/api/stream`, `/api/tier`
  and `/api/vessels`.
- `src/server/river.ts` holds the `River` Durable Object. A single instance
  holds the aisstream connection, the vessel state and the cached Tier
  status, and relays updates to every open page. It connects to aisstream
  when the first viewer arrives and disconnects 10 minutes after the last one
  leaves, so it uses little of the free plan's Durable Object allowance. That
  allowance is shared with any other Durable Objects on the account. The last
  known vessels and Tier status are saved to the object's storage, so a
  returning viewer sees boats straight away.
- `src/server/ais.ts` is the aisstream client and vessel tracking. It drops
  vessels not heard from in 30 minutes. `src/server/aisstream.ts` parses
  aisstream's messages.
- `src/server/pla.ts` scrapes and parses the PLA lists and builds the
  Greenwich Tier status.
- `src/server/ports.ts` maps UN/LOCODE port codes to names, for the 17,500 or
  so locations UN/LOCODE marks as ports. It's generated by `npm run ports`
  (`scripts/ports.ts`), so don't edit it by hand. UN/LOCODE uses local
  spellings (København, Göteborg), so the script swaps in English names for
  the few ports an English reader knows by another name. UNECE publishes two
  releases a year; rerun the script to pick one up.
- `src/client/` is the front end. `app.ts` is the entry point.
- `src/client/reckon.ts` moves boats between AIS reports. A moving boat
  carries on at its last reported speed for up to a minute, slowing to a stop
  over the last 10 seconds. It follows the river rather than a straight line:
  its speed is split into a part along the river and a part across it, and the
  part across fades away before it reaches the bank. When a new report arrives
  the boat glides to it over at least 4 seconds, starting at the speed and
  direction it was already moving, so its path curves rather than kinks. Big
  corrections take longer, up to 15 seconds, and a boat drawn ahead of its
  report slows down rather than reversing. The arrow points the way the boat
  is drawn moving, so it never seems to slide sideways. Boats more than 250 m
  from the middle of the river, in a dock or creek, stay where they report.
  Visitors who ask for reduced motion see reported positions only.
- `src/client/thames.ts` is the middle of the Thames through the map area,
  generated from OpenStreetMap by `npm run thames` (`scripts/thames.ts`).
  `src/client/waterway.ts` turns it into positions along and across the
  river. Rerun the script if you widen `BBOX`.
- `src/shared/types.ts` holds the payload types both sides agree on. Import
  it as `#shared/types.ts`.
- `worker-configuration.d.ts` is generated by `npm run types` from
  `wrangler.jsonc`. Rerun it after changing bindings or vars.

## Checks

`npm run check` runs all of these. Each fails on any finding.

| Script                 | Tool                          | Checks                                                                                        |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | TypeScript (`tsc -b`)         | Strict mode plus every extra strictness flag. The generated Worker types are up to date.      |
| `npm run lint`         | oxlint, with type-aware rules | Every rule category, including nursery, in `.oxlintrc.json`. Disabled rules are listed there. |
| `npm run format:check` | oxfmt                         | Formatting and import order. `npm run format` fixes it.                                       |
| `npm run knip`         | knip                          | Unused files, exports, types and dependencies.                                                |

## Configuration

| Setting             | Where                                               | Meaning                                                                                                                            |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `AISSTREAM_API_KEY` | `.env` locally, `wrangler secret put` in production | Required for live positions                                                                                                        |
| `BBOX`              | `vars` in `wrangler.jsonc`                          | Area to watch: `south,west,north,east`. The default `51.468,-0.060,51.512,0.020` covers the river around Greenwich, out to the O2. |

## Caveats

- After a quiet spell, the map fills in gradually. Moving boats report every
  few seconds, but moored ones report only every 3 to 6 minutes. Boat types
  arrive only every 6 minutes.
- Small craft without AIS won't appear.
- Between reports, a moving boat's position is a guess. One that stops,
  turns round or pulls into a pier after its last report is drawn carrying
  on until the next report corrects it.
- The Greenwich Tier marker sits at plus code `9C3XFXMM+HP` (51.4839, -0.0157).
- A ship at the tier is highlighted on the map when its AIS name matches the
  PLA listing.
- Scraping the PLA list is polite (one request per list every 5 minutes), but
  it will break if the PLA changes the page layout.
