// How each boat is classified, drawn and described.

import type { Vessel } from '#shared/types.ts';

import { ago, esc, normaliseName, titleCase } from './format.ts';

const CATEGORY_KEYS = ['passenger', 'cargo', 'work', 'leisure', 'other'] as const;
type Category = (typeof CATEGORY_KEYS)[number];
type MarkerKind = Category | 'tier';

const CATEGORIES: Readonly<Record<Category, string>> = {
  passenger: 'Passenger boats and cruise ships',
  cargo: 'Cargo and tankers',
  work: 'Tugs and workboats',
  leisure: 'Sailing and leisure',
  other: 'Other or unknown',
};

const NAV_STATUS: Readonly<Record<number, string>> = {
  0: 'Under way',
  1: 'At anchor',
  2: 'Not under command',
  3: 'Restricted manoeuvrability',
  5: 'Moored',
  6: 'Aground',
  7: 'Fishing',
  8: 'Under sail',
};

// Slower than this counts as stationary.
const MOVING_KNOTS = 0.5;
// Moving boats report every few seconds and moored ones every 3–6 minutes,
// so anything quieter than this is showing an old position.
const STALE_MOVING = 2 * 60 * 1000;
const STALE_STILL = 10 * 60 * 1000;

function category(type: number | null): Category {
  if (type === null) {
    return 'other';
  }
  if (type >= 60 && type <= 69) {
    return 'passenger';
  }
  if (type >= 70 && type <= 89) {
    return 'cargo';
  }
  if ([31, 32, 33, 34, 35].includes(type) || (type >= 50 && type <= 59)) {
    return 'work';
  }
  return type === 36 || type === 37 ? 'leisure' : 'other';
}

function vesselCategory(v: Vessel, tierNames: ReadonlySet<string>): MarkerKind {
  return v.name !== null && tierNames.has(normaliseName(v.name)) ? 'tier' : category(v.type);
}

function isMoving(v: Vessel): boolean {
  return (v.sog ?? 0) >= MOVING_KNOTS;
}

function isStale(v: Vessel): boolean {
  return Date.now() - v.lastSeen > (isMoving(v) ? STALE_MOVING : STALE_STILL);
}

// Degrees clockwise from north, for pointing the arrow.
function rotation(v: Vessel): number {
  return v.cog ?? v.heading ?? 0;
}

function describe(v: Vessel): string {
  if (isStale(v)) {
    return `Last heard ${ago(v.lastSeen)}`;
  }
  if (v.sog !== null && isMoving(v)) {
    return `${v.sog.toFixed(1)} knots`;
  }
  return v.navStatus !== null && NAV_STATUS[v.navStatus] === 'Moored' ? 'Moored' : 'Stationary';
}

function motion(v: Vessel): string {
  if (v.sog === null || !isMoving(v)) {
    return describe(v);
  }
  const course = v.cog ?? v.heading;
  return `${v.sog.toFixed(1)} knots${course === null ? '' : `, heading ${Math.round(course)}°`}`;
}

function vesselName(v: Vessel): string {
  return titleCase(v.name) || 'Unnamed vessel';
}

function popup(v: Vessel, kind: MarkerKind): string {
  const rows = [
    CATEGORIES[kind === 'tier' ? category(v.type) : kind],
    motion(v),
    v.destination === null ? null : `Destination: ${esc(titleCase(v.destination))}`,
    v.length === null ? null : `${v.length} m long`,
    `MMSI ${v.mmsi}, heard ${ago(v.lastSeen)}`,
  ].filter((row) => row !== null);
  return `<span class="name">${esc(vesselName(v))}</span>${rows.join('<br>')}`;
}

interface ShapeOptions {
  readonly kind: MarkerKind;
  readonly moving: boolean;
  readonly degrees?: number;
  readonly size?: number;
}

function shape({ kind, moving, degrees = 0, size = 18 }: ShapeOptions): string {
  const fill = kind === 'tier' ? 'var(--signal)' : `var(--cat-${kind})`;
  const stroke = kind === 'tier' ? 'var(--signal-ink)' : 'var(--paper)';
  if (moving) {
    return `<svg class="swatch" width="${size}" height="${size}" viewBox="-10 -10 20 20" aria-hidden="true">
      <path d="M0 -9 L6 7 L0 4 L-6 7 Z" style="fill:${fill};stroke:${stroke}" stroke-width="1.5"
        stroke-linejoin="round" transform="rotate(${degrees})"/></svg>`;
  }
  return `<svg class="swatch" width="${size}" height="${size}" viewBox="-10 -10 20 20" aria-hidden="true">
    <circle r="6.5" style="fill:${fill};stroke:${stroke}" stroke-width="1.5"/></svg>`;
}

function legend(): string {
  const rows = CATEGORY_KEYS.map(
    (key) => `<div>${shape({ kind: key, moving: false, size: 12 })}${CATEGORIES[key]}</div>`,
  );
  const tier = `<div>${shape({ kind: 'tier', moving: false, size: 12 })}At or due at the tier</div>`;
  return `<summary>Key</summary>${rows.join('')}${tier}`;
}

function listItem(v: Vessel, tierNames: ReadonlySet<string>): string {
  const kind = vesselCategory(v, tierNames);
  return `<li><button type="button" data-mmsi="${v.mmsi}"${isStale(v) ? ' class="stale"' : ''}>
        ${shape({ kind, moving: isMoving(v), degrees: rotation(v), size: 16 })}
        <span><span class="name">${esc(vesselName(v))}</span>
          <span class="kind">${esc(CATEGORIES[category(v.type)])}</span></span>
        <span class="motion">${esc(describe(v))}</span>
      </button></li>`;
}

function movingRank(v: Vessel): number {
  return isMoving(v) ? 1 : 0;
}

// Ships at the tier first, then moving boats fastest first, then the rest by name.
function byInterest(tierNames: ReadonlySet<string>): (a: Vessel, b: Vessel) => number {
  function tierRank(v: Vessel): number {
    return vesselCategory(v, tierNames) === 'tier' ? 1 : 0;
  }
  return (a, b) =>
    tierRank(b) - tierRank(a) ||
    movingRank(b) - movingRank(a) ||
    (movingRank(a) === 1 ? (b.sog ?? 0) - (a.sog ?? 0) : (a.name ?? '~').localeCompare(b.name ?? '~'));
}

export { byInterest, isMoving, isStale, legend, listItem, popup, rotation, shape, vesselCategory };
export type { MarkerKind };
