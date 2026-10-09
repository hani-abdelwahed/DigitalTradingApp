import type { FastifyInstance } from 'fastify';
import { candlesQuery, type Candle, type Instrument } from '@dta/shared';
import { HttpError } from '../lib/errors.js';

export default async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/market/instruments', { onRequest: app.authenticate }, async (): Promise<Instrument[]> =>
    app.market.instruments(),
  );

  app.get('/market/candles', { onRequest: app.authenticate }, async (req): Promise<Candle[]> => {
    const q = candlesQuery.parse(req.query);
    const provider = app.market.provider(q.symbol);
    if (!provider) throw new HttpError(404, 'unknown_symbol', `Unknown symbol ${q.symbol}`);
    try {
      return await provider.getCandles(q.symbol, q.timeframe, q.limit);
    } catch (err) {
      req.log.warn({ err, symbol: q.symbol }, 'Candle request failed upstream');
      throw new HttpError(502, 'upstream_unavailable', 'Market data is unavailable right now');
    }
  });
}
