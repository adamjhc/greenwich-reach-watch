import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { startAis } from './lib/ais.js';
import { fetchGreenwichTier } from './lib/pla.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = join(import.meta.dirname, 'public');
const PLA_REFRESH = 5 * 60 * 1000;

// south,west,north,east — Rotherhithe/Surrey Docks round to the O2.
const [south, west, north, east] = (process.env.BBOX || '51.468,-0.060,51.512,0.020')
  .split(',')
  .map(Number);
const bbox = { south, west, north, east };

const clients = new Set();
let dirty = false;

const ais = startAis({
  apiKey: process.env.AISSTREAM_API_KEY,
  bbox,
  onChange: () => (dirty = true),
});

const tier = { data: null, updatedAt: null, error: null };

async function refreshTier() {
  try {
    tier.data = await fetchGreenwichTier();
    tier.updatedAt = new Date().toISOString();
    tier.error = null;
  } catch (err) {
    tier.error = err.message;
    console.error('PLA refresh failed:', err.message);
  }
  broadcast('tier', tierPayload());
}

const tierPayload = () => ({ ...tier.data, updatedAt: tier.updatedAt, error: tier.error });

const vesselsPayload = () => ({
  status: ais.status,
  bbox,
  vessels: [...ais.vessels.values()].filter((v) => v.lat !== undefined),
});

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}

refreshTier();
setInterval(refreshTier, PLA_REFRESH);

setInterval(() => {
  if (!dirty) return;
  dirty = false;
  broadcast('vessels', vesselsPayload());
}, 2000);

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 20000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, data) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/tier') return json(res, tierPayload());
  if (pathname === '/api/vessels') return json(res, vesselsPayload());

  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    send(res, 'tier', tierPayload());
    send(res, 'vessels', vesselsPayload());
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Greenwich Reach Watch on http://localhost:${PORT}`);
  if (!process.env.AISSTREAM_API_KEY) {
    console.warn('AISSTREAM_API_KEY not set: live boat positions are off. See README.');
  }
});
