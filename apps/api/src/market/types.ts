import { channelKey, type Candle, type Channel, type Instrument, type OrderBook, type Ticker, type Timeframe, type Trade, type Venue } from '@dta/shared';

export type StreamEvent =
  | { type: 'ticker'; data: Ticker }
  | { type: 'trade'; data: Trade }
  | { type: 'book'; data: OrderBook }
  | { type: 'candle'; data: Candle };

export type Listener = (event: StreamEvent) => void;

/** A source of market data for a set of instruments: one per venue. */
export interface MarketDataProvider {
  readonly venue: Venue;
  readonly instruments: readonly Instrument[];
  getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  /** Starts streaming a channel; the returned function stops it. */
  subscribe(channel: Channel, listener: Listener): () => void;
  close(): Promise<void> | void;
}

/**
 * Tracks listeners per channel and tells the subclass when a channel gains its first
 * listener or loses its last, so upstream subscriptions are opened and closed exactly once.
 */
export abstract class StreamingProvider implements MarketDataProvider {
  abstract readonly venue: Venue;
  abstract readonly instruments: readonly Instrument[];
  abstract getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  abstract close(): Promise<void> | void;

  protected abstract onFirstListener(channel: Channel): void;
  protected abstract onLastListener(channel: Channel): void;

  private readonly listeners = new Map<string, { channel: Channel; set: Set<Listener> }>();

  subscribe(channel: Channel, listener: Listener): () => void {
    const key = channelKey(channel);
    let entry = this.listeners.get(key);
    if (!entry) {
      entry = { channel, set: new Set() };
      this.listeners.set(key, entry);
      entry.set.add(listener);
      this.onFirstListener(channel);
    } else {
      entry.set.add(listener);
    }
    return () => {
      const e = this.listeners.get(key);
      if (!e || !e.set.delete(listener) || e.set.size > 0) return;
      this.listeners.delete(key);
      this.onLastListener(e.channel);
    };
  }

  protected emit(channel: Channel, event: StreamEvent): void {
    const entry = this.listeners.get(channelKey(channel));
    if (!entry) return;
    for (const l of entry.set) l(event);
  }

  protected activeChannels(): Channel[] {
    return [...this.listeners.values()].map((e) => e.channel);
  }
}
