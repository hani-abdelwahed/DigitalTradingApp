import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { AlpacaProvider } from './alpaca.js';
import { BinanceProvider } from './binance.js';
import { MarketRegistry } from './registry.js';
import { SimulatedProvider } from './simulated.js';
import type { MarketDataProvider } from './types.js';

export { MarketHub } from './hub.js';
export { MarketRegistry } from './registry.js';

export function createMarketRegistry(config: Config, log: FastifyBaseLogger): MarketRegistry {
  const onError = (venue: string) => (err: unknown) => log.warn({ err, venue }, 'Market data error');
  const providers: MarketDataProvider[] = [];
  if (config.BINANCE_ENABLED) providers.push(new BinanceProvider({ onError: onError('binance') }));
  if (config.ALPACA_KEY_ID && config.ALPACA_SECRET_KEY) {
    providers.push(
      new AlpacaProvider({
        keyId: config.ALPACA_KEY_ID,
        secretKey: config.ALPACA_SECRET_KEY,
        feed: config.ALPACA_FEED,
        onError: onError('alpaca'),
      }),
    );
  } else {
    providers.push(new SimulatedProvider());
  }
  return new MarketRegistry(providers);
}
