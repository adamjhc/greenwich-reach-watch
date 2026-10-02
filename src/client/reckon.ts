// Dead reckoning: where each boat probably is between AIS reports. Moving
// boats carry on at their last reported speed, following the bends of the
// Thames rather than sailing straight into the bank, and glide instead of
// jumping when a new report puts them somewhere slightly different.

import type { PositionedVessel } from '#shared/types.ts';

import { reduceMotion } from './dom.ts';
import { isMoving, rotation } from './vessels.ts';
import type { LngLat, RiverPosition, XY } from './waterway.ts';
import {
  bearingOf,
  clamp,
  dot,
  heading,
  leftOf,
  minus,
  plus,
  project,
  riverPoint,
  toLngLat,
  toXY,
} from './waterway.ts';

// Metres per second in a knot.
const KNOT = 1852 / 3600;
// Stop guessing after this long without a report. Class B boats report
// every 30 seconds when moving, so this covers one missed report.
const MAX_RECKON = 60 * 1000;
// Over the last this-many seconds of that, the boat slows to a stop.
const SLOW_DOWN = 10;
// How long a boat takes to glide to where a new report puts it.
const GLIDE = 4000;
// A boat drawn ahead of its report glides for longer, up to this, so it slows
// down for the report to catch up rather than going backwards.
const MAX_GLIDE = 15_000;
// The fastest a glide pulls a boat back, as a share of its speed.
const MAX_SLOWDOWN = 0.8;
// The fastest a glide closes a gap, in metres per second (about 8 knots), so
// big corrections take longer rather than whipping the boat round.
const MAX_CORRECTION = 4;
// Below this many metres per second (about 3 knots), the way a boat is drawn
// moving says less, as it is mostly small corrections to its position, so
// its arrow leans back towards its reported course.
const STEADY_SPEED = 1.5;
// Milliseconds between the two positions used to work out a boat's drawn speed.
const SAMPLE = 100;
// A boat this far from where it was drawn jumps there instead.
const MAX_GLIDE_METRES = 500;
// Further than this from the middle of the river is a dock or creek, where
// following the river would be wrong, so those boats stay where they report.
const OFF_RIVER = 250;
// Roughly half the river's width around Greenwich. Boats crossing the river
// ease to a stop short of here rather than running aground.
const HALF_WIDTH = 130;
// A boat's speed across the river fades away over about this many seconds,
// or sooner if it would otherwise reach HALF_WIDTH.
const SETTLE = 20;

interface Placement {
  readonly lngLat: LngLat;
  // Clockwise from north, for pointing the arrow.
  readonly degrees: number;
}

interface Point {
  readonly position: XY;
  readonly degrees: number;
}

// A point as drawn, with how fast it is moving in metres per second.
interface Drawn extends Point {
  readonly velocity: XY;
}

interface Reckoning extends RiverPosition {
  // Metres per second downstream.
  readonly downstream: number;
  // How far the boat drifts towards the left bank in all, and over about how
  // many seconds.
  readonly sideways: number;
  readonly settle: number;
  // The gap between the reported position and where the river model puts it.
  readonly offset: XY;
  // Which way the river runs at the reported position.
  readonly flow: number;
}

interface Fix extends Point {
  // The Worker's clock, to tell a new report from one already seen.
  readonly fixedAt: number | null;
  // The browser's clock.
  readonly at: number;
  // Metres per second, or 0 for a boat that isn't moving.
  readonly speed: number;
  // Null for boats that stay where they were reported.
  readonly reckoning: Reckoning | null;
}

// The gap between where a boat was drawn and where a new report puts it,
// which closes over the glide's duration. The boat sets off at the velocity
// it was drawn moving at, so its path bends rather than kinks.
interface Glide {
  readonly from: number;
  readonly duration: number;
  readonly gap: XY;
  // The drawn velocity minus the new report's, in metres per second.
  readonly drift: XY;
  readonly turn: number;
}

interface Track {
  readonly fix: Fix;
  readonly glide: Glide | null;
}

const tracks = new Map<number, Track>();

// The shortest turn from one bearing to another, -180 to 180.
function turnBetween(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function canReckon(v: PositionedVessel): boolean {
  return !reduceMotion && v.fixedAt !== null && v.sog !== null && (v.cog ?? v.heading) !== null && isMoving(v);
}

// Starting at the reported speed across the river, slowing so the boat
// never gets further from the middle than HALF_WIDTH (or where it is now).
function drift(across: number, leftward: number): Pick<Reckoning, 'sideways' | 'settle'> {
  const limit = Math.max(Math.abs(across), HALF_WIDTH);
  const room = (leftward < 0 ? -limit : limit) - across;
  const sideways = Math.abs(leftward * SETTLE) > Math.abs(room) ? room : leftward * SETTLE;
  return { sideways, settle: leftward === 0 ? SETTLE : sideways / leftward };
}

function reckon(v: PositionedVessel, position: XY): Reckoning | null {
  const here = project(position);
  if (!canReckon(v) || here.distance > OFF_RIVER) {
    return null;
  }
  const modelled = riverPoint(here);
  const velocity = heading(rotation(v), (v.sog ?? 0) * KNOT);
  return {
    along: here.along,
    across: here.across,
    downstream: dot(velocity, modelled.downstream),
    ...drift(here.across, dot(velocity, leftOf(modelled.downstream))),
    offset: minus(position, modelled.position),
    flow: bearingOf(modelled.downstream),
  };
}

// How many seconds' worth of travel at the reported speed, slowing to a stop
// rather than halting at MAX_RECKON.
function travelTime(at: number, now: number): number {
  const seconds = clamp(now - at, 0, MAX_RECKON) / 1000;
  const slowing = Math.max(seconds - (MAX_RECKON / 1000 - SLOW_DOWN), 0);
  return seconds - (slowing * slowing) / (2 * SLOW_DOWN);
}

function predict({ at, position, degrees, reckoning: r }: Fix, now: number): Point {
  if (!r) {
    return { position, degrees };
  }
  const seconds = travelTime(at, now);
  const ahead = riverPoint({
    along: r.along + r.downstream * seconds,
    across: r.settle === 0 ? r.across : r.across + r.sideways * (1 - Math.exp(-seconds / r.settle)),
  });
  return {
    position: plus(ahead.position, r.offset),
    // Turn with the river.
    degrees: degrees + turnBetween(r.flow, bearingOf(ahead.downstream)),
  };
}

// How much of the gap is left: eases from 1 to 0 with no sudden change of speed at either end.
function remaining(glide: Glide, now: number): number {
  const t = clamp((now - glide.from) / glide.duration, 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

// The glide's offset from the predicted position, and its share of the drawn
// velocity. A cubic Hermite curve: it starts at the gap and drift and ends at
// nothing, without sudden changes in speed or direction.
function correction(glide: Glide, now: number): { readonly offset: XY; readonly velocity: XY } {
  const t = clamp((now - glide.from) / glide.duration, 0, 1);
  const seconds = glide.duration / 1000;
  const driftLeft = seconds * t * (1 - t) * (1 - t);
  return {
    offset: plus(plus([0, 0], glide.gap, remaining(glide, now)), glide.drift, driftLeft),
    velocity: plus(plus([0, 0], glide.gap, (6 * t * (t - 1)) / seconds), glide.drift, (1 - t) * (1 - 3 * t)),
  };
}

// Points the arrow the way the boat is drawn moving, so it never seems to
// slide sideways, easing back to its course as it slows to a stop.
function arrow(course: number, velocity: XY): number {
  const weight = clamp(Math.hypot(...velocity) / STEADY_SPEED, 0, 1);
  return weight === 0 ? course : course + turnBetween(course, bearingOf(velocity)) * weight;
}

function pointAt({ fix, glide }: Track, now: number): Drawn {
  const predicted = predict(fix, now);
  // Looking ahead, since looking back from a fresh report would reach before it.
  const sailing = plus([0, 0], minus(predict(fix, now + SAMPLE).position, predicted.position), 1000 / SAMPLE);
  if (!glide) {
    return { position: predicted.position, velocity: sailing, degrees: arrow(predicted.degrees, sailing) };
  }
  const { offset, velocity } = correction(glide, now);
  const moving = plus(sailing, velocity);
  return {
    position: plus(predicted.position, offset),
    velocity: moving,
    // The turn starts from the way the arrow pointed before the report, so it turns rather than snaps.
    degrees: arrow(predicted.degrees, moving) + glide.turn * remaining(glide, now),
  };
}

// Long enough that the gap never closes faster than MAX_CORRECTION, and a gap
// ahead of the boat never pulls it back faster than MAX_SLOWDOWN of its speed.
// The ease peaks at 1.5 times the average rate.
function glideDuration(gap: XY, to: Point, speed: number): number {
  const ahead = dot(gap, heading(to.degrees));
  const toClose = (1.5 * Math.hypot(...gap) * 1000) / MAX_CORRECTION;
  const toSlow = ahead <= 0 || speed === 0 ? 0 : (1.5 * ahead * 1000) / (speed * MAX_SLOWDOWN);
  return clamp(Math.max(toClose, toSlow), GLIDE, MAX_GLIDE);
}

function glideFrom(drawn: Drawn | null, fix: Fix, now: number): Glide | null {
  if (!drawn || reduceMotion) {
    return null;
  }
  const to = pointAt({ fix, glide: null }, now);
  const gap = minus(drawn.position, to.position);
  if (Math.hypot(...gap) > MAX_GLIDE_METRES) {
    return null;
  }
  const glide = {
    from: now,
    duration: glideDuration(gap, to, fix.speed),
    gap,
    drift: minus(drawn.velocity, to.velocity),
    turn: 0,
  };
  const { degrees } = pointAt({ fix, glide }, now);
  return { ...glide, turn: turnBetween(degrees, drawn.degrees) };
}

// Takes in a boat's latest report. clockOffset is the browser's clock minus
// the Worker's, so the report's age is right even if the two disagree.
function track(v: PositionedVessel, clockOffset: number, now: number): void {
  const current = tracks.get(v.mmsi);
  if (current?.fix.fixedAt === v.fixedAt) {
    return;
  }
  const position = toXY(v.lon, v.lat);
  const fix: Fix = {
    fixedAt: v.fixedAt,
    at: v.fixedAt === null ? now : v.fixedAt + clockOffset,
    speed: isMoving(v) ? (v.sog ?? 0) * KNOT : 0,
    position,
    degrees: rotation(v),
    reckoning: reckon(v, position),
  };
  const drawn = current ? pointAt(current, now) : null;
  tracks.set(v.mmsi, { fix, glide: glideFrom(drawn, fix, now) });
}

function untrack(mmsi: number): void {
  tracks.delete(mmsi);
}

function toPlacement({ position, degrees }: Point): Placement {
  return { lngLat: toLngLat(position), degrees };
}

function placement(mmsi: number, now: number): Placement | null {
  const current = tracks.get(mmsi);
  return current ? toPlacement(pointAt(current, now)) : null;
}

function isActive({ fix, glide }: Track, now: number): boolean {
  return (glide !== null && now - glide.from < glide.duration) || (fix.reckoning !== null && now - fix.at < MAX_RECKON);
}

// Where to draw every boat that is still moving or gliding.
function inMotion(now: number): Map<number, Placement> {
  const placed = new Map<number, Placement>();
  for (const [mmsi, t] of tracks) {
    if (isActive(t, now)) {
      placed.set(mmsi, toPlacement(pointAt(t, now)));
    }
  }
  return placed;
}

export { inMotion, placement, track, untrack };
export type { Placement };
