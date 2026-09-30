// Live vessel positions from aisstream.io (free, needs an API key). Their
// WebSocket refuses browser connections, so the server holds the socket and
// keeps an in-memory picture of every vessel inside the bounding box.

const URL = 'wss://stream.aisstream.io/v0/stream';
const STALE_AFTER = 30 * 60 * 1000; // drop vessels not heard from in 30 min
const QUIET_AFTER = 10 * 60 * 1000; // reconnect if the stream goes silent

const MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];

const clean = (s) => (typeof s === 'string' ? s.replace(/@+$/, '').trim() || null : null);

export function startAis({ apiKey, bbox, onChange }) {
  const vessels = new Map();
  const status = { state: apiKey ? 'connecting' : 'disabled', error: null, lastMessageAt: null };
  let socket;
  let retryDelay = 2000;
  let lastActivity = 0;

  if (!apiKey) {
    status.error = 'AISSTREAM_API_KEY is not set';
    return { vessels, status };
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

  function connect() {
    status.state = 'connecting';
    let received = false;
    socket = new WebSocket(URL);
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          APIKey: apiKey,
          BoundingBoxes: [[[bbox.south, bbox.west], [bbox.north, bbox.east]]],
          FilterMessageTypes: MESSAGE_TYPES,
        }),
      );
      status.state = 'connected';
      status.error = null;
      retryDelay = 2000;
      lastActivity = Date.now();
    });

    socket.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      received = true;
      status.lastMessageAt = lastActivity = Date.now();
      if (msg.error) {
        status.error = msg.error;
        return;
      }
      handle(msg);
    });

    socket.addEventListener('error', (event) => {
      status.error = event.message || 'WebSocket error';
    });

    socket.addEventListener('close', (event) => {
      // aisstream drops the socket without a reason when the key is bad.
      if (!received) {
        status.error = `aisstream closed the connection (code ${event.code}) before sending data. Check AISSTREAM_API_KEY.`;
      }
      status.state = 'reconnecting';
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    });
  }

  setInterval(() => {
    const now = Date.now();
    let removed = false;
    for (const [mmsi, v] of vessels) {
      if (now - v.lastSeen > STALE_AFTER) removed = vessels.delete(mmsi);
    }
    if (removed) onChange?.();

    if (status.state === 'connected' && now - lastActivity > QUIET_AFTER) {
      lastActivity = now;
      socket.close();
    }
  }, 60 * 1000).unref();

  connect();
  return { vessels, status };
}
