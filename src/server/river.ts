import { DurableObject } from 'cloudflare:workers';

import type { Bbox, PositionedVessel, TierData, TierPayload, Vessel, VesselsPayload } from '#shared/types.ts';

import { AisFeed } from './ais.ts';
import type { SavedVessel } from './aisstream.ts';
import { errorMessage } from './errors.ts';
import { fetchGreenwichTier } from './pla.ts';

// Alarm cadence while running.
const TICK = 60 * 1000;
// Re-check the PLA list this often.
const TIER_MAX_AGE = 5 * 60 * 1000;
// Keep AIS open this long after the last viewer leaves.
const IDLE_SHUTDOWN = 10 * 60 * 1000;
const BROADCAST_EVERY = 2000;
const PING_EVERY = 20_000;
// A client whose stream has this many unread chunks queued is gone.
const MAX_BACKLOG = 10;

type Client = ReadableStreamDefaultController<Uint8Array>;

interface TierState {
  readonly data: TierData | null;
  readonly updatedAt: string | null;
  readonly error: string | null;
}

const encoder = new TextEncoder();
const PING = encoder.encode(': ping\n\n');

function frame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseBbox(value: string | undefined): Bbox {
  // South,west,north,east. The default is the river around Greenwich, out to the O2.
  const [south = 51.468, west = -0.06, north = 51.512, east = 0.02] = (value ?? '')
    .split(',')
    .filter((part) => part !== '')
    .map(Number);
  return { south, west, north, east };
}

function hasPosition(v: Vessel): v is PositionedVessel {
  return v.lat !== null && v.lon !== null;
}

// One instance holds the aisstream connection and the Greenwich Tier status
// for everyone. AIS only runs while someone has the page open (plus a grace
// period), so the object isn't billed for duration around the clock.
class River extends DurableObject<Env> {
  private readonly bbox: Bbox;
  private readonly clients = new Set<Client>();
  private readonly ais: AisFeed;
  private dirty = false;
  private running = false;
  private timers: number[] = [];
  private lastViewerAt = 0;
  private tier: TierState = { data: null, updatedAt: null, error: null };
  private tierRefresh: Promise<void> | null = null;

  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.bbox = parseBbox(env.BBOX);
    this.ais = new AisFeed({
      apiKey: env.AISSTREAM_API_KEY,
      bbox: this.bbox,
      onChange: (): void => {
        this.dirty = true;
      },
    });

    // Last known state, so a returning viewer sees boats straight away.
    void ctx.blockConcurrencyWhile(async () => {
      const [tier, vessels] = await Promise.all([
        ctx.storage.get<TierState>('tier'),
        ctx.storage.get<SavedVessel[]>('vessels'),
      ]);
      if (tier) {
        this.tier = tier;
      }
      if (vessels) {
        this.ais.restore(vessels);
      }
    });
  }

  // ---------- RPC ----------

  public stream(): Response {
    let client: Client | null = null;
    const body = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        client = controller;
        this.clients.add(controller);
        this.send(controller, frame('tier', this.tierPayload()));
        this.send(controller, frame('vessels', this.vesselsPayload()));
      },
      cancel: (): void => {
        if (client) {
          this.disconnect(client);
        }
      },
    });
    this.ctx.waitUntil(this.start());

    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  public async tierSnapshot(): Promise<TierPayload> {
    await this.refreshTierIfStale();
    return this.tierPayload();
  }

  public vesselSnapshot(): VesselsPayload {
    return this.vesselsPayload();
  }

  // ---------- lifecycle ----------

  public override async alarm(): Promise<void> {
    // After an eviction or deploy nothing is running in memory; the next
    // viewer's reconnect starts things again.
    if (!this.running) {
      return;
    }

    if (this.clients.size === 0 && Date.now() - this.lastViewerAt > IDLE_SHUTDOWN) {
      await this.stop();
      return;
    }
    await Promise.all([this.ais.tick(), this.refreshTierIfStale()]);
    await this.saveVessels();
    await this.ctx.storage.setAlarm(Date.now() + TICK);
  }

  private async start(): Promise<void> {
    this.lastViewerAt = Date.now();
    if (!this.running) {
      this.running = true;
      this.timers = [
        setInterval(() => {
          this.flush();
        }, BROADCAST_EVERY),
        setInterval(() => {
          this.ping();
        }, PING_EVERY),
      ];
      await this.ctx.storage.setAlarm(Date.now() + TICK);
    }
    await Promise.all([this.ais.tick(), this.refreshTierIfStale()]);
  }

  private async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];
    this.ais.stop();
    await this.saveVessels();
    await this.ctx.storage.deleteAlarm();
  }

  // ---------- Greenwich Tier ----------

  private async refreshTierIfStale(): Promise<void> {
    const age = Date.now() - (this.tier.updatedAt === null ? 0 : Date.parse(this.tier.updatedAt));
    if (age < TIER_MAX_AGE) {
      return;
    }
    // Viewers arriving together share one refresh.
    this.tierRefresh ??= this.refreshTierOnce();
    await this.tierRefresh;
  }

  private async refreshTierOnce(): Promise<void> {
    try {
      await this.refreshTier();
    } finally {
      this.tierRefresh = null;
    }
  }

  private async refreshTier(): Promise<void> {
    try {
      const data = await fetchGreenwichTier();
      this.tier = { data, updatedAt: new Date().toISOString(), error: null };
    } catch (error) {
      console.error('PLA refresh failed:', errorMessage(error));
      this.tier = { ...this.tier, error: errorMessage(error) };
    }
    await this.ctx.storage.put('tier', this.tier);
    this.broadcast(frame('tier', this.tierPayload()));
  }

  private tierPayload(): TierPayload {
    return { ...this.tier.data, updatedAt: this.tier.updatedAt, error: this.tier.error };
  }

  // ---------- vessels ----------

  private vesselsPayload(): VesselsPayload {
    return {
      status: this.ais.status,
      viewers: this.clients.size,
      bbox: this.bbox,
      vessels: this.ais.list().filter((v) => hasPosition(v)),
    };
  }

  private async saveVessels(): Promise<void> {
    await this.ctx.storage.put('vessels', this.ais.list());
  }

  // ---------- Server-Sent Events ----------

  private send(client: Client, chunk: Uint8Array): void {
    try {
      if (client.desiredSize !== null && client.desiredSize < -MAX_BACKLOG) {
        throw new Error('backlog');
      }
      client.enqueue(chunk);
    } catch {
      this.disconnect(client);
    }
  }

  private broadcast(chunk: Uint8Array): void {
    for (const client of this.clients) {
      this.send(client, chunk);
    }
  }

  private flush(): void {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    this.broadcast(frame('vessels', this.vesselsPayload()));
  }

  private ping(): void {
    this.broadcast(PING);
  }

  private disconnect(client: Client): void {
    if (!this.clients.delete(client)) {
      return;
    }
    this.lastViewerAt = Date.now();
    try {
      client.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Wrangler binds this class as the RIVER Durable Object, so nothing imports it.
 *
 * @public
 */
export { River };
