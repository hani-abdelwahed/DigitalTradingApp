import type { Candle, Channel, Instrument } from '@dta/shared';
import { StreamingProvider } from '../src/market/types.js';

/** Market data whose prices tests set by hand. */
export class ManualProvider extends StreamingProvider {
  readonly venue = 'binance' as const;
  readonly instruments: Instrument[] = [
    { symbol: 'BTC-USDT', name: 'Bitcoin', assetClass: 'crypto', venue: 'binance', base: 'BTC', quote: 'USDT', pricePrecision: 2, sizePrecision: 5 },
    { symbol: 'AAPL', name: 'Apple', assetClass: 'equity', venue: 'binance', base: 'AAPL', quote: 'USD', pricePrecision: 2, sizePrecision: 0 },
  ];

  private readonly prices = new Map<string, [number, number]>();

  /** Publishes a quote: `last` with the bid and ask `spread` apart around it. */
  setPrice(symbol: string, last: number, spread = 0): void {
    this.prices.set(symbol, [last, spread]);
    this.publish(symbol, last, spread);
  }

  private publish(symbol: string, last: number, spread: number): void {
    this.emit(
      { kind: 'ticker', symbol },
      {
        type: 'ticker',
        data: {
          symbol,
          last,
          bid: last - spread / 2,
          ask: last + spread / 2,
          change24h: null,
          changePct24h: null,
          high24h: null,
          low24h: null,
          volume24h: null,
          time: Date.now(),
        },
      },
    );
  }

  async getCandles(): Promise<Candle[]> {
    return [];
  }
  // Like a real feed, a new subscriber soon gets the current price.
  protected onFirstListener(c: Channel): void {
    const p = this.prices.get(c.symbol);
    if (p && c.kind === 'ticker') queueMicrotask(() => this.publish(c.symbol, ...p));
  }
  protected onLastListener(_c: Channel): void {}
  close(): void {}
}
