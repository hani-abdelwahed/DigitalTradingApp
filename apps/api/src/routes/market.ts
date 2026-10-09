import type { FastifyInstance } from 'fastify';
import { candlesQuery, type Candle, type Instrument } from '@dta/shared';
import { CircuitBreaker, CircuitOpenError } from '../lib/circuit-breaker.js';
import { HttpError } from '../lib/errors.js';

export default async function marketRoutes(app: FastifyInstance): Promise<void> {
  const read = { onRequest: app.authorize('read') };
  // One breaker per data venue, so an outage at one does not block the others.
  const breakers = new Map<string, CircuitBreaker>();

  app.get('/market/instruments', read, async (): Promise<Instrument[]> => app.market.instruments());

  app.get('/market/candles', read, async (req): Promise<Candle[]> => {
    const q = candlesQuery.parse(req.query);
    const provider = app.market.provider(q.symbol);
    if (!provider) throw new HttpError(404, 'unknown_symbol', `Unknown symbol ${q.symbol}`);
    let breaker = breakers.get(provider.venue);
    if (!breaker) breakers.set(provider.venue, (breaker = new CircuitBreaker()));
    try {
      return await breaker.run(() => provider.getCandles(q.symbol, q.timeframe, q.limit));
    } catch (err) {
      if (!(err instanceof CircuitOpenError)) req.log.warn({ err, symbol: q.symbol }, 'Candle request failed upstream');
      throw new HttpError(502, 'upstream_unavailable', 'Market data is unavailable right now');
    }
  });
}
