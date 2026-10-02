// The Thames as a line boats can follow. Positions are flattened to metres
// east and north of a point near the tier, which is accurate to well under
// a metre across a few kilometres of river.

import { THAMES } from './thames.ts';

// Metres east and north.
type XY = readonly [x: number, y: number];

interface LngLat {
  readonly lng: number;
  readonly lat: number;
}

// Metres downstream along the middle of the river, and metres from it
// towards the left bank (looking downstream).
interface RiverPosition {
  readonly along: number;
  readonly across: number;
}

interface Segment {
  readonly start: XY;
  readonly end: XY;
  // Distance downstream to the start of this segment.
  readonly from: number;
  readonly length: number;
  // Unit vector downstream.
  readonly direction: XY;
  // Unit vectors towards the left bank at each end, averaged with the
  // neighbouring segments so offsets bend smoothly round corners.
  readonly startNormal: XY;
  readonly endNormal: XY;
}

const LAT0 = 51.49;
const LON0 = -0.02;
const METRES_PER_LAT = 110_574;
const METRES_PER_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

function toXY(lon: number, lat: number): XY {
  return [(lon - LON0) * METRES_PER_LON, (lat - LAT0) * METRES_PER_LAT];
}

function toLngLat([x, y]: XY): LngLat {
  return { lng: LON0 + x / METRES_PER_LON, lat: LAT0 + y / METRES_PER_LAT };
}

function plus([ax, ay]: XY, [bx, by]: XY, scale = 1): XY {
  return [ax + bx * scale, ay + by * scale];
}

function minus(a: XY, b: XY): XY {
  return plus(a, b, -1);
}

function dot([ax, ay]: XY, [bx, by]: XY): number {
  return ax * bx + ay * by;
}

function unit(v: XY): XY {
  const length = Math.hypot(...v);
  return length === 0 ? [0, 0] : [v[0] / length, v[1] / length];
}

function leftOf([x, y]: XY): XY {
  return [-y, x];
}

// Degrees clockwise from north.
function bearingOf([x, y]: XY): number {
  return (Math.atan2(x, y) * 180) / Math.PI;
}

function heading(degrees: number, length = 1): XY {
  const radians = (degrees * Math.PI) / 180;
  return [length * Math.sin(radians), length * Math.cos(radians)];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function buildRiver(): Segment[] {
  const points = THAMES.map(([lon, lat]) => toXY(lon, lat));
  const pieces = points.slice(1).map((end, i) => {
    const start = points[i] ?? end;
    return { start, end, length: Math.hypot(...minus(end, start)), direction: unit(minus(end, start)) };
  });
  let from = 0;
  return pieces.map((piece, i): Segment => {
    const before = pieces[i - 1]?.direction ?? piece.direction;
    const after = pieces[i + 1]?.direction ?? piece.direction;
    const segment = {
      start: piece.start,
      end: piece.end,
      length: piece.length,
      direction: piece.direction,
      from,
      startNormal: leftOf(unit(plus(before, piece.direction))),
      endNormal: leftOf(unit(plus(piece.direction, after))),
    };
    from += piece.length;
    return segment;
  });
}

const river = buildRiver();
const riverLength = river.reduce((total, s) => total + s.length, 0);

function nearestOn({ start, from, length, direction }: Segment, p: XY): RiverPosition & { readonly distance: number } {
  const w = minus(p, start);
  const t = clamp(dot(w, direction), 0, length);
  const distance = Math.hypot(...minus(w, plus([0, 0], direction, t)));
  return { along: from + t, across: dot(w, leftOf(direction)) < 0 ? -distance : distance, distance };
}

// Where a point is in river terms, and how far it is from the middle.
function project(p: XY): RiverPosition & { readonly distance: number } {
  let best = { along: 0, across: 0, distance: Infinity };
  for (const segment of river) {
    const candidate = nearestOn(segment, p);
    if (candidate.distance < best.distance) {
      best = candidate;
    }
  }
  return best;
}

// The point at a river position, and the unit vector downstream there.
function riverPoint({ along, across }: RiverPosition): { readonly position: XY; readonly downstream: XY } {
  const at = clamp(along, 0, riverLength);
  const segment = river.find((s) => at <= s.from + s.length) ?? river.at(-1);
  if (!segment) {
    return { position: [0, 0], downstream: [0, 1] };
  }
  const { start, end, from, length, startNormal, endNormal } = segment;
  const f = length === 0 ? 0 : clamp((at - from) / length, 0, 1);
  const normal = unit(plus(startNormal, minus(endNormal, startNormal), f));
  const middle = plus(start, minus(end, start), f);
  // The normal turned back a quarter, so the direction follows the bend smoothly too.
  return { position: plus(middle, normal, across), downstream: [normal[1], -normal[0]] };
}

export { bearingOf, clamp, dot, heading, leftOf, minus, plus, project, riverPoint, toLngLat, toXY };
export type { LngLat, RiverPosition, XY };
