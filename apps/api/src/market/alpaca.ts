import { TIMEFRAME_SECONDS, channelKey, type Candle, type Channel, type Ticker, type Timeframe } from '@dta/shared';
import { CandleBuilder } from './candles.js';
import { equityInstruments } from './equities.js';
import { ReconnectingSocket } from './reconnecting-socket.js';
import { StreamingProvider } from './types.js';

export const ALPACA_REST_URL = 'https://data.alpaca.markets';
export const alpacaWsUrl = (feed: string) => `wss://stream.data.alpaca.markets/v2/${feed}`;

const ALPACA_TIMEFRAME: Record<Timeframe, string> = {
  '1m': '1Min',
  '5m': '5Min',
  '15m': '15Min',
  '1h': '1Hour',
  '4h': '4Hour',
  '1d': '1Day',
};

// --- Payload shapes (Alpaca market data API v2) ---
export interface AlpacaBar { t: string; o: number; h: number; l: number; c: number; v: number }
interface AlpacaTradeMsg { T: 't'; S: string; p: number; s: number; t: string }
interface AlpacaQuoteMsg { T: 'q'; S: string; bp: number; bs: number; ap: number; as: number; t: string }
interface AlpacaBarMsg extends AlpacaBar { T: 'b'; S: string }
type AlpacaMsg = AlpacaTradeMsg | AlpacaQuoteMsg | AlpacaBarMsg | { T: 'success' | 'error' | 'subscription'; msg?: string; code?: number };

export const parseBar = (b: AlpacaBar): Candle => ({
  time: Date.parse(b.t) / 1000,
  open: b.o,
  high: b.h,
  low: b.l,
  close: b.c,
  volume: b.v,
});

export interface AlpacaOptions {
  keyId: string;
  secretKey: string;
  feed?: 'iex' | 'sip';
  restUrl?: string;
  wsUrl?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: new (url: string) => WebSocket;
  onError?: (err: unknown) => void;
}

interface SymbolState {
  last: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  prevClose: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
}

type Kind = 'trades' | 'quotes' | 'bars';

export class AlpacaProvider extends StreamingProvider {
  readonly venue = 'alpaca' as const;
  readonly instruments = equityInstruments('alpaca');

  private readonly restUrl: string;
  private readonly feed: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socket: ReconnectingSocket;
  private authenticated = false;
  private readonly subscribed: Record<Kind, Set<string>> = { trades: new Set(), quotes: new Set(), bars: new Set() };
  private readonly state = new Map<string, SymbolState>();
  private readonly builders = new Map<string, CandleBuilder>();

  constructor(private readonly opts: AlpacaOptions) {
    super();
    this.feed = opts.feed ?? 'iex';
    this.restUrl = opts.restUrl ?? ALPACA_REST_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.socket = new ReconnectingSocket({
      url: opts.wsUrl ?? alpacaWsUrl(this.feed),
      WebSocketImpl: opts.WebSocketImpl,
      onError: opts.onError,
      onOpen: (s) => {
        this.authenticated = false;
        for (const k of Object.values(this.subscribed)) k.clear();
        s.send({ action: 'auth', key: opts.keyId, secret: opts.secretKey });
      },
      onMessage: (msgs) => {
        for (const m of msgs as AlpacaMsg[]) this.handle(m);
      },
    });
  }

  private headers() {
    return { 'APCA-API-KEY-ID': this.opts.keyId, 'APCA-API-SECRET-KEY': this.opts.secretKey };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.restUrl}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Alpaca ${path.split('?')[0]} ${res.status}`);
    return (await res.json()) as T;
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    // Markets are closed nights and weekends, so look back well past limit × bar length.
    const lookbackSecs = TIMEFRAME_SECONDS[timeframe] * limit * (timeframe === '1d' ? 1.6 : 5);
    const start = new Date(Date.now() - lookbackSecs * 1000).toISOString();
    const params = new URLSearchParams({ timeframe: ALPACA_TIMEFRAME[timeframe], limit: String(limit), feed: this.feed, sort: 'desc', start });
    const body = await this.get<{ bars: AlpacaBar[] | null }>(`/v2/stocks/${symbol}/bars?${params}`);
    return (body.bars ?? []).map(parseBar).reverse();
  }

  protected onFirstListener(channel: Channel): void {
    if (channel.kind === 'ticker' || channel.kind === 'book') void this.loadSnapshot(channel.symbol);
    if (channel.kind === 'candles') {
      const builder = new CandleBuilder(channel.timeframe);
      this.builders.set(channelKey(channel), builder);
      this.getCandles(channel.symbol, channel.timeframe, 1)
        .then(([c]) => builder.seed(c))
        .catch((err) => this.opts.onError?.(err));
    }
    this.socket.connect();
    this.syncSubscriptions();
  }

  protected onLastListener(channel: Channel): void {
    if (channel.kind === 'candles') this.builders.delete(channelKey(channel));
    this.syncSubscriptions();
  }

  close(): void {
    this.socket.close();
  }

  private async loadSnapshot(symbol: string): Promise<void> {
    try {
      const snap = await this.get<{
        latestTrade?: { p: number };
        latestQuote?: { bp: number; bs: number; ap: number; as: number };
        dailyBar?: { h: number; l: number; v: number };
        prevDailyBar?: { c: number };
      }>(`/v2/stocks/${symbol}/snapshot?feed=${this.feed}`);
      const s = this.stateFor(symbol);
      s.last ??= snap.latestTrade?.p ?? null;
      s.bid ??= snap.latestQuote?.bp ?? null;
      s.ask ??= snap.latestQuote?.ap ?? null;
      s.bidSize ||= snap.latestQuote?.bs ?? 0;
      s.askSize ||= snap.latestQuote?.as ?? 0;
      s.prevClose = snap.prevDailyBar?.c ?? null;
      s.high = snap.dailyBar?.h ?? null;
      s.low = snap.dailyBar?.l ?? null;
      s.volume = snap.dailyBar?.v ?? null;
      this.emitTicker(symbol, Date.now());
      this.emitBook(symbol, Date.now());
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /** Works out which feeds each symbol needs from the active channels and diffs against what is subscribed. */
  private syncSubscriptions(): void {
    const want: Record<Kind, Set<string>> = { trades: new Set(), quotes: new Set(), bars: new Set() };
    for (const c of this.activeChannels()) {
      if (c.kind === 'trades' || c.kind === 'ticker') want.trades.add(c.symbol);
      if (c.kind === 'book' || c.kind === 'ticker') want.quotes.add(c.symbol);
      if (c.kind === 'candles') want.bars.add(c.symbol);
    }
    // Until the stream is authenticated, the authenticated handler calls this again.
    if (!this.authenticated) return;
    const add: Partial<Record<Kind, string[]>> = {};
    const remove: Partial<Record<Kind, string[]>> = {};
    for (const k of ['trades', 'quotes', 'bars'] as Kind[]) {
      const a = [...want[k]].filter((s) => !this.subscribed[k].has(s));
      const r = [...this.subscribed[k]].filter((s) => !want[k].has(s));
      if (a.length) add[k] = a;
      if (r.length) remove[k] = r;
      this.subscribed[k] = want[k];
    }
    if (Object.keys(add).length) this.socket.send({ action: 'subscribe', ...add });
    if (Object.keys(remove).length) this.socket.send({ action: 'unsubscribe', ...remove });
  }

  private handle(m: AlpacaMsg): void {
    switch (m.T) {
      case 'success':
        if (m.msg === 'authenticated') {
          this.authenticated = true;
          this.syncSubscriptions();
        }
        return;
      case 'error':
        this.opts.onError?.(new Error(`Alpaca stream error ${m.code}: ${m.msg}`));
        return;
      case 't': {
        const s = this.stateFor(m.S);
        const time = Date.parse(m.t);
        s.last = m.p;
        s.high = s.high == null ? m.p : Math.max(s.high, m.p);
        s.low = s.low == null ? m.p : Math.min(s.low, m.p);
        s.volume = (s.volume ?? 0) + m.s;
        this.emit({ kind: 'trades', symbol: m.S }, { type: 'trade', data: { symbol: m.S, price: m.p, size: m.s, side: null, time } });
        this.emitTicker(m.S, time);
        return;
      }
      case 'q': {
        const s = this.stateFor(m.S);
        Object.assign(s, { bid: m.bp, ask: m.ap, bidSize: m.bs, askSize: m.as });
        const time = Date.parse(m.t);
        this.emitTicker(m.S, time);
        this.emitBook(m.S, time);
        return;
      }
      case 'b': {
        const bar = parseBar(m);
        for (const c of this.activeChannels()) {
          if (c.kind !== 'candles' || c.symbol !== m.S) continue;
          const builder = this.builders.get(channelKey(c));
          if (builder) this.emit(c, { type: 'candle', data: builder.addBar(bar) });
        }
        return;
      }
    }
  }

  private stateFor(symbol: string): SymbolState {
    let s = this.state.get(symbol);
    if (!s) {
      s = { last: null, bid: null, ask: null, bidSize: 0, askSize: 0, prevClose: null, high: null, low: null, volume: null };
      this.state.set(symbol, s);
    }
    return s;
  }

  private emitTicker(symbol: string, time: number): void {
    const s = this.stateFor(symbol);
    const last = s.last ?? (s.bid != null && s.ask != null ? (s.bid + s.ask) / 2 : null);
    if (last == null) return;
    const change = s.prevClose != null ? last - s.prevClose : null;
    const ticker: Ticker = {
      symbol,
      last,
      bid: s.bid,
      ask: s.ask,
      change24h: change,
      changePct24h: change != null && s.prevClose ? (change / s.prevClose) * 100 : null,
      high24h: s.high,
      low24h: s.low,
      volume24h: s.volume,
      time,
    };
    this.emit({ kind: 'ticker', symbol }, { type: 'ticker', data: ticker });
  }

  // The IEX feed has no depth, so the book is the top-of-book quote only.
  private emitBook(symbol: string, time: number): void {
    const s = this.stateFor(symbol);
    if (s.bid == null || s.ask == null) return;
    this.emit({ kind: 'book', symbol }, { type: 'book', data: { symbol, bids: [[s.bid, s.bidSize]], asks: [[s.ask, s.askSize]], time } });
  }
}
