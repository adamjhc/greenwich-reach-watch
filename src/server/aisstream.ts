// The parts of aisstream.io's messages this Worker reads, and how each one
// updates what we know about a vessel. See https://aisstream.io/documentation

import type { Vessel } from '#shared/types.ts';

interface Dimension {
  readonly A?: number;
  readonly B?: number;
}

interface PositionBody {
  readonly Valid?: boolean;
  readonly Latitude: number;
  readonly Longitude: number;
  readonly Sog: number;
  readonly Cog: number;
  readonly TrueHeading: number;
  readonly NavigationalStatus?: number;
}

interface ExtendedClassBBody extends PositionBody {
  readonly Name?: string;
  readonly Type?: number;
  readonly Dimension?: Dimension;
}

interface ShipStaticBody {
  readonly Name?: string;
  readonly Type?: number;
  readonly CallSign?: string;
  readonly Destination?: string;
  readonly ImoNumber?: number;
  readonly Dimension?: Dimension;
}

interface StaticDataReportBody {
  readonly ReportA?: { readonly Valid: boolean; readonly Name?: string };
  readonly ReportB?: {
    readonly Valid: boolean;
    readonly ShipType?: number;
    readonly CallSign?: string;
    readonly Dimension?: Dimension;
  };
}

interface AisBodies {
  readonly PositionReport?: PositionBody;
  readonly StandardClassBPositionReport?: PositionBody;
  readonly ExtendedClassBPositionReport?: ExtendedClassBBody;
  readonly ShipStaticData?: ShipStaticBody;
  readonly StaticDataReport?: StaticDataReportBody;
}

type MessageType = keyof AisBodies;

interface AisMessage {
  readonly MessageType: MessageType;
  readonly MetaData?: {
    readonly MMSI?: number;
    readonly ShipName?: string;
    readonly latitude?: number;
    readonly longitude?: number;
  };
  readonly Message?: AisBodies;
}

interface AisError {
  readonly error: string;
}

// Facts that only ever fill in or replace what we know; null means "not in
// this message", so the previous value stays.
type StaticFacts = Partial<Pick<Vessel, 'name' | 'type' | 'callsign' | 'destination' | 'imo' | 'length'>>;

// Storage from older versions of this Worker left out fields it hadn't seen.
type SavedVessel = Partial<Vessel> & Pick<Vessel, 'mmsi' | 'lastSeen'>;

const MESSAGE_TYPES: readonly MessageType[] = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];
const KNOWN_TYPES = new Set<string>(MESSAGE_TYPES);

// AIS pads text fields with @.
function clean(s: string | undefined): string | null {
  const trimmed = s?.replace(/@+$/v, '').trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

// AIS uses 0 for "not available" in ship type and IMO number.
function known(value: number | undefined): number | null {
  return value === undefined || value === 0 ? null : value;
}

function lengthOf(d: Dimension | undefined): number | null {
  const length = (d?.A ?? 0) + (d?.B ?? 0);
  return length > 0 ? length : null;
}

function blankVessel(mmsi: number): Vessel {
  return {
    mmsi,
    name: null,
    lastSeen: 0,
    fixedAt: null,
    lat: null,
    lon: null,
    sog: null,
    cog: null,
    heading: null,
    navStatus: null,
    length: null,
    type: null,
    callsign: null,
    destination: null,
    imo: null,
  };
}

// Field by field, since older saves hold explicit undefineds that a spread would copy.
function revive(saved: SavedVessel): Vessel {
  return {
    mmsi: saved.mmsi,
    name: saved.name ?? null,
    lastSeen: saved.lastSeen,
    fixedAt: saved.fixedAt ?? null,
    lat: saved.lat ?? null,
    lon: saved.lon ?? null,
    sog: saved.sog ?? null,
    cog: saved.cog ?? null,
    heading: saved.heading ?? null,
    navStatus: saved.navStatus ?? null,
    length: saved.length ?? null,
    type: saved.type ?? null,
    callsign: saved.callsign ?? null,
    destination: saved.destination ?? null,
    imo: saved.imo ?? null,
  };
}

function withPosition(v: Vessel, p: PositionBody, now: number): Vessel {
  if (p.Valid === false) {
    return v;
  }
  return {
    ...v,
    fixedAt: now,
    lat: p.Latitude,
    lon: p.Longitude,
    sog: p.Sog,
    cog: p.Cog === 360 ? null : p.Cog,
    heading: p.TrueHeading === 511 ? null : p.TrueHeading,
    navStatus: p.NavigationalStatus ?? v.navStatus,
  };
}

function withFacts(v: Vessel, facts: StaticFacts): Vessel {
  return {
    ...v,
    name: facts.name ?? v.name,
    type: facts.type ?? v.type,
    callsign: facts.callsign ?? v.callsign,
    destination: facts.destination ?? v.destination,
    imo: facts.imo ?? v.imo,
    length: facts.length ?? v.length,
  };
}

function reportFacts({ ReportA: a, ReportB: b }: StaticDataReportBody): StaticFacts {
  return {
    ...(a?.Valid === true ? { name: clean(a.Name) } : {}),
    ...(b?.Valid === true
      ? { type: known(b.ShipType), callsign: clean(b.CallSign), length: lengthOf(b.Dimension) }
      : {}),
  };
}

function factsOf({
  ExtendedClassBPositionReport: extended,
  ShipStaticData: ship,
  StaticDataReport: report,
}: AisBodies): StaticFacts {
  if (extended) {
    return { name: clean(extended.Name), type: known(extended.Type), length: lengthOf(extended.Dimension) };
  }
  if (ship) {
    return {
      name: clean(ship.Name),
      type: known(ship.Type),
      callsign: clean(ship.CallSign),
      destination: clean(ship.Destination),
      imo: known(ship.ImoNumber),
      length: lengthOf(ship.Dimension),
    };
  }
  return report ? reportFacts(report) : {};
}

// The vessel after this message, or null if the message isn't about one.
function applyMessage(vessels: ReadonlyMap<number, Vessel>, msg: AisMessage, now: number): Vessel | null {
  const { MetaData: meta, Message: bodies } = msg;
  if (meta?.MMSI === undefined || meta.MMSI === 0 || bodies?.[msg.MessageType] === undefined) {
    return null;
  }
  const previous = vessels.get(meta.MMSI) ?? blankVessel(meta.MMSI);
  const heard = { ...previous, name: previous.name ?? clean(meta.ShipName), lastSeen: now };
  const position = bodies.PositionReport ?? bodies.StandardClassBPositionReport ?? bodies.ExtendedClassBPositionReport;
  const updated = withFacts(position ? withPosition(heard, position, now) : heard, factsOf(bodies));

  // Static data can arrive before we have a position; keep the vessel
  // around but clients only draw ones with coordinates.
  if (updated.lat === null && meta.latitude !== undefined && meta.latitude !== 0) {
    return { ...updated, lat: meta.latitude, lon: meta.longitude ?? null };
  }
  return updated;
}

function isAisMessage(value: object): value is AisMessage {
  return 'MessageType' in value && typeof value.MessageType === 'string' && KNOWN_TYPES.has(value.MessageType);
}

function frameText(data: unknown): string | null {
  if (typeof data === 'string') {
    return data;
  }
  return data instanceof ArrayBuffer ? new TextDecoder().decode(data) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// One WebSocket frame from aisstream: a message, an error, or something to ignore.
async function parseFrame(data: unknown): Promise<AisMessage | AisError | null> {
  // The service sends binary frames, which workerd delivers as Blobs even
  // though the Workers types don't say so.
  const text = data instanceof Blob ? await data.text() : frameText(data);
  const value = text === null ? null : parseJson(text);
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  if ('error' in value && typeof value.error === 'string' && value.error !== '') {
    return { error: value.error };
  }
  return isAisMessage(value) ? value : null;
}

export { applyMessage, MESSAGE_TYPES, parseFrame, revive };
export type { AisMessage, SavedVessel };
