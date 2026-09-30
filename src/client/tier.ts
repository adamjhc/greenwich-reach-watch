// The Greenwich Tier panel and its schedule.

import type { Berth, TierEvent, TierPayload } from '#shared/types.ts';

import { el } from './dom.ts';
import { capitalise, clock, duration, esc, normaliseName, place, shortDate, titleCase, when } from './format.ts';

// Only mention a failing refresh once the copy on screen is this old.
const OUT_OF_DATE_AFTER = 15 * 60 * 1000;

const FLAGS: Readonly<Record<string, string>> = {
  GBR: 'British',
  NOR: 'Norwegian',
  MLT: 'Maltese',
  BHS: 'Bahamian',
  PRT: 'Portuguese',
  NLD: 'Dutch',
  DEU: 'German',
  FRA: 'French',
  CHE: 'Swiss',
  BMU: 'Bermudan',
  PAN: 'Panamanian',
  LBR: 'Liberian',
  MHL: 'Marshall Islands',
  CYP: 'Cypriot',
  ITA: 'Italian',
  ESP: 'Spanish',
  DNK: 'Danish',
  DIS: 'Danish',
  GIB: 'Gibraltarian',
  IRL: 'Irish',
  BEL: 'Belgian',
  SWE: 'Swedish',
  FIN: 'Finnish',
  USA: 'American',
  ATG: 'Antiguan',
  MDR: 'Madeiran',
  NIS: 'Norwegian',
};

type TimedEvent = TierEvent & { readonly time: string };

function eventSentence(e: TierEvent): string {
  const name = `<strong>${esc(titleCase(e.vessel))}</strong>`;
  return e.type === 'departure'
    ? `${name} leaves for ${esc(place(e.to))}`
    : `${name} arrives from ${esc(place(e.from))}`;
}

function shipHtml(current: readonly Berth[]): string {
  const [ship, ...alsoMoored] = current;
  if (!ship) {
    return `<p class="state">Nothing is moored at the tier.</p>`;
  }
  const flagName = FLAGS[ship.flag];
  const flag = flagName === undefined ? `Flag ${esc(ship.flag)}` : `${flagName} flag`;
  const berthed = ship.berthedAt === null ? 'at an unknown time' : esc(when(ship.berthedAt));
  const also =
    alsoMoored.length > 0
      ? `<p class="facts">Also moored: ${alsoMoored.map((s) => esc(titleCase(s.vessel))).join(', ')}.</p>`
      : '';
  return `
      <p class="state">Moored now</p>
      <p class="ship"><span class="ship-mark">${esc(titleCase(ship.vessel))}</span></p>
      <p class="facts">${flag}, berthed ${berthed}.</p>${also}`;
}

// When the next move is by the ship already at the tier, it reads as that ship's plans.
function nextWhat(next: TimedEvent, isShip: boolean): string {
  if (!isShip) {
    return `${eventSentence(next)} ${esc(when(next.time))}.`;
  }
  return next.type === 'departure'
    ? `${esc(capitalise(when(next.time)))}, bound for ${esc(place(next.to))}.`
    : `${esc(capitalise(when(next.time)))} from ${esc(place(next.from))}.`;
}

function nextWhen(next: TimedEvent, isShip: boolean, ms: number): string {
  if (ms > 0) {
    const verb = next.type === 'departure' ? 'Leaves' : 'Arrives';
    return `${isShip ? verb : 'Next'} in ${duration(ms)}`;
  }
  const late = next.type === 'departure' ? 'Departure' : 'Arrival';
  return `${isShip ? late : 'Next move'} overdue`;
}

function nextHtml(next: TierEvent | null, ship: Berth | undefined): string {
  const time = next?.time ?? null;
  if (time === null || next === null) {
    return `<div class="next"><p class="next-when">Nothing scheduled</p><p class="facts">No ${
      ship ? 'departure' : 'arrival'
    } is in the PLA forecast yet. Moves usually appear a few days ahead.</p></div>`;
  }
  const timed = { ...next, time };
  const ms = Date.parse(timed.time) - Date.now();
  const isShip = ship !== undefined && normaliseName(next.vessel) === normaliseName(ship.vessel);
  const overdue =
    ms <= 0
      ? `<p class="overdue">Scheduled ${duration(ms)} ago. The PLA list updates once the pilot logs the move.</p>`
      : '';
  return `<div class="next"><p class="next-when">${nextWhen(timed, isShip, ms)}</p><p class="next-what">${nextWhat(timed, isShip)}</p>${overdue}</div>`;
}

// A single refused refresh is retried within a minute, so only mention it
// once the copy on screen is getting old.
function outOfDateHtml({ error, updatedAt }: TierPayload): string {
  if (error === null || updatedAt === null || Date.now() - Date.parse(updatedAt) <= OUT_OF_DATE_AFTER) {
    return '';
  }
  return `<p class="error">The Port of London ship list hasn't responded since ${esc(
    when(updatedAt),
  )}, so this may be out of date. It's retried every minute while the page is open.</p>`;
}

function renderTier(tier: TierPayload | null): void {
  const body = el('tier-body');
  if (tier === null || (tier.current === undefined && tier.error !== null)) {
    const error = tier?.error ?? null;
    const reason = error === null ? '' : `: ${esc(error)}`;
    body.innerHTML = `<p class="error">Couldn't reach the Port of London ship list${reason}. Trying again in 5 minutes.</p>`;
    return;
  }
  const current = tier.current ?? [];
  const [ship] = current;
  body.innerHTML = shipHtml(current) + nextHtml(tier.next ?? null, ship) + outOfDateHtml(tier);
}

function scheduleItem(e: TierEvent, now: number): string {
  const time = e.time === null ? null : new Date(e.time);
  const note =
    e.note === null ? '' : `<br><span class="quiet">${esc(e.note.replace(/\bReqd\.?/iv, 'required'))}</span>`;
  const past = time !== null && time.getTime() < now;
  const label = time === null ? 'Time not set' : `${esc(shortDate(time))}<br>${clock(time)}`;
  return `
      <li class="${past ? 'past' : ''}">
        <time datetime="${esc(e.time)}">${label}</time>
        <span>${eventSentence(e)}${note}</span>
      </li>`;
}

function renderSchedule(tier: TierPayload | null): void {
  const list = el('schedule');
  const events = tier?.events ?? [];
  if (events.length === 0) {
    list.innerHTML = `<li><span></span><span class="quiet">No movements to or from the tier are scheduled.</span></li>`;
    return;
  }
  const now = Date.now();
  list.innerHTML = events.map((e) => scheduleItem(e, now)).join('');
}

export { renderSchedule, renderTier };
