import type { Candle, Channel, Instrument, OrderBook, Ticker, Timeframe, Trade } from '@dta/shared';
import { ReconnectingSocket } from './reconnecting-socket.js';
import { StreamingProvider } from './types.js';

// Binance's public market-data endpoints need no API key.
export const BINANCE_REST_URL = 'https://data-api.binance.vision';
export const BINANCE_WS_URL = 'wss://data-stream.binance.vision/stream';

const crypto = (base: string, name: string, pricePrecision: number, sizePrecision: number): Instrument => ({
  symbol: `${base}-USDT`,
  name,
  assetClass: 'crypto',
  venue: 'binance',
  base,
  quote: 'USDT',
  pricePrecision,
  sizePrecision,
});

export const BINANCE_INSTRUMENTS: Instrument[] = [
  crypto('BTC', 'Bitcoin', 2, 5),
  crypto('ETH', 'Ethereum', 2, 4),
  crypto('SOL', 'Solana', 2, 3),
  crypto('BNB', 'BNB', 2, 3),
  crypto('XRP', 'XRP', 4, 1),
  crypto('DOGE', 'Dogecoin', 5, 0),
];

/** `BTC-USDT` → `BTCUSDT` */
export const toBinanceSymbol = (symbol: string) => symbol.replace('-', '');

export function streamName(channel: Channel): string {
  const s = toBinanceSymbol(channel.symbol).toLowerCase();
  switch (channel.kind) {
    case 'ticker':
      return `${s}@ticker`;
    case 'trades':
      return `${s}@trade`;
    case 'book':
      return `${s}@depth20@100ms`;
    case 'candles':
      return `${s}@kline_${channel.timeframe}`;
  }
}

// --- Payload parsers (shapes from Binance's spot WebSocket and REST docs) ---

type Num = string | number;
const n = (v: Num) => Number(v);
const levels = (rows: [Num, Num][]) => rows.map(([p, q]) => [n(p), n(q)] as [number, number]);

export function parseTicker(symbol: string, d: { c: Num; b: Num; a: Num; p: Num; P: Num; h: Num; l: Num; v: Num; E: number }): Ticker {
  return {
    symbol,
    last: n(d.c),
    bid: n(d.b),
    ask: n(d.a),
    change24h: n(d.p),
    changePct24h: n(d.P),
    high24h: n(d.h),
    low24h: n(d.l),
    volume24h: n(d.v),
    time: d.E,
  };
}

export function parseTrade(symbol: string, d: { p: Num; q: Num; T: number; m: boolean }): Trade {
  // `m` = buyer is the maker, so the aggressor sold.
  return { symbol, price: n(d.p), size: n(d.q), side: d.m ? 'sell' : 'buy', time: d.T };
}

export function parseDepth(symbol: string, d: { bids: [Num, Num][]; asks: [Num, Num][] }, time: number): OrderBook {
  return { symbol, bids: levels(d.bids), asks: levels(d.asks), time };
}

export function parseKline(d: { k: { t: number; o: Num; h: Num; l: Num; c: Num; v: Num } }): Candle {
  const k = d.k;
  return { time: k.t / 1000, open: n(k.o), high: n(k.h), low: n(k.l), close: n(k.c), volume: n(k.v) };
}

/** REST `/api/v3/klines` rows: [openTime, open, high, low, close, volume, closeTime, ...]. */
export function parseRestKlines(rows: [number, Num, Num, Num, Num, Num, ...unknown[]][]): Candle[] {
  return rows.map(([t, o, h, l, c, v]) => ({ time: t / 1000, open: n(o), high: n(h), low: n(l), close: n(c), volume: n(v) }));
}

export interface BinanceOptions {
  restUrl?: string;
  wsUrl?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: new (url: string) => WebSocket;
  onError?: (err: unknown) => void;
}

export class BinanceProvider extends StreamingProvider {
  readonly venue = 'binance' as const;
  readonly instruments = BINANCE_INSTRUMENTS;

  private readonly restUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socket: ReconnectingSocket;
  private readonly streams = new Map<string, Channel>();
  private pending = new Map<string, 'SUBSCRIBE' | 'UNSUBSCRIBE'>();
  private flushTimer: NodeJS.Timeout | null = null;
  private nextId = 1;

  constructor(opts: BinanceOptions = {}) {
    super();
    this.restUrl = opts.restUrl ?? BINANCE_REST_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.socket = new ReconnectingSocket({
      url: opts.wsUrl ?? BINANCE_WS_URL,
      WebSocketImpl: opts.WebSocketImpl,
      onError: opts.onError,
      onOpen: (s) => {
        // Fresh connection: resubscribe to everything that is still wanted.
        this.pending.clear();
        const params = [...this.streams.keys()];
        if (params.length) s.send({ method: 'SUBSCRIBE', params, id: this.nextId++ });
      },
      onMessage: (msg) => this.handle(msg as { stream?: string; data?: unknown }),
    });
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const url = `${this.restUrl}/api/v3/klines?symbol=${toBinanceSymbol(symbol)}&interval=${timeframe}&limit=${limit}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Binance klines ${res.status}`);
    return parseRestKlines((await res.json()) as Parameters<typeof parseRestKlines>[0]);
  }

  protected onFirstListener(channel: Channel): void {
    const name = streamName(channel);
    this.streams.set(name, channel);
    this.queue(name, 'SUBSCRIBE');
    this.socket.connect();
  }

  protected onLastListener(channel: Channel): void {
    const name = streamName(channel);
    this.streams.delete(name);
    this.queue(name, 'UNSUBSCRIBE');
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.socket.close();
  }

  // Binance allows 5 control messages per second per connection, so changes are batched.
  private queue(stream: string, method: 'SUBSCRIBE' | 'UNSUBSCRIBE'): void {
    this.pending.set(stream, method);
    this.flushTimer ??= setTimeout(() => this.flush(), 250);
  }

  private flush(): void {
    this.flushTimer = null;
    if (!this.socket.isOpen) return; // onOpen subscribes to the full set.
    const batch = this.pending;
    this.pending = new Map();
    for (const method of ['SUBSCRIBE', 'UNSUBSCRIBE'] as const) {
      const params = [...batch].filter(([, m]) => m === method).map(([s]) => s);
      if (params.length) this.socket.send({ method, params, id: this.nextId++ });
    }
  }

  private handle(msg: { stream?: string; data?: unknown }): void {
    if (!msg.stream || !msg.data) return; // subscription acks
    const channel = this.streams.get(msg.stream);
    if (!channel) return;
    const d = msg.data as never;
    switch (channel.kind) {
      case 'ticker':
        return this.emit(channel, { type: 'ticker', data: parseTicker(channel.symbol, d) });
      case 'trades':
        return this.emit(channel, { type: 'trade', data: parseTrade(channel.symbol, d) });
      case 'book':
        return this.emit(channel, { type: 'book', data: parseDepth(channel.symbol, d, Date.now()) });
      case 'candles':
        return this.emit(channel, { type: 'candle', data: parseKline(d) });
    }
  }
}
