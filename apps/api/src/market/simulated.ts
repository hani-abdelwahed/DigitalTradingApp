import { TIMEFRAME_SECONDS, channelKey, type BookLevel, type Candle, type Channel, type Timeframe } from '@dta/shared';
import { CandleBuilder, bucketStart } from './candles.js';
import { equityInstruments } from './equities.js';
import { StreamingProvider } from './types.js';

/**
 * Generated prices for equities, used when no Alpaca keys are configured so the demo works
 * without any accounts. Every instrument it serves is labelled with venue `simulated`.
 */

const START_PRICES: Record<string, number> = { AAPL: 230, MSFT: 420, NVDA: 125, AMZN: 185, TSLA: 250, SPY: 570, QQQ: 490 };
const TICK_VOLATILITY = 0.0004;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function gaussian(rng: () => number): number {
  const u = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

interface SymbolState {
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  rng: () => number;
}

export interface SimulatedOptions {
  tickMs?: number;
  now?: () => number;
  seed?: number;
  /** Tests drive ticks by hand. */
  autoTick?: boolean;
}

export class SimulatedProvider extends StreamingProvider {
  readonly venue = 'simulated' as const;
  readonly instruments = equityInstruments('simulated');

  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly seed: number;
  private readonly autoTick: boolean;
  private readonly state = new Map<string, SymbolState>();
  private readonly builders = new Map<string, CandleBuilder>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: SimulatedOptions = {}) {
    super();
    this.tickMs = opts.tickMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.seed = opts.seed ?? 1;
    this.autoTick = opts.autoTick ?? true;
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const s = this.stateFor(symbol);
    const rng = mulberry32(hash(`${symbol}:${timeframe}`) ^ this.seed);
    const ticksPerBar = (TIMEFRAME_SECONDS[timeframe] * 1000) / this.tickMs;
    const sigma = TICK_VOLATILITY * Math.sqrt(ticksPerBar);
    const step = TIMEFRAME_SECONDS[timeframe];
    const lastTime = bucketStart(this.now(), timeframe);

    // Walk backwards from the current price so history joins up with the live stream.
    const bars: Candle[] = [];
    let close = s.price;
    for (let i = 0; i < limit; i++) {
      const open = close / Math.exp(sigma * gaussian(rng));
      const wick = Math.abs(gaussian(rng)) * sigma * 0.5;
      bars.push({
        time: lastTime - i * step,
        open: round(open),
        high: round(Math.max(open, close) * (1 + wick)),
        low: round(Math.min(open, close) * (1 - wick)),
        close: round(close),
        volume: Math.round(ticksPerBar * 150 * (0.5 + rng())),
      });
      close = open;
    }
    return bars.reverse();
  }

  /** Advances every streamed symbol by one tick. */
  tick(): void {
    const symbols = new Set(this.activeChannels().map((c) => c.symbol));
    const time = this.now();
    for (const symbol of symbols) {
      const s = this.stateFor(symbol);
      s.price = round(s.price * Math.exp(TICK_VOLATILITY * gaussian(s.rng)));
      const size = Math.ceil(s.rng() * 300);
      s.high = Math.max(s.high, s.price);
      s.low = Math.min(s.low, s.price);
      s.volume += size;
      const side = s.rng() < 0.5 ? 'buy' : 'sell';
      const spread = Math.max(0.01, round(s.price * 0.0002));
      const bid = round(s.price - spread / 2);
      const ask = round(bid + spread);

      this.emit({ kind: 'trades', symbol }, { type: 'trade', data: { symbol, price: s.price, size, side, time } });
      this.emit({ kind: 'ticker', symbol }, {
        type: 'ticker',
        data: {
          symbol,
          last: s.price,
          bid,
          ask,
          change24h: round(s.price - s.open),
          changePct24h: round(((s.price - s.open) / s.open) * 100),
          high24h: s.high,
          low24h: s.low,
          volume24h: s.volume,
          time,
        },
      });
      this.emit({ kind: 'book', symbol }, { type: 'book', data: { symbol, ...this.book(s, bid, ask), time } });
      for (const c of this.activeChannels()) {
        if (c.kind !== 'candles' || c.symbol !== symbol) continue;
        const b = this.builders.get(channelKey(c));
        if (b) this.emit(c, { type: 'candle', data: b.addTrade(s.price, size, time) });
      }
    }
  }

  protected onFirstListener(channel: Channel): void {
    if (channel.kind === 'candles') {
      const builder = new CandleBuilder(channel.timeframe);
      this.builders.set(channelKey(channel), builder);
      void this.getCandles(channel.symbol, channel.timeframe, 1).then(([c]) => builder.seed(c));
    }
    if (this.autoTick && !this.timer) {
      this.timer = setInterval(() => this.tick(), this.tickMs);
      this.timer.unref();
    }
  }

  protected onLastListener(channel: Channel): void {
    if (channel.kind === 'candles') this.builders.delete(channelKey(channel));
    if (this.activeChannels().length === 0) this.stopTimer();
  }

  close(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private book(s: SymbolState, bid: number, ask: number): { bids: BookLevel[]; asks: BookLevel[] } {
    const step = Math.max(0.01, round(s.price * 0.0001));
    const bids: BookLevel[] = [];
    const asks: BookLevel[] = [];
    for (let i = 0; i < 20; i++) {
      bids.push([round(bid - i * step), Math.ceil(s.rng() * 400 * (1 + i / 5))]);
      asks.push([round(ask + i * step), Math.ceil(s.rng() * 400 * (1 + i / 5))]);
    }
    return { bids, asks };
  }

  private stateFor(symbol: string): SymbolState {
    let s = this.state.get(symbol);
    if (!s) {
      const price = START_PRICES[symbol] ?? 100;
      s = { price, open: price, high: price, low: price, volume: 0, rng: mulberry32(hash(symbol) ^ this.seed) };
      this.state.set(symbol, s);
    }
    return s;
  }
}
