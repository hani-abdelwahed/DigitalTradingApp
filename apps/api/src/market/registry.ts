import type { Instrument } from '@dta/shared';
import type { MarketDataProvider } from './types.js';

export class MarketRegistry {
  private readonly bySymbol = new Map<string, { provider: MarketDataProvider; instrument: Instrument }>();

  constructor(readonly providers: readonly MarketDataProvider[]) {
    for (const provider of providers) {
      for (const instrument of provider.instruments) {
        if (this.bySymbol.has(instrument.symbol)) throw new Error(`Duplicate instrument ${instrument.symbol}`);
        this.bySymbol.set(instrument.symbol, { provider, instrument });
      }
    }
  }

  instruments(): Instrument[] {
    return [...this.bySymbol.values()].map((e) => e.instrument);
  }

  instrument(symbol: string): Instrument | undefined {
    return this.bySymbol.get(symbol)?.instrument;
  }

  provider(symbol: string): MarketDataProvider | undefined {
    return this.bySymbol.get(symbol)?.provider;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.providers.map((p) => p.close()));
  }
}
