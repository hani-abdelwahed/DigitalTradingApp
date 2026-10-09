import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlpacaProvider } from '../src/market/alpaca.js';
import type { StreamEvent } from '../src/market/types.js';
import { FakeWsServer, waitFor } from './fake-ws-server.js';

// Message shapes follow Alpaca's market data stream (v2) documentation.
describe('AlpacaProvider', () => {
  let server: FakeWsServer;
  let provider: AlpacaProvider;
  const requests: string[] = [];

  beforeEach(() => {
    requests.length = 0;
    server = new FakeWsServer();
    server.onConnect = (ws) => {
      ws.send(JSON.stringify([{ T: 'success', msg: 'connected' }]));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.action === 'auth' && m.key === 'KEY' && m.secret === 'SECRET') {
          ws.send(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
        }
      });
    };
    const fetchImpl = (async (url: string) => {
      requests.push(url);
      if (url.includes('/snapshot')) {
        return new Response(JSON.stringify({ prevDailyBar: { c: 200 }, dailyBar: { h: 210, l: 199, v: 1000 } }));
      }
      return new Response(JSON.stringify({ bars: [{ t: '2026-01-05T15:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }));
    }) as typeof fetch;
    provider = new AlpacaProvider({ keyId: 'KEY', secretKey: 'SECRET', wsUrl: server.url, restUrl: 'https://alpaca.test', fetchImpl });
  });
  afterEach(async () => {
    provider.close();
    await server.close();
  });

  it('authenticates, subscribes to the feeds a ticker needs, and builds tickers from trades and quotes', async () => {
    const events: StreamEvent[] = [];
    provider.subscribe({ kind: 'ticker', symbol: 'AAPL' }, (e) => events.push(e));

    const sub = await waitFor(() => server.received.find((m) => (m as { action: string }).action === 'subscribe'));
    expect(sub).toEqual({ action: 'subscribe', trades: ['AAPL'], quotes: ['AAPL'] });
    await waitFor(() => requests.some((u) => u.includes('/v2/stocks/AAPL/snapshot')));

    server.broadcast([{ T: 'q', S: 'AAPL', bp: 209.9, bs: 3, ap: 210.1, as: 5, t: '2026-01-05T15:00:01Z' }]);
    server.broadcast([{ T: 't', S: 'AAPL', p: 210, s: 100, t: '2026-01-05T15:00:02Z' }]);
    const last = await waitFor(() => {
      const t = events.filter((e) => e.type === 'ticker').at(-1);
      return t?.type === 'ticker' && t.data.last === 210 ? t.data : undefined;
    });
    expect(last).toMatchObject({ bid: 209.9, ask: 210.1, change24h: 10, changePct24h: 5 });
  });

  it('aggregates 1-minute bars into the requested timeframe', async () => {
    const events: StreamEvent[] = [];
    provider.subscribe({ kind: 'candles', symbol: 'MSFT', timeframe: '5m' }, (e) => events.push(e));
    await waitFor(() => server.received.find((m) => (m as { action: string }).action === 'subscribe'));
    server.broadcast([
      { T: 'b', S: 'MSFT', t: '2026-01-05T15:05:00Z', o: 10, h: 11, l: 9, c: 10.5, v: 100 },
      { T: 'b', S: 'MSFT', t: '2026-01-05T15:06:00Z', o: 10.5, h: 12, l: 10, c: 11, v: 50 },
    ]);
    const candle = await waitFor(() => events.length === 2 && events[1]);
    expect(candle).toEqual({
      type: 'candle',
      data: { time: Date.parse('2026-01-05T15:05:00Z') / 1000, open: 10, high: 12, low: 9, close: 11, volume: 150 },
    });
  });

  it('requests the latest bars and returns them oldest first', async () => {
    const candles = await provider.getCandles('SPY', '1h', 100);
    expect(candles).toEqual([{ time: Date.parse('2026-01-05T15:00:00Z') / 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
    const url = new URL(requests.at(-1)!);
    expect(url.pathname).toBe('/v2/stocks/SPY/bars');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ timeframe: '1Hour', limit: '100', feed: 'iex', sort: 'desc' });
  });
});
