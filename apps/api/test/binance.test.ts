import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BinanceProvider, parseDepth, parseKline, parseRestKlines, parseTicker, parseTrade, streamName } from '../src/market/binance.js';
import type { StreamEvent } from '../src/market/types.js';
import { FakeWsServer, waitFor } from './fake-ws-server.js';

// Payloads follow the shapes in Binance's spot API documentation.
const tickerPayload = {
  e: '24hrTicker', E: 1767625200000, s: 'BTCUSDT', p: '1250.50', P: '1.32', c: '96010.12', b: '96010.11', a: '96010.13',
  h: '96500.00', l: '94100.00', v: '15234.12', q: '1450000000.00',
};
const tradePayload = { e: 'trade', E: 1767625200001, s: 'BTCUSDT', t: 12345, p: '96010.12', q: '0.015', T: 1767625200000, m: true };
const depthPayload = {
  lastUpdateId: 160,
  bids: [['96010.11', '1.5'], ['96010.00', '0.2']] as [string, string][],
  asks: [['96010.13', '0.7']] as [string, string][],
};
const klinePayload = {
  e: 'kline', E: 1767625201000, s: 'BTCUSDT',
  k: { t: 1767625200000, T: 1767625259999, s: 'BTCUSDT', i: '1m', o: '96000.00', c: '96010.12', h: '96020.00', l: '95990.00', v: '12.5', x: false },
};

describe('Binance parsers', () => {
  it('parses a 24h ticker', () => {
    expect(parseTicker('BTC-USDT', tickerPayload)).toEqual({
      symbol: 'BTC-USDT', last: 96010.12, bid: 96010.11, ask: 96010.13, change24h: 1250.5, changePct24h: 1.32,
      high24h: 96500, low24h: 94100, volume24h: 15234.12, time: 1767625200000,
    });
  });

  it('reads the aggressor side from the maker flag', () => {
    expect(parseTrade('BTC-USDT', tradePayload).side).toBe('sell');
    expect(parseTrade('BTC-USDT', { ...tradePayload, m: false }).side).toBe('buy');
  });

  it('parses depth and klines', () => {
    expect(parseDepth('BTC-USDT', depthPayload, 1).bids).toEqual([[96010.11, 1.5], [96010, 0.2]]);
    expect(parseKline(klinePayload)).toEqual({ time: 1767625200, open: 96000, high: 96020, low: 95990, close: 96010.12, volume: 12.5 });
    expect(parseRestKlines([[1767625200000, '1', '2', '0.5', '1.5', '10', 1767625259999, '15', 3]])).toEqual([
      { time: 1767625200, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    ]);
  });

  it('names streams', () => {
    expect(streamName({ kind: 'book', symbol: 'ETH-USDT' })).toBe('ethusdt@depth20@100ms');
    expect(streamName({ kind: 'candles', symbol: 'BTC-USDT', timeframe: '4h' })).toBe('btcusdt@kline_4h');
  });
});

describe('BinanceProvider', () => {
  let server: FakeWsServer;
  let provider: BinanceProvider;

  beforeEach(() => {
    server = new FakeWsServer();
    provider = new BinanceProvider({ wsUrl: server.url });
  });
  afterEach(async () => {
    provider.close();
    await server.close();
  });

  it('subscribes upstream once, routes messages, and unsubscribes when the last listener leaves', async () => {
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    const stopA = provider.subscribe({ kind: 'ticker', symbol: 'BTC-USDT' }, (e) => a.push(e));
    const stopB = provider.subscribe({ kind: 'ticker', symbol: 'BTC-USDT' }, (e) => b.push(e));

    const sub = await waitFor(() => server.received.find((m) => (m as { method: string }).method === 'SUBSCRIBE'));
    expect(sub).toMatchObject({ params: ['btcusdt@ticker'] });

    server.broadcast({ stream: 'btcusdt@ticker', data: tickerPayload });
    await waitFor(() => a.length && b.length);
    expect(a[0]).toMatchObject({ type: 'ticker', data: { symbol: 'BTC-USDT', last: 96010.12 } });

    stopA();
    stopB();
    const unsub = await waitFor(() => server.received.find((m) => (m as { method: string }).method === 'UNSUBSCRIBE'));
    expect(unsub).toMatchObject({ params: ['btcusdt@ticker'] });
  });

  it('resubscribes after the connection drops', async () => {
    provider.subscribe({ kind: 'trades', symbol: 'ETH-USDT' }, () => {});
    await waitFor(() => server.received.length === 1);
    server.latest.terminate();
    const again = await waitFor(() => server.received.length >= 2 && server.received[1], 5000);
    expect(again).toMatchObject({ method: 'SUBSCRIBE', params: ['ethusdt@trade'] });
  });

  it('fetches candles over REST', async () => {
    const urls: string[] = [];
    const p = new BinanceProvider({
      restUrl: 'https://binance.test',
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify([[1767625200000, '1', '2', '0.5', '1.5', '10', 0]]));
      }) as typeof fetch,
    });
    expect(await p.getCandles('SOL-USDT', '15m', 2)).toHaveLength(1);
    expect(urls[0]).toBe('https://binance.test/api/v3/klines?symbol=SOLUSDT&interval=15m&limit=2');
  });
});
