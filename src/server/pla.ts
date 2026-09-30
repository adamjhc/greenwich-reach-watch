// Scrapes the Port of London Authority ship list (the same data embedded on
// https://pla.co.uk/ship-movements). There is no official API, and the pages
// send no CORS headers, so this has to run server-side.

import type { Berth, TierData, TierEvent } from '#shared/types.ts';

import { PORTS } from './ports.ts';

const BASE = 'https://shiplist.pla.co.uk/shiplist.cfm';
const LISTS = { departed: 3, inPort: 4, arrivals: 5, departures: 6, movements: 7 } as const;
const TIER = /GREENWICH TIER/iv;
// How early a move can happen and still count as the forecast one.
const EARLY = 12 * 3600 * 1000;

type Row = readonly string[];

function text(html: string): string {
  return html
    .replaceAll(/<[^>]*>/gv, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll(/&#39;|&apos;/gv, "'")
    .replaceAll('&quot;', '"')
    .replaceAll(/\s+/gv, ' ')
    .trim();
}

function rows(html: string): Row[] {
  const body = /<tbody[^>]*>(?<body>[\s\S]*?)<\/tbody>/iv.exec(html)?.groups?.['body'] ?? '';
  return [...body.matchAll(/<tr[^>]*>(?<cells>[\s\S]*?)<\/tr>/giv)].map((tr) =>
    [...(tr.groups?.['cells'] ?? '').matchAll(/<td[^>]*>(?<cell>[\s\S]*?)<\/td>/giv)].map((td) =>
      text(td.groups?.['cell'] ?? ''),
    ),
  );
}

// Minutes Europe/London is ahead of UTC at the given instant.
function londonOffset(ts: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(ts);
  function get(type: Intl.DateTimeFormatPartTypes): number {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`Intl.DateTimeFormat gave no ${type}`);
    }
    return Number(part.value);
  }
  return (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - ts) / 60_000;
}

interface LocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function fromLondon({ year, month, day, hour, minute }: LocalTime): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(naive - londonOffset(naive) * 60_000);
}

// "30/09" + "15:30" — the forecast lists omit the year, so pick the one
// that puts the date closest to now.
function parseForecastTime(date: string, time: string, now = Date.now()): Date | null {
  const [day = 0, month = 0] = date.split('/').map(Number);
  const [hour = 0, minute = 0] = (time === '' ? '00:00' : time).split(':').map(Number);
  if (Number.isNaN(day) || Number.isNaN(month) || day === 0 || month === 0) {
    return null;
  }
  const thisYear = new Date(now).getUTCFullYear();
  const candidates = [thisYear - 1, thisYear, thisYear + 1].map((year) =>
    fromLondon({ year, month, day, hour, minute }),
  );
  function distance(t: Readonly<Date>): number {
    return Math.abs(t.getTime() - now);
  }
  const [best] = candidates.toSorted((a, b) => distance(a) - distance(b));
  // An unparseable time ("TBA") would make an invalid Date.
  return best === undefined || Number.isNaN(best.getTime()) ? null : best;
}

// "28/09/26 15:06"
function parseBerthed(value: string): Date | null {
  const m = /^(?<day>\d{2})\/(?<month>\d{2})\/(?<year>\d{2}) (?<hour>\d{2}):(?<minute>\d{2})$/v.exec(value)?.groups;
  if (!m) {
    return null;
  }
  return fromLondon({
    year: 2000 + Number(m['year']),
    month: Number(m['month']),
    day: Number(m['day']),
    hour: Number(m['hour']),
    minute: Number(m['minute']),
  });
}

const RETRYABLE = new Set([403, 429, 500, 502, 503, 504]);

// The PLA site sits behind its own bot protection, which occasionally
// refuses a request from Cloudflare's network and accepts the next one.
async function fetchList(flag: number, attempt = 1): Promise<Row[]> {
  const res = await fetch(`${BASE}?flag=${flag}`, {
    headers: { 'user-agent': 'greenwich-reach-watch (personal river dashboard)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (RETRYABLE.has(res.status) && attempt === 1) {
    await res.body?.cancel();
    await scheduler.wait(3000);
    return fetchList(flag, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`PLA list ${flag} returned HTTP ${res.status}`);
  }
  return rows(await res.text());
}

// Columns shared by the arrivals, departures and movements forecasts.
interface Forecast {
  readonly date: string;
  readonly time: string;
  readonly at: string;
  readonly vessel: string;
  readonly agent: string;
  readonly flag: string;
  readonly from: string;
  readonly to: string;
  readonly note: string;
}

function toForecast([
  date = '',
  time = '',
  at = '',
  vessel = '',
  agent = '',
  flag = '',
  from = '',
  to = '',
  note = '',
]: Row): Forecast {
  return { date, time, at, vessel, agent, flag, from, to, note };
}

// "GBLOW" becomes "Lowestoft". Anything else is a berth name, like "TILBURY DOCK".
function placeName(code: string): string {
  return PORTS[code] ?? code;
}

function toMovement(
  type: TierEvent['type'],
  { date, time, at, vessel, agent, flag, from, to, note }: Forecast,
): TierEvent {
  return {
    type,
    vessel,
    time: parseForecastTime(date, time)?.toISOString() ?? null,
    at,
    agent,
    flag,
    from: placeName(from),
    to: placeName(to),
    note: note || null,
  };
}

function toBerth([location = '', vessel = '', ref = '', flag = '', berthed = '']: Row): Berth {
  return { vessel, ref, flag, berthedAt: parseBerthed(berthed)?.toISOString() ?? null, location };
}

// A row of the "departures in the last 24 hours" list.
interface Departure {
  readonly vessel: string;
  readonly from: string;
  readonly at: number;
}

// "30/09 15:10", Vessel, Ref, Nationality, From, To
function toDeparture(row: Row): Departure | null {
  const [time = '', vessel = ''] = row;
  const from = row[4] ?? '';
  const [date = '', clockTime = ''] = time.split(' ');
  const at = parseForecastTime(date, clockTime);
  return at === null ? null : { vessel, from, at: at.getTime() };
}

// The forecast lists keep a move until someone tidies them, often hours after
// it happened, so check it against where the ship actually is.
function happened(e: TierEvent, departed: readonly Departure[], inPort: readonly Berth[]): boolean {
  if (e.time === null) {
    return false;
  }
  const earliest = Date.parse(e.time) - EARLY;
  const berthedSince = inPort.some(
    (b) =>
      b.vessel === e.vessel &&
      b.berthedAt !== null &&
      Date.parse(b.berthedAt) >= earliest &&
      // An arrival is done once the ship is at the tier; a departure once it's
      // somewhere else in the port.
      TIER.test(b.location) === (e.type === 'arrival'),
  );
  const leftTier =
    e.type === 'departure' && departed.some((d) => d.vessel === e.vessel && TIER.test(d.from) && d.at >= earliest);
  return berthedSince || leftTier;
}

async function fetchForecast(flag: number): Promise<Forecast[]> {
  const list = await fetchList(flag);
  return list.map((row) => toForecast(row));
}

// Forecast moves to or from the tier, soonest first.
async function fetchTierForecast(): Promise<TierEvent[]> {
  const arrivals = await fetchForecast(LISTS.arrivals);
  const departures = await fetchForecast(LISTS.departures);
  const movements = await fetchForecast(LISTS.movements);
  return [
    ...arrivals.filter((f) => TIER.test(f.to)).map((f) => toMovement('arrival', f)),
    ...departures.filter((f) => TIER.test(f.from)).map((f) => toMovement('departure', f)),
    // Shifts within the port: to or from the tier.
    ...movements
      .filter((f) => TIER.test(f.from) || TIER.test(f.to))
      .map((f) => toMovement(TIER.test(f.to) ? 'arrival' : 'departure', f)),
  ].toSorted((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
}

async function fetchGreenwichTier(): Promise<TierData> {
  // One at a time: a burst of parallel requests is what rate limiters notice.
  const inPort = await fetchList(LISTS.inPort);
  const departed = await fetchList(LISTS.departed);
  const forecast = await fetchTierForecast();

  const berths = inPort.map((row) => toBerth(row)).filter((b) => b.vessel !== '');
  const current = berths.filter((b) => TIER.test(b.location));
  const left = departed.map((row) => toDeparture(row)).filter((d) => d !== null);
  const events = forecast.filter((e) => !happened(e, left, berths));

  // The forecast keeps past-due entries until the movement is logged, so
  // treat anything from the last few hours as still "next".
  const cutoff = Date.now() - 6 * 3600 * 1000;
  const next = events.find((e) => e.time !== null && Date.parse(e.time) >= cutoff) ?? null;

  return { current, events, next };
}

export { fetchGreenwichTier };
