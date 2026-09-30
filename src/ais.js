// Live vessel positions from aisstream.io (free, needs an API key). Their
// WebSocket refuses browser connections, so the Durable Object holds the
// socket and keeps an in-memory picture of every vessel inside the box.

const STREAM_URL = 'https://stream.aisstream.io/v0/stream';
export const STALE_AFTER = 30 * 60 * 1000; // drop vessels not heard from in 30 min
const QUIET_AFTER = 10 * 60 * 1000; // treat a silent stream as dead

const MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];

const clean = (s) => (typeof s === 'string' ? s.replace(/@+$/, '').trim() || null : null);

export function createAis({ apiKey, bbox, onChange }) {
  const vessels = new Map();
  const status = { state: apiKey ? 'stopped' : 'disabled', error: null, lastMessageAt: null };
  let socket = null;
  let lastActivity = 0;

  if (!apiKey) status.error = 'AISSTREAM_API_KEY is not set';

  // Status changes are pushed to viewers like vessel updates, so the page
  // can say when the feed is connecting or catching up.
  function setStatus(changes) {
    for (const [key, value] of Object.entries(changes)) {
      if (status[key] === value) continue;
      status[key] = value;
      onChange?.();
    }
  }

  function vessel(mmsi) {
    if (!vessels.has(mmsi)) vessels.set(mmsi, { mmsi });
    return vessels.get(mmsi);
  }

  function applyPosition(v, p) {
    if (!p.Valid && p.Valid !== undefined) return;
    v.lat = p.Latitude;
    v.lon = p.Longitude;
    v.sog = p.Sog;
    v.cog = p.Cog === 360 ? null : p.Cog;
    v.heading = p.TrueHeading === 511 ? null : p.TrueHeading;
    if (p.NavigationalStatus !== undefined) v.navStatus = p.NavigationalStatus;
  }

  function applyDimension(v, d) {
    if (!d) return;
    const length = (d.A ?? 0) + (d.B ?? 0);
    if (length > 0) v.length = length;
  }

  function handle(msg) {
    const meta = msg.MetaData ?? {};
    const body = msg.Message?.[msg.MessageType];
    if (!meta.MMSI || !body) return;

    const v = vessel(meta.MMSI);
    v.name = v.name ?? clean(meta.ShipName);
    v.lastSeen = Date.now();

    switch (msg.MessageType) {
      case 'PositionReport':
      case 'StandardClassBPositionReport':
        applyPosition(v, body);
        break;
      case 'ExtendedClassBPositionReport':
        applyPosition(v, body);
        v.name = clean(body.Name) ?? v.name;
        v.type = body.Type || v.type;
        applyDimension(v, body.Dimension);
        break;
      case 'ShipStaticData':
        v.name = clean(body.Name) ?? v.name;
        v.type = body.Type || v.type;
        v.callsign = clean(body.CallSign) ?? v.callsign;
        v.destination = clean(body.Destination) ?? v.destination;
        v.imo = body.ImoNumber || v.imo;
        applyDimension(v, body.Dimension);
        break;
      case 'StaticDataReport':
        if (body.ReportA?.Valid) v.name = clean(body.ReportA.Name) ?? v.name;
        if (body.ReportB?.Valid) {
          v.type = body.ReportB.ShipType || v.type;
          v.callsign = clean(body.ReportB.CallSign) ?? v.callsign;
          applyDimension(v, body.ReportB.Dimension);
        }
        break;
    }

    // Static data can arrive before we have a position; keep the vessel
    // around but clients only draw ones with coordinates.
    if (meta.latitude && v.lat === undefined) {
      v.lat = meta.latitude;
      v.lon = meta.longitude;
    }
    onChange?.();
  }

  async function connect() {
    setStatus({ state: 'connecting' });
    let received = false;
    try {
      // Workers open outbound WebSockets with an Upgrade fetch.
      const res = await fetch(STREAM_URL, { headers: { Upgrade: 'websocket' } });
      if (!res.webSocket) throw new Error(`aisstream refused the connection (HTTP ${res.status})`);
      socket = res.webSocket;
      socket.accept();
    } catch (err) {
      setStatus({ state: 'reconnecting', error: err.message });
      return;
    }

    const ws = socket;
    ws.send(
      JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [[[bbox.south, bbox.west], [bbox.north, bbox.east]]],
        FilterMessageTypes: MESSAGE_TYPES,
      }),
    );
    setStatus({ state: 'connected' });
    lastActivity = Date.now();

    ws.addEventListener('message', async (event) => {
      const { data } = event;
      const raw =
        typeof data === 'string'
          ? data
          : data instanceof Blob
            ? await data.text()
            : new TextDecoder().decode(new Uint8Array(data));
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      received = true;
      status.lastMessageAt = lastActivity = Date.now();
      if (msg.error) {
        setStatus({ error: msg.error });
        return;
      }
      setStatus({ error: null });
      handle(msg);
    });

    ws.addEventListener('close', (event) => {
      if (socket !== ws) return;
      socket = null;
      // aisstream drops the socket without a reason when the key is bad.
      if (!received) {
        setStatus({
          error: `aisstream closed the connection (code ${event.code}) before sending data. Check AISSTREAM_API_KEY.`,
        });
      }
      if (status.state !== 'stopped') setStatus({ state: 'reconnecting' });
    });

    ws.addEventListener('error', () => {
      if (!status.error) setStatus({ error: 'aisstream WebSocket error' });
    });
  }

  return {
    vessels,
    status,

    // Called on start and from the Durable Object's alarm: connects if needed,
    // reconnects a dead or silent stream and drops stale vessels.
    async tick() {
      if (!apiKey) return;
      const now = Date.now();
      let removed = false;
      for (const [mmsi, v] of vessels) {
        if (now - v.lastSeen > STALE_AFTER) removed = vessels.delete(mmsi);
      }
      if (removed) onChange?.();

      if (socket && now - lastActivity > QUIET_AFTER) {
        socket.close(1000, 'Stream went quiet');
        socket = null;
      }
      if (!socket) await connect();
    },

    stop() {
      if (!apiKey) return;
      setStatus({ state: 'stopped' });
      const ws = socket;
      socket = null;
      ws?.close(1000, 'No viewers');
    },

    restore(list) {
      const cutoff = Date.now() - STALE_AFTER;
      for (const v of list) if (v.lastSeen > cutoff) vessels.set(v.mmsi, v);
    },
  };
}
