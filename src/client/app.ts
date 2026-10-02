// Entry point: listens to the Worker's event stream and keeps the page current.

import type { AisStatus, PositionedVessel, TierPayload, VesselsPayload } from '#shared/types.ts';

import { el } from './dom.ts';
import { ago, normaliseName } from './format.ts';
import { focusVessel, renderMarkers, setUpMap } from './map.ts';
import { renderSchedule, renderTier } from './tier.ts';
import { byInterest, isStale, listItem } from './vessels.ts';

const README_LINK =
  '<a href="https://github.com/adamjhc/greenwich-reach-watch#readme" target="_blank" rel="noopener">README</a>';

interface Feed {
  readonly status: AisStatus;
  readonly vessels: readonly PositionedVessel[];
}

let tier: TierPayload | null = null;
let feed: Feed = { status: { state: 'connecting', error: null, lastMessageAt: null }, vessels: [] };
// The browser's clock minus the Worker's, as of the last vessels update.
let clockOffset = 0;

function tierVesselNames(): Set<string> {
  if (!tier) {
    return new Set();
  }
  const names = (tier.current ?? []).map((c) => c.vessel);
  if (tier.next) {
    names.push(tier.next.vessel);
  }
  return new Set(names.map((name) => normaliseName(name)));
}

// While the feed is down or catching up.
function offlineText({ status, vessels }: Feed): string {
  const n = vessels.length;
  if (status.error !== null) {
    const shown = n > 0 ? '; boats shown are where they were last heard' : '';
    return `Can't reach the live feed (${status.error}). Retrying every minute${shown}.`;
  }
  return n > 0
    ? `Reconnecting to the live feed. Until boats report in, the map shows where they were ${ago(Math.max(...vessels.map((v) => v.lastSeen)))}.`
    : 'Connecting to the live feed. Moving boats appear within seconds; moored ones report every few minutes.';
}

function onlineText({ status, vessels }: Feed): string {
  const n = vessels.length;
  if (n === 0) {
    return 'Listening for boats. Moving boats report every few seconds; moored ones every few minutes, so the map fills in gradually.';
  }
  const boats = `${n} ${n === 1 ? 'boat' : 'boats'}`;
  const stale = vessels.filter((v) => isStale(v)).length;
  if (stale > 0) {
    const which = stale === n ? 'None have' : `${stale} haven't`;
    return `${boats} on the map. ${which} reported recently and ${stale === 1 ? 'is' : 'are'} shown faded until they do.`;
  }
  const heard = status.lastMessageAt === null ? '' : `, last report ${ago(status.lastMessageAt)}`;
  return `${boats} heard in the last 30 minutes${heard}.`;
}

function feedStatusText(current: Feed): string {
  return current.status.state === 'connected' ? onlineText(current) : offlineText(current);
}

function renderFeedStatus(): void {
  const p = el('feed');
  if (feed.status.state === 'disabled') {
    p.innerHTML = `Live positions are off because the site has no aisstream.io API key. The ${README_LINK} explains how to add one.`;
  } else {
    p.textContent = feedStatusText(feed);
  }
}

function renderVessels(): void {
  const tierNames = tierVesselNames();
  renderMarkers(feed.vessels, tierNames, clockOffset);
  el('vessels').innerHTML = feed.vessels
    .toSorted(byInterest(tierNames))
    .map((v) => listItem(v, tierNames))
    .join('');
  renderFeedStatus();
}

function renderUpdated(): void {
  const updatedAt = tier?.updatedAt ?? null;
  el('updated').textContent = updatedAt === null ? '' : `Ship list checked ${ago(Date.parse(updatedAt))}.`;
}

// ---------- live updates ----------

function eventData(event: Event): unknown {
  if (!(event instanceof MessageEvent) || typeof event.data !== 'string') {
    return null;
  }
  return JSON.parse(event.data);
}

// The Worker is the only sender, so a light shape check is enough.
function isTierPayload(value: unknown): value is TierPayload {
  return typeof value === 'object' && value !== null && 'updatedAt' in value && 'error' in value;
}

function isVesselsPayload(value: unknown): value is VesselsPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'vessels' in value &&
    Array.isArray(value.vessels)
  );
}

setUpMap();

el('vessels').addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLElement>('button[data-mmsi]') : null;
  if (button) {
    focusVessel(Number(button.dataset['mmsi']));
  }
});

const stream = new EventSource('/api/stream');
stream.addEventListener('tier', (event) => {
  const data = eventData(event);
  tier = isTierPayload(data) ? data : null;
  renderTier(tier);
  renderSchedule(tier);
  renderVessels();
  renderUpdated();
});
stream.addEventListener('vessels', (event) => {
  const data = eventData(event);
  if (isVesselsPayload(data)) {
    feed = data;
    clockOffset = Date.now() - data.sentAt;
    renderVessels();
  }
});

// Keep countdowns, "heard x ago" text and faded boats honest between
// server pushes.
setInterval(() => {
  renderTier(tier);
  renderVessels();
  renderUpdated();
}, 30_000);
