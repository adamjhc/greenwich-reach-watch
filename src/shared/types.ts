// Shapes the Worker sends to the browser, over SSE and the JSON endpoints.

interface Bbox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

interface Vessel {
  readonly mmsi: number;
  readonly name: string | null;
  readonly lastSeen: number;
  readonly lat: number | null;
  readonly lon: number | null;
  // Speed over ground in knots.
  readonly sog: number | null;
  // Course over ground and heading in degrees, null when unavailable.
  readonly cog: number | null;
  readonly heading: number | null;
  readonly navStatus: number | null;
  // Metres.
  readonly length: number | null;
  // AIS ship type code.
  readonly type: number | null;
  readonly callsign: string | null;
  readonly destination: string | null;
  readonly imo: number | null;
}

type PositionedVessel = Vessel & { readonly lat: number; readonly lon: number };

interface AisStatus {
  readonly state: 'disabled' | 'stopped' | 'connecting' | 'connected' | 'reconnecting';
  readonly error: string | null;
  readonly lastMessageAt: number | null;
}

interface VesselsPayload {
  readonly status: AisStatus;
  readonly viewers: number;
  readonly bbox: Bbox;
  readonly vessels: readonly PositionedVessel[];
}

interface Berth {
  readonly vessel: string;
  readonly ref: string;
  readonly flag: string;
  readonly berthedAt: string | null;
  readonly location: string;
}

interface TierEvent {
  readonly type: 'arrival' | 'departure';
  readonly vessel: string;
  readonly time: string | null;
  readonly at: string;
  readonly agent: string;
  readonly flag: string;
  // Place names where the PLA gave a UN/LOCODE, otherwise the PLA's own berth name.
  readonly from: string;
  readonly to: string;
  readonly note: string | null;
}

interface TierData {
  readonly current: readonly Berth[];
  readonly events: readonly TierEvent[];
  readonly next: TierEvent | null;
}

type TierPayload = Partial<TierData> & {
  readonly updatedAt: string | null;
  readonly error: string | null;
};

export type { AisStatus, Bbox, Berth, PositionedVessel, TierData, TierEvent, TierPayload, Vessel, VesselsPayload };
