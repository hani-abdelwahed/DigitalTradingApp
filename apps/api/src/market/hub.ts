import { channelKey, type Channel, type ServerMessage } from '@dta/shared';
import type { MarketRegistry } from './registry.js';
import type { StreamEvent } from './types.js';

export interface HubClient {
  send(message: ServerMessage): void;
}

interface ChannelState {
  clients: Set<HubClient>;
  stop: () => void;
  /** Latest ticker, book or candle, sent to clients that join later. */
  last?: ServerMessage;
  /** Update waiting for the next flush. */
  pending?: ServerMessage;
}

/**
 * Fans market data out to WebSocket clients. Opens one upstream subscription per channel
 * however many clients share it, and coalesces fast-changing updates (tickers, books, the
 * live candle) so each client gets at most one per channel per flush interval.
 */
export class MarketHub {
  private readonly channels = new Map<string, ChannelState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: MarketRegistry,
    private readonly flushMs = 100,
  ) {}

  /** Returns false when no provider serves the channel's symbol. */
  subscribe(client: HubClient, channel: Channel): boolean {
    const key = channelKey(channel);
    let state = this.channels.get(key);
    if (!state) {
      const provider = this.registry.provider(channel.symbol);
      if (!provider) return false;
      const s: ChannelState = { clients: new Set(), stop: () => {} };
      this.channels.set(key, s);
      s.stop = provider.subscribe(channel, (ev) => this.onEvent(key, s, ev));
      state = s;
      this.startTimer();
    }
    if (!state.clients.has(client)) {
      state.clients.add(client);
      if (state.last) client.send(state.last);
    }
    return true;
  }

  unsubscribe(client: HubClient, key: string): void {
    const state = this.channels.get(key);
    if (!state || !state.clients.delete(client) || state.clients.size > 0) return;
    this.channels.delete(key);
    state.stop();
    if (this.channels.size === 0) this.stopTimer();
  }

  removeClient(client: HubClient): void {
    for (const key of [...this.channels.keys()]) this.unsubscribe(client, key);
  }

  get channelCount(): number {
    return this.channels.size;
  }

  close(): void {
    for (const state of this.channels.values()) state.stop();
    this.channels.clear();
    this.stopTimer();
  }

  private onEvent(channel: string, state: ChannelState, ev: StreamEvent): void {
    const msg = { type: ev.type, channel, data: ev.data } as ServerMessage;
    if (ev.type === 'trade') {
      this.broadcast(state, msg);
      return;
    }
    // A candle from a new bar must not overwrite the final update of the previous one.
    if (ev.type === 'candle' && state.pending?.type === 'candle' && state.pending.data.time !== ev.data.time) {
      this.broadcast(state, state.pending);
    }
    state.pending = msg;
    state.last = msg;
  }

  flush(): void {
    for (const state of this.channels.values()) {
      if (!state.pending) continue;
      const msg = state.pending;
      state.pending = undefined;
      this.broadcast(state, msg);
    }
  }

  private broadcast(state: ChannelState, msg: ServerMessage): void {
    for (const c of state.clients) c.send(msg);
  }

  private startTimer(): void {
    if (this.timer || this.flushMs <= 0) return;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
