# Greenwich Reach Watch

A live map of boats on the Thames around Deptford (SE8) and Greenwich, plus
what's moored at **Greenwich Ship Tier** and when it next moves.

## Run it

Needs Node 22.9 or newer. There are no npm dependencies.

```sh
cp .env.example .env   # then paste your aisstream.io key into it
npm start              # http://localhost:3000
```

Use `npm run dev` to restart on file changes.

Without an API key the site still runs. It shows the Greenwich Tier status
and leaves the map empty.

### Getting the free AIS key

1. Go to <https://aisstream.io> and sign in (GitHub login works).
2. Open **API Keys** and create a key.
3. Put it in `.env` as `AISSTREAM_API_KEY=...`.

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
aisstream.io ──WebSocket──┐
                          ├─► server.js ──SSE /api/stream──► browser (MapLibre map + panel)
PLA ship list ──HTTP/5min─┘
```

- `lib/pla.js` scrapes and parses the PLA lists and builds the Greenwich Tier status.
- `lib/ais.js` handles the aisstream connection, keeps vessel state in memory, and
  drops vessels not heard from in 30 minutes.
- `server.js` serves static files and three endpoints: `/api/tier`,
  `/api/vessels` and `/api/stream` (SSE).
- `public/` is the front end, with no build step.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AISSTREAM_API_KEY` | none | Required for live positions |
| `PORT` | `3000` | HTTP port |
| `BBOX` | `51.468,-0.060,51.512,0.020` | Area to watch: `south,west,north,east`. The default covers Rotherhithe to the O2. |

## Caveats

- The map fills in gradually. Moving boats report every few seconds, but
  moored ones report only every 3 to 6 minutes.
- Small craft without AIS won't appear.
- The Greenwich Tier marker sits at plus code `9C3XFXMM+HP` (51.4839, -0.0157).
- A ship at the tier is highlighted on the map when its AIS name matches the
  PLA listing.
- Scraping the PLA list is polite (one request per list every 5 minutes), but
  it will break if the PLA changes the page layout.
