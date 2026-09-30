/* global maplibregl */

// Plus code 9C3XFXMM+HP (FXMM+HP London), Greenwich Reach.
const TIER_POSITION = [51.483937, -0.015688]; // lat, lon
const TZ = 'Europe/London';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const PLACES = {
  GBDVR: 'Dover', GBLON: 'London', GBSOU: 'Southampton', GBPME: 'Portsmouth', GBHRW: 'Harwich',
  GBTIL: 'Tilbury', GBPLY: 'Plymouth', GBFAL: 'Falmouth', GBLIV: 'Liverpool', GBNCL: 'Newcastle',
  GBLEI: 'Leith', GBINV: 'Invergordon', GBGRK: 'Greenock', GBIPS: 'Ipswich', GBSHE: 'Sheerness',
  NLAMS: 'Amsterdam', NLRTM: 'Rotterdam', NLIJM: 'IJmuiden', NLMOE: 'Moerdijk', BEZEE: 'Zeebrugge',
  BEANR: 'Antwerp', FRLEH: 'Le Havre', FRCER: 'Cherbourg', FRHON: 'Honfleur', FRDKK: 'Dunkirk',
  FRSML: 'Saint-Malo', DEHAM: 'Hamburg', DEBRV: 'Bremerhaven', DEKEL: 'Kiel', DKCPH: 'Copenhagen',
  NOOSL: 'Oslo', NOBGO: 'Bergen', SEGOT: 'Gothenburg', SESTO: 'Stockholm', IEDUB: 'Dublin',
  ESBIO: 'Bilbao', PTLIS: 'Lisbon', ISREY: 'Reykjavík',
};

const FLAGS = {
  GBR: 'British', NOR: 'Norwegian', MLT: 'Maltese', BHS: 'Bahamian', PRT: 'Portuguese', NLD: 'Dutch',
  DEU: 'German', FRA: 'French', CHE: 'Swiss', BMU: 'Bermudan', PAN: 'Panamanian', LBR: 'Liberian',
  MHL: 'Marshall Islands', CYP: 'Cypriot', ITA: 'Italian', ESP: 'Spanish', DNK: 'Danish',
  DIS: 'Danish', GIB: 'Gibraltarian', IRL: 'Irish', BEL: 'Belgian', SWE: 'Swedish', FIN: 'Finnish',
  USA: 'American', ATG: 'Antiguan', MDR: 'Madeiran', NIS: 'Norwegian',
};

const CATEGORIES = {
  passenger: 'Passenger boats and cruise ships',
  cargo: 'Cargo and tankers',
  work: 'Tugs and workboats',
  leisure: 'Sailing and leisure',
  other: 'Other or unknown',
};

const NAV_STATUS = {
  0: 'Under way', 1: 'At anchor', 2: 'Not under command', 3: 'Restricted manoeuvrability',
  5: 'Moored', 6: 'Aground', 7: 'Fishing', 8: 'Under sail',
};

const el = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const titleCase = (s) =>
  String(s ?? '').toLowerCase().replace(/(^|[\s\-'(])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
const normaliseName = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const place = (code) => PLACES[code] ?? (/^[A-Z]{5}$/.test(code) ? code : titleCase(code));

function category(type) {
  if (type >= 60 && type <= 69) return 'passenger';
  if (type >= 70 && type <= 89) return 'cargo';
  if ([31, 32, 33, 34, 35].includes(type) || (type >= 50 && type <= 59)) return 'work';
  if (type === 36 || type === 37) return 'leisure';
  return 'other';
}

// ---------- time ----------

const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const clock = (d) => d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

function when(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 864e5);
  const yesterday = new Date(Date.now() - 864e5);
  if (dayKey(d) === dayKey(today)) return `today at ${clock(d)}`;
  if (dayKey(d) === dayKey(tomorrow)) return `tomorrow at ${clock(d)}`;
  if (dayKey(d) === dayKey(yesterday)) return `yesterday at ${clock(d)}`;
  const date = d.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  return `${date} at ${clock(d)}`;
}

const shortDate = (d) => d.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function duration(ms) {
  const mins = Math.round(Math.abs(ms) / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ${mins % 60} min`;
  return `${Math.round(hours / 24)} days`;
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} s ago`;
  return `${Math.round(s / 60)} min ago`;
}

// ---------- state ----------

let tier = null;
let feed = { status: { state: 'connecting' }, vessels: [] };
const markers = new Map();

function tierVesselNames() {
  if (!tier) return new Set();
  const names = [...(tier.current ?? []).map((c) => c.vessel)];
  if (tier.next) names.push(tier.next.vessel);
  return new Set(names.map(normaliseName));
}

// ---------- tier panel ----------

function eventSentence(e) {
  const name = `<strong>${esc(titleCase(e.vessel))}</strong>`;
  return e.type === 'departure'
    ? `${name} leaves for ${esc(place(e.to))}`
    : `${name} arrives from ${esc(place(e.from))}`;
}

function renderTier() {
  const body = el('tier-body');
  if (!tier || (!tier.current && tier.error)) {
    body.innerHTML = `<p class="error">Couldn't reach the Port of London ship list${
      tier?.error ? `: ${esc(tier.error)}` : ''
    }. Trying again in 5 minutes.</p>`;
    return;
  }

  const [ship] = tier.current ?? [];
  const next = tier.next;
  let html = '';

  if (ship) {
    const flag = FLAGS[ship.flag] ? `${FLAGS[ship.flag]} flag` : `Flag ${esc(ship.flag)}`;
    html += `
      <p class="state">Moored now</p>
      <p class="ship"><span class="ship-mark">${esc(titleCase(ship.vessel))}</span></p>
      <p class="facts">${flag}, berthed ${ship.berthedAt ? esc(when(ship.berthedAt)) : 'at an unknown time'}.</p>`;
    if (tier.current.length > 1) {
      html += `<p class="facts">Also moored: ${tier.current
        .slice(1)
        .map((s) => esc(titleCase(s.vessel)))
        .join(', ')}.</p>`;
    }
  } else {
    html += `<p class="state">Nothing is moored at the tier.</p>`;
  }

  if (next?.time) {
    const ms = Date.parse(next.time) - Date.now();
    const verb = next.type === 'departure' ? 'Leaves' : 'Arrives';
    const isShip = ship && normaliseName(next.vessel) === normaliseName(ship.vessel);
    const what = isShip
      ? next.type === 'departure'
        ? `${esc(capitalise(when(next.time)))}, bound for ${esc(place(next.to))}.`
        : `${esc(capitalise(when(next.time)))} from ${esc(place(next.from))}.`
      : `${eventSentence(next)} ${esc(when(next.time))}.`;
    html += `<div class="next">`;
    if (ms > 0) {
      html += `<p class="next-when">${isShip ? verb : 'Next'} in ${duration(ms)}</p>`;
    } else {
      const due = next.type === 'departure' ? 'Due to leave' : 'Due to arrive';
      html += `<p class="next-when">${isShip ? due : 'Next move'} now</p>`;
    }
    html += `<p class="next-what">${what}</p>`;
    if (ms <= 0) {
      html += `<p class="overdue">Scheduled ${duration(ms)} ago. The PLA list updates once the pilot logs the move.</p>`;
    }
    html += `</div>`;
  } else {
    html += `<p class="facts">No ${ship ? 'departure' : 'arrival'} is in the PLA forecast yet. Forecasts usually appear a few days ahead.</p>`;
  }

  // A single refused refresh is retried within a minute, so only mention it
  // once the copy on screen is getting old.
  const age = tier.updatedAt ? Date.now() - Date.parse(tier.updatedAt) : 0;
  if (tier.error && age > 15 * 60 * 1000) {
    html += `<p class="error">The Port of London ship list hasn't responded since ${esc(
      when(tier.updatedAt),
    )}, so this may be out of date. It's retried every minute while the page is open.</p>`;
  }
  body.innerHTML = html;
}

function renderSchedule() {
  const list = el('schedule');
  const events = tier?.events ?? [];
  if (!events.length) {
    list.innerHTML = `<li><span></span><span class="quiet">No movements to or from the tier are scheduled.</span></li>`;
    return;
  }
  const cutoff = Date.now();
  list.innerHTML = events
    .map(
      (e) => `
      <li class="${e.time && Date.parse(e.time) < cutoff ? 'past' : ''}">
        <time datetime="${esc(e.time)}">${
          e.time ? `${esc(shortDate(new Date(e.time)))}<br>${clock(new Date(e.time))}` : 'Time not set'
        }</time>
        <span>${eventSentence(e)}${e.note ? `<br><span class="quiet">${esc(e.note.replace(/\bReqd\.?/i, 'required'))}</span>` : ''}</span>
      </li>`,
    )
    .join('');
}

// ---------- map ----------

const dark = matchMedia('(prefers-color-scheme: dark)');
const styleUrl = () => `https://tiles.openfreemap.org/styles/${dark.matches ? 'dark' : 'positron'}`;

// Centred just north of the tier so both banks are in view.
const homeView = () => ({
  center: [TIER_POSITION[1], TIER_POSITION[0] + 0.002],
  zoom: matchMedia('(max-width: 800px)').matches ? 13.6 : 14.6,
});

const map = new maplibregl.Map({
  container: 'map',
  style: styleUrl(),
  ...homeView(),
  // Headings are drawn relative to north, so keep the map north-up.
  dragRotate: false,
  pitchWithRotate: false,
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
map.addControl(
  {
    onAdd() {
      const div = document.createElement('div');
      div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      div.innerHTML = `<button type="button" class="reset-view" title="Reset map view" aria-label="Reset map view">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="5" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="9" cy="9" r="1.75" fill="currentColor"/><path d="M9 1v3M9 14v3M1 9h3M14 9h3" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>
      </button>`;
      div.querySelector('button').addEventListener('click', () => {
        reduceMotion ? map.jumpTo(homeView()) : map.flyTo({ ...homeView(), duration: 800 });
      });
      return div;
    },
    onRemove() {},
  },
  'top-left',
);
dark.addEventListener('change', () => map.setStyle(styleUrl()));

const tierLabel = document.createElement('div');
tierLabel.className = 'tier-label';
tierLabel.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/></svg>Greenwich Tier`;
new maplibregl.Marker({ element: tierLabel, anchor: 'left', offset: [-7, 0] })
  .setLngLat([TIER_POSITION[1], TIER_POSITION[0]])
  .addTo(map);

map.addControl(
  {
    onAdd() {
      const div = document.createElement('details');
      div.className = 'legend maplibregl-ctrl';
      div.open = !matchMedia('(max-width: 800px)').matches;
      div.innerHTML =
        '<summary>Key</summary>' +
        Object.entries(CATEGORIES)
          .map(([key, label]) => `<div>${shape({ cat: key, moving: false, size: 12 })}${label}</div>`)
          .join('') + `<div>${shape({ cat: 'tier', moving: false, size: 12 })}At or due at the tier</div>`;
      return div;
    },
    onRemove() {},
  },
  'top-right',
);

function shape({ cat, moving, rotation = 0, size = 18 }) {
  const fill = cat === 'tier' ? 'var(--signal)' : `var(--cat-${cat})`;
  const stroke = cat === 'tier' ? 'var(--signal-ink)' : 'var(--paper)';
  if (moving) {
    return `<svg class="swatch" width="${size}" height="${size}" viewBox="-10 -10 20 20" aria-hidden="true">
      <path d="M0 -9 L6 7 L0 4 L-6 7 Z" style="fill:${fill};stroke:${stroke}" stroke-width="1.5"
        stroke-linejoin="round" transform="rotate(${rotation})"/></svg>`;
  }
  return `<svg class="swatch" width="${size}" height="${size}" viewBox="-10 -10 20 20" aria-hidden="true">
    <circle r="6.5" style="fill:${fill};stroke:${stroke}" stroke-width="1.5"/></svg>`;
}

function describe(v) {
  if (v.sog >= 0.5) return `${v.sog.toFixed(1)} knots`;
  return NAV_STATUS[v.navStatus] === 'Moored' ? 'Moored' : 'Stationary';
}

function popup(v, cat) {
  const course = v.cog ?? v.heading;
  const rows = [
    CATEGORIES[cat === 'tier' ? category(v.type) : cat],
    v.sog >= 0.5 ? `${v.sog.toFixed(1)} knots${course != null ? `, heading ${Math.round(course)}°` : ''}` : describe(v),
    v.destination ? `Destination: ${esc(titleCase(v.destination))}` : null,
    v.length ? `${v.length} m long` : null,
    `MMSI ${v.mmsi}, heard ${ago(v.lastSeen)}`,
  ].filter(Boolean);
  return `<span class="name">${esc(titleCase(v.name) || 'Unnamed vessel')}</span>${rows.join('<br>')}`;
}

function vesselCategory(v, tierNames) {
  return v.name && tierNames.has(normaliseName(v.name)) ? 'tier' : category(v.type);
}

function renderVessels() {
  const tierNames = tierVesselNames();
  const seen = new Set();

  for (const v of feed.vessels) {
    seen.add(v.mmsi);
    const cat = vesselCategory(v, tierNames);
    const moving = v.sog >= 0.5;
    const rotation = v.cog ?? v.heading ?? 0;
    const size = cat === 'tier' ? 26 : moving ? 20 : 14;
    let m = markers.get(v.mmsi);
    if (!m) {
      const element = document.createElement('div');
      element.className = 'boat';
      m = new maplibregl.Marker({ element })
        .setLngLat([v.lon, v.lat])
        .setPopup(new maplibregl.Popup({ offset: 14, maxWidth: '280px' }))
        .addTo(map);
      markers.set(v.mmsi, m);
    } else {
      m.setLngLat([v.lon, v.lat]);
    }
    const element = m.getElement();
    element.innerHTML = shape({ cat, moving, rotation, size });
    element.title = titleCase(v.name) || `MMSI ${v.mmsi}`;
    element.style.zIndex = cat === 'tier' ? 3 : moving ? 2 : 1;
    m.getPopup().setHTML(popup(v, cat));
  }

  for (const [mmsi, m] of markers) {
    if (!seen.has(mmsi)) {
      m.remove();
      markers.delete(mmsi);
    }
  }

  renderVesselList(tierNames);
}

function renderVesselList(tierNames) {
  const list = el('vessels');
  const sorted = [...feed.vessels].sort((a, b) => {
    const at = vesselCategory(a, tierNames) === 'tier' ? 1 : 0;
    const bt = vesselCategory(b, tierNames) === 'tier' ? 1 : 0;
    if (at !== bt) return bt - at;
    const am = a.sog >= 0.5 ? 1 : 0;
    const bm = b.sog >= 0.5 ? 1 : 0;
    if (am !== bm) return bm - am;
    if (am) return b.sog - a.sog;
    return (a.name ?? '~').localeCompare(b.name ?? '~');
  });

  list.innerHTML = sorted
    .map((v) => {
      const cat = vesselCategory(v, tierNames);
      const moving = v.sog >= 0.5;
      return `<li><button type="button" data-mmsi="${v.mmsi}">
        ${shape({ cat, moving, rotation: v.cog ?? v.heading ?? 0, size: 16 })}
        <span><span class="name">${esc(titleCase(v.name) || 'Unnamed vessel')}</span>
          <span class="kind">${esc(CATEGORIES[category(v.type)])}</span></span>
        <span class="motion">${esc(describe(v))}</span>
      </button></li>`;
    })
    .join('');
  renderFeedStatus();
}

function renderFeedStatus() {
  const { status, vessels } = feed;
  const p = el('feed');
  if (status.state === 'disabled') {
    p.textContent =
      'Live positions are off. Add a free aisstream.io API key as AISSTREAM_API_KEY in .env, then restart the server.';
  } else if (status.error && !vessels.length) {
    p.textContent = `The AIS feed reported a problem: ${status.error}`;
  } else if (!vessels.length) {
    p.textContent =
      'Listening for boats. Moving boats report every few seconds; moored ones every few minutes, so the map fills in gradually.';
  } else {
    const n = vessels.length;
    const heard = status.lastMessageAt ? `, last report ${ago(status.lastMessageAt)}` : '';
    p.textContent = `${n} ${n === 1 ? 'boat' : 'boats'} heard in the last 30 minutes${heard}.`;
  }
}

el('vessels').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-mmsi]');
  if (!button) return;
  const m = markers.get(Number(button.dataset.mmsi));
  if (!m) return;
  const view = { center: m.getLngLat(), zoom: Math.max(map.getZoom(), 15.5) };
  reduceMotion ? map.jumpTo(view) : map.flyTo({ ...view, duration: 800 });
  if (!m.getPopup().isOpen()) m.togglePopup();
  if (matchMedia('(max-width: 800px)').matches) el('map').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
});

// ---------- live updates ----------

function renderUpdated() {
  el('updated').textContent = tier?.updatedAt ? `Ship list checked ${ago(Date.parse(tier.updatedAt))}.` : '';
}

const stream = new EventSource('/api/stream');
stream.addEventListener('tier', (e) => {
  tier = JSON.parse(e.data);
  renderTier();
  renderSchedule();
  renderVessels();
  renderUpdated();
});
stream.addEventListener('vessels', (e) => {
  feed = JSON.parse(e.data);
  renderVessels();
});

// Keep countdowns and "heard x ago" text honest between server pushes.
setInterval(() => {
  renderTier();
  renderFeedStatus();
  renderUpdated();
}, 30000);
