const TZ = 'Europe/London';
const DAY = 864e5;

const PLACES: Readonly<Record<string, string>> = {
  GBDVR: 'Dover',
  GBLON: 'London',
  GBSOU: 'Southampton',
  GBPME: 'Portsmouth',
  GBHRW: 'Harwich',
  GBTIL: 'Tilbury',
  GBPLY: 'Plymouth',
  GBFAL: 'Falmouth',
  GBLIV: 'Liverpool',
  GBNCL: 'Newcastle',
  GBLEI: 'Leith',
  GBINV: 'Invergordon',
  GBGRK: 'Greenock',
  GBIPS: 'Ipswich',
  GBSHE: 'Sheerness',
  NLAMS: 'Amsterdam',
  NLRTM: 'Rotterdam',
  NLIJM: 'IJmuiden',
  NLMOE: 'Moerdijk',
  BEZEE: 'Zeebrugge',
  BEANR: 'Antwerp',
  FRLEH: 'Le Havre',
  FRCER: 'Cherbourg',
  FRHON: 'Honfleur',
  FRDKK: 'Dunkirk',
  FRSML: 'Saint-Malo',
  DEHAM: 'Hamburg',
  DEBRV: 'Bremerhaven',
  DEKEL: 'Kiel',
  DKCPH: 'Copenhagen',
  NOOSL: 'Oslo',
  NOBGO: 'Bergen',
  SEGOT: 'Gothenburg',
  SESTO: 'Stockholm',
  IEDUB: 'Dublin',
  ESBIO: 'Bilbao',
  PTLIS: 'Lisbon',
  ISREY: 'Reykjavík',
};

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(s: string | number | null): string {
  return String(s ?? '').replaceAll(/[&<>"']/gv, (c) => ESCAPES[c] ?? c);
}

function titleCase(s: string | null): string {
  // The separators before each letter are unchanged by toUpperCase.
  return (s ?? '').toLowerCase().replaceAll(/(?:^|[\s\-'\(])\p{L}/gv, (match) => match.toUpperCase());
}

function normaliseName(s: string): string {
  return s.toUpperCase().replaceAll(/[^A-Z0-9]/gv, '');
}

function place(code: string): string {
  return PLACES[code] ?? (/^[A-Z]{5}$/v.test(code) ? code : titleCase(code));
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- time ----------

function dayKey(d: Readonly<Date>): string {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function clock(d: Readonly<Date>): string {
  return d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

function shortDate(d: Readonly<Date>): string {
  return d.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
}

function when(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const days: readonly (readonly [string, number])[] = [
    ['today', now],
    ['tomorrow', now + DAY],
    ['yesterday', now - DAY],
  ];
  const relative = days.find(([, ts]) => dayKey(new Date(ts)) === dayKey(d));
  const date =
    relative?.[0] ?? d.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  return `${date} at ${clock(d)}`;
}

function duration(ms: number): string {
  const mins = Math.round(Math.abs(ms) / 60_000);
  if (mins < 60) {
    return `${mins} min`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    return `${hours} h ${mins % 60} min`;
  }
  return `${Math.round(hours / 24)} days`;
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) {
    return `${s} s ago`;
  }
  return `${Math.round(s / 60)} min ago`;
}

export { ago, capitalise, clock, duration, esc, normaliseName, place, shortDate, titleCase, when };
