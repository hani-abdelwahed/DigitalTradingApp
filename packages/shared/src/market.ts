import { z } from 'zod';
import type { Order } from './trading.js';

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const timeframeSchema = z.enum(TIMEFRAMES);

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
};

export type AssetClass = 'crypto' | 'equity';
export type Venue = 'binance' | 'alpaca' | 'simulated';

export interface Instrument {
  /** Canonical symbol: `BTC-USDT` for crypto pairs, the ticker (`AAPL`) for equities. */
  symbol: string;
  name: string;
  assetClass: AssetClass;
  venue: Venue;
  base: string;
  quote: string;
  /** Decimal places for display. */
  pricePrecision: number;
  sizePrecision: number;
}

/** OHLCV bar. `time` is the bar's open time in Unix seconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  symbol: string;
  price: number;
  size: number;
  /** Aggressor side, when the venue reports it. */
  side: 'buy' | 'sell' | null;
  /** Unix milliseconds. */
  time: number;
}

export interface Ticker {
  symbol: string;
  last: number;
  bid: number | null;
  ask: number | null;
  change24h: number | null;
  changePct24h: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  time: number;
}

export type BookLevel = [price: number, size: number];

/** L2 snapshot: aggregated size per price level, best price first on each side. */
export interface OrderBook {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  time: number;
}

// --- WebSocket protocol (/ws/market) ---

const SYMBOL = /^[A-Z0-9]{1,12}(-[A-Z0-9]{1,12})?$/;

/** Channels: `ticker:SYM`, `trades:SYM`, `book:SYM`, `candles:SYM:TF`. */
export type Channel =
  | { kind: 'ticker' | 'trades' | 'book'; symbol: string }
  | { kind: 'candles'; symbol: string; timeframe: Timeframe };

export function parseChannel(raw: string): Channel | null {
  const [kind, symbol, tf, ...rest] = raw.split(':');
  if (!symbol || !SYMBOL.test(symbol) || rest.length > 0) return null;
  if (kind === 'candles') {
    const parsed = timeframeSchema.safeParse(tf);
    return parsed.success ? { kind, symbol, timeframe: parsed.data } : null;
  }
  if ((kind === 'ticker' || kind === 'trades' || kind === 'book') && tf === undefined) return { kind, symbol };
  return null;
}

export function channelKey(c: Channel): string {
  return c.kind === 'candles' ? `candles:${c.symbol}:${c.timeframe}` : `${c.kind}:${c.symbol}`;
}

export const MAX_CHANNELS_PER_CONNECTION = 50;

const channelList = z.array(z.string().max(40)).min(1).max(MAX_CHANNELS_PER_CONNECTION);

export const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('subscribe'), channels: channelList }),
  z.object({ type: z.literal('unsubscribe'), channels: channelList }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

export type ServerMessage =
  | { type: 'authenticated' }
  | { type: 'subscribed'; channels: string[] }
  | { type: 'unsubscribed'; channels: string[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  | { type: 'ticker'; channel: string; data: Ticker }
  | { type: 'trade'; channel: string; data: Trade }
  | { type: 'book'; channel: string; data: OrderBook }
  | { type: 'candle'; channel: string; data: Candle }
  /** On the private `orders` channel: one of your orders changed (placed, filled, cancelled...). */
  | { type: 'order'; channel: 'orders'; data: Order };

/** Private channel carrying the signed-in user's order updates. */
export const ORDERS_CHANNEL = 'orders';

export const candlesQuery = z.object({
  symbol: z.string().regex(SYMBOL),
  timeframe: timeframeSchema,
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type CandlesQuery = z.infer<typeof candlesQuery>;
