import { DurableObject } from 'cloudflare:workers';
import { createAis } from './ais.js';
import { fetchGreenwichTier } from './pla.js';

const TICK = 60 * 1000; // alarm cadence while running
const TIER_MAX_AGE = 5 * 60 * 1000; // re-check the PLA list this often
const IDLE_SHUTDOWN = 10 * 60 * 1000; // keep AIS open this long after the last viewer leaves
const BROADCAST_EVERY = 2000;
const PING_EVERY = 20000;
// A client whose stream has this many unread chunks queued is gone.
const MAX_BACKLOG = 10;

const encoder = new TextEncoder();
const frame = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const PING = encoder.encode(': ping\n\n');

function parseBbox(value) {
  // south,west,north,east — Rotherhithe/Surrey Docks round to the O2.
  const [south, west, north, east] = (value || '51.468,-0.060,51.512,0.020').split(',').map(Number);
  return { south, west, north, east };
}

// One instance holds the aisstream connection and the Greenwich Tier status
// for everyone. AIS only runs while someone has the page open (plus a grace
// period), so the object isn't billed for duration around the clock.
export class River extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.bbox = parseBbox(env.BBOX);
    this.clients = new Set();
    this.dirty = false;
    this.running = false;
    this.timers = [];
    this.lastViewerAt = 0;
    this.tier = { data: null, updatedAt: null, error: null };
    this.tierRefresh = null;
    this.ais = createAis({
      apiKey: env.AISSTREAM_API_KEY,
      bbox: this.bbox,
      onChange: () => (this.dirty = true),
    });

    // Last known state, so a returning viewer sees boats straight away.
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get(['tier', 'vessels']);
      if (saved.has('tier')) this.tier = saved.get('tier');
      if (saved.has('vessels')) this.ais.restore(saved.get('vessels'));
    });
  }

  // ---------- RPC ----------

  async stream() {
    let client;
    const body = new ReadableStream({
      start: (controller) => {
        client = controller;
      },
      cancel: () => this.disconnect(client),
    });
    this.clients.add(client);
    this.send(client, frame('tier', this.tierPayload()));
    this.send(client, frame('vessels', this.vesselsPayload()));
    this.ctx.waitUntil(this.start());

    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  async tierSnapshot() {
    await this.refreshTierIfStale();
    return this.tierPayload();
  }

  vesselSnapshot() {
    return this.vesselsPayload();
  }

  // ---------- lifecycle ----------

  async start() {
    this.lastViewerAt = Date.now();
    if (!this.running) {
      this.running = true;
      this.timers = [
        setInterval(() => this.flush(), BROADCAST_EVERY),
        setInterval(() => this.ping(), PING_EVERY),
      ];
      await this.ctx.storage.setAlarm(Date.now() + TICK);
    }
    await Promise.all([this.ais.tick(), this.refreshTierIfStale()]);
  }

  async stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.ais.stop();
    await this.saveVessels();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    // After an eviction or deploy nothing is running in memory; the next
    // viewer's reconnect starts things again.
    if (!this.running) return;

    if (this.clients.size === 0 && Date.now() - this.lastViewerAt > IDLE_SHUTDOWN) {
      await this.stop();
      return;
    }
    await Promise.all([this.ais.tick(), this.refreshTierIfStale()]);
    await this.saveVessels();
    await this.ctx.storage.setAlarm(Date.now() + TICK);
  }

  // ---------- Greenwich Tier ----------

  refreshTierIfStale() {
    const age = Date.now() - (this.tier.updatedAt ? Date.parse(this.tier.updatedAt) : 0);
    if (age < TIER_MAX_AGE) return;
    this.tierRefresh ??= this.refreshTier().finally(() => (this.tierRefresh = null));
    return this.tierRefresh;
  }

  async refreshTier() {
    try {
      const data = await fetchGreenwichTier();
      this.tier = { data, updatedAt: new Date().toISOString(), error: null };
    } catch (err) {
      console.error('PLA refresh failed:', err.message);
      this.tier = { ...this.tier, error: err.message };
    }
    await this.ctx.storage.put('tier', this.tier);
    this.broadcast(frame('tier', this.tierPayload()));
  }

  tierPayload() {
    return { ...this.tier.data, updatedAt: this.tier.updatedAt, error: this.tier.error };
  }

  // ---------- vessels ----------

  vesselsPayload() {
    return {
      status: this.ais.status,
      viewers: this.clients.size,
      bbox: this.bbox,
      vessels: [...this.ais.vessels.values()].filter((v) => v.lat !== undefined),
    };
  }

  saveVessels() {
    return this.ctx.storage.put('vessels', [...this.ais.vessels.values()]);
  }

  // ---------- Server-Sent Events ----------

  send(client, chunk) {
    try {
      if (client.desiredSize !== null && client.desiredSize < -MAX_BACKLOG) throw new Error('backlog');
      client.enqueue(chunk);
    } catch {
      this.disconnect(client);
    }
  }

  broadcast(chunk) {
    for (const client of this.clients) this.send(client, chunk);
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.broadcast(frame('vessels', this.vesselsPayload()));
  }

  ping() {
    this.broadcast(PING);
  }

  disconnect(client) {
    if (!this.clients.delete(client)) return;
    this.lastViewerAt = Date.now();
    try {
      client.close();
    } catch {
      // already closed
    }
  }
}
