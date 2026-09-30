// Live vessel positions from aisstream.io (free, needs an API key). Their
// WebSocket refuses browser connections, so the Durable Object holds the
// socket and keeps an in-memory picture of every vessel inside the box.

import type { AisStatus, Bbox, Vessel } from '#shared/types.ts';

import type { AisMessage, SavedVessel } from './aisstream.ts';
import { MESSAGE_TYPES, applyMessage, parseFrame, revive } from './aisstream.ts';
import { errorMessage } from './errors.ts';

const STREAM_URL = 'https://stream.aisstream.io/v0/stream';
// Drop vessels not heard from in 30 minutes.
const STALE_AFTER = 30 * 60 * 1000;
// Treat a silent stream as dead.
const QUIET_AFTER = 10 * 60 * 1000;

interface AisOptions {
  readonly apiKey: string | undefined;
  readonly bbox: Bbox;
  readonly onChange: () => void;
}

class AisFeed {
  private readonly vessels = new Map<number, Vessel>();
  private readonly apiKey: string | null;
  private readonly bbox: Bbox;
  private readonly onChange: () => void;
  private current: AisStatus;
  private socket: WebSocket | null = null;
  // Sockets that have delivered at least one aisstream frame.
  private readonly heardFrom = new WeakSet<WebSocket>();
  private lastActivity = 0;

  public constructor({ apiKey, bbox, onChange }: AisOptions) {
    // An empty .env entry counts as no key.
    this.apiKey = apiKey === undefined || apiKey === '' ? null : apiKey;
    this.bbox = bbox;
    this.onChange = onChange;
    this.current =
      this.apiKey === null
        ? { state: 'disabled', error: 'AISSTREAM_API_KEY is not set', lastMessageAt: null }
        : { state: 'stopped', error: null, lastMessageAt: null };
  }

  public get status(): AisStatus {
    return this.current;
  }

  public list(): Vessel[] {
    return [...this.vessels.values()];
  }

  // Called on start and from the Durable Object's alarm: connects if needed,
  // reconnects a dead or silent stream and drops stale vessels.
  public async tick(): Promise<void> {
    if (this.apiKey === null) {
      return;
    }
    const now = Date.now();
    this.dropStale(now);
    if (this.socket && now - this.lastActivity > QUIET_AFTER) {
      this.socket.close(1000, 'Stream went quiet');
      this.socket = null;
    }
    if (!this.socket) {
      await this.connect(this.apiKey);
    }
  }

  public stop(): void {
    if (this.apiKey === null) {
      return;
    }
    this.setStatus({ state: 'stopped' });
    const ws = this.socket;
    this.socket = null;
    ws?.close(1000, 'No viewers');
  }

  public restore(saved: readonly SavedVessel[]): void {
    const cutoff = Date.now() - STALE_AFTER;
    for (const v of saved) {
      if (v.lastSeen > cutoff) {
        this.vessels.set(v.mmsi, revive(v));
      }
    }
  }

  // Status changes are pushed to viewers like vessel updates, so the page
  // can say when the feed is connecting or catching up.
  private setStatus(changes: Partial<AisStatus>): void {
    const next = { ...this.current, ...changes };
    const { state, error, lastMessageAt } = this.current;
    if (next.state === state && next.error === error && next.lastMessageAt === lastMessageAt) {
      return;
    }
    this.current = next;
    this.onChange();
  }

  private dropStale(now: number): void {
    let removed = false;
    for (const [mmsi, v] of this.vessels) {
      if (now - v.lastSeen > STALE_AFTER) {
        removed = this.vessels.delete(mmsi);
      }
    }
    if (removed) {
      this.onChange();
    }
  }

  private async connect(apiKey: string): Promise<void> {
    this.setStatus({ state: 'connecting' });
    const ws = await this.open();
    if (!ws) {
      return;
    }
    this.socket = ws;
    this.listen(ws);
    ws.send(
      JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [
          [
            [this.bbox.south, this.bbox.west],
            [this.bbox.north, this.bbox.east],
          ],
        ],
        FilterMessageTypes: MESSAGE_TYPES,
      }),
    );
    this.setStatus({ state: 'connected' });
    this.lastActivity = Date.now();
  }

  private async open(): Promise<WebSocket | null> {
    try {
      // Workers open outbound WebSockets with an Upgrade fetch.
      const res = await fetch(STREAM_URL, { headers: { Upgrade: 'websocket' } });
      const { webSocket } = res;
      if (!webSocket) {
        throw new Error(`aisstream refused the connection (HTTP ${res.status})`);
      }
      webSocket.accept();
      return webSocket;
    } catch (error) {
      this.setStatus({ state: 'reconnecting', error: errorMessage(error) });
      return null;
    }
  }

  private listen(ws: WebSocket): void {
    ws.addEventListener('message', (event) => {
      void this.receive(ws, event.data);
    });
    ws.addEventListener('close', (event) => {
      this.closed(ws, event.code);
    });
    ws.addEventListener('error', () => {
      if (this.current.error === null) {
        this.setStatus({ error: 'aisstream WebSocket error' });
      }
    });
  }

  private async receive(ws: WebSocket, data: unknown): Promise<void> {
    const frame = await parseFrame(data);
    if (!frame) {
      return;
    }
    this.heardFrom.add(ws);
    this.lastActivity = Date.now();
    this.current = { ...this.current, lastMessageAt: this.lastActivity };
    if ('error' in frame) {
      this.setStatus({ error: frame.error });
    } else {
      this.setStatus({ error: null });
      this.track(frame);
    }
  }

  private track(msg: AisMessage): void {
    const vessel = applyMessage(this.vessels, msg, Date.now());
    if (vessel) {
      this.vessels.set(vessel.mmsi, vessel);
      this.onChange();
    }
  }

  private closed(ws: WebSocket, code: number): void {
    if (this.socket !== ws) {
      return;
    }
    this.socket = null;
    // A bad key makes aisstream drop the socket without a reason.
    if (!this.heardFrom.has(ws)) {
      this.setStatus({
        error: `aisstream closed the connection (code ${code}) before sending data. Check AISSTREAM_API_KEY.`,
      });
    }
    if (this.current.state !== 'stopped') {
      this.setStatus({ state: 'reconnecting' });
    }
  }
}

export { AisFeed };
