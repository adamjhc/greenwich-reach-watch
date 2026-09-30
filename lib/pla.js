// Scrapes the Port of London Authority ship list (the same data embedded on
// https://pla.co.uk/ship-movements). There is no official API, and the pages
// send no CORS headers, so this has to run server-side.

const BASE = 'https://shiplist.pla.co.uk/shiplist.cfm';
const LISTS = { inPort: 4, arrivals: 5, departures: 6, movements: 7 };
const TIER = /GREENWICH TIER/i;

function text(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function rows(html) {
  const body = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? '';
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((tr) =>
    [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((td) => text(td[1])),
  );
}

// Minutes Europe/London is ahead of UTC at the given instant.
function londonOffset(ts) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(ts);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - ts) / 60000;
}

function fromLondon(year, month, day, hour, minute) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(naive - londonOffset(naive) * 60000);
}

// "30/09" + "15:30" — the forecast lists omit the year, so pick the one
// that puts the date closest to now.
function parseForecastTime(date, time, now = Date.now()) {
  const [d, m] = date.split('/').map(Number);
  const [h, min] = (time || '00:00').split(':').map(Number);
  if (!d || !m) return null;
  const year = new Date(now).getUTCFullYear();
  return [year - 1, year, year + 1]
    .map((y) => fromLondon(y, m, d, h, min))
    .reduce((best, t) => (Math.abs(t - now) < Math.abs(best - now) ? t : best));
}

// "28/09/26 15:06"
function parseBerthed(value) {
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, min] = m.map(Number);
  return fromLondon(2000 + y, mo, d, h, min);
}

async function fetchList(flag) {
  const res = await fetch(`${BASE}?flag=${flag}`, {
    headers: { 'user-agent': 'greenwich-reach-watch (personal river dashboard)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`PLA list ${flag} returned HTTP ${res.status}`);
  return rows(await res.text());
}

function toMovement(type, [date, time, at, vessel, agent, flag, from, to, note]) {
  return {
    type,
    vessel,
    time: parseForecastTime(date, time)?.toISOString() ?? null,
    at,
    agent,
    flag,
    from,
    to,
    note: note || null,
  };
}

export async function fetchGreenwichTier() {
  const [inPort, arrivals, departures, movements] = await Promise.all(
    Object.values(LISTS).map(fetchList),
  );

  const current = inPort
    .filter(([location, vessel]) => vessel && TIER.test(location))
    .map(([location, vessel, ref, flag, berthed]) => ({
      vessel,
      ref,
      flag,
      berthedAt: parseBerthed(berthed)?.toISOString() ?? null,
      location,
    }));

  const events = [
    ...arrivals.filter((r) => TIER.test(r[7])).map((r) => toMovement('arrival', r)),
    ...departures.filter((r) => TIER.test(r[6])).map((r) => toMovement('departure', r)),
    // Shifts within the port: to or from the tier.
    ...movements
      .filter((r) => TIER.test(r[6]) || TIER.test(r[7]))
      .map((r) => toMovement(TIER.test(r[7]) ? 'arrival' : 'departure', r)),
  ].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));

  // The forecast keeps past-due entries until the movement is logged, so
  // treat anything from the last few hours as still "next".
  const cutoff = Date.now() - 6 * 3600 * 1000;
  const next = events.find((e) => e.time && Date.parse(e.time) >= cutoff) ?? null;

  return { current, events, next };
}
