import { beforeEach, describe, expect, it } from 'vitest';
import { signUp, useTestApp } from './helpers.js';
import { ManualProvider } from './manual-provider.js';

const market = new ManualProvider();
const ctx = useTestApp({
  providers: [market],
  env: { MAX_ORDER_NOTIONAL: '50000', MAX_OPEN_ORDERS: '3', CIRCUIT_BREAKER_HALT_SECONDS: '1' },
});
let token: string;

const auth = () => ({ authorization: `Bearer ${token}` });
const place = (body: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/orders', headers: auth(), payload: body });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setPrice(symbol: string, last: number, spread = 0) {
  market.setPrice(symbol, last, spread);
  await ctx.app.trading.idle();
}

async function getOrder(id: string) {
  const res = await ctx.app.inject({ method: 'GET', url: '/orders?status=all', headers: auth() });
  return res.json().find((o: { id: string }) => o.id === id);
}

async function balance(asset: string) {
  const p = (await ctx.app.inject({ method: 'GET', url: '/portfolio', headers: auth() })).json();
  return p.balances.find((b: { asset: string }) => b.asset === asset);
}

beforeEach(async () => {
  token = await signUp(ctx.app);
  await setPrice('BTC-USDT', 50_000, 10);
  await setPrice('AAPL', 200, 0.02);
});

describe('slippage protection', () => {
  it('rejects a triggered order whose fill would be worse than the limit, and releases the hold', async () => {
    const stop = (
      await place({ symbol: 'BTC-USDT', side: 'buy', type: 'stop_loss', quantity: '0.1', triggerPrice: '51000', maxSlippagePercent: '1' })
    ).json();
    expect(stop.maxSlippagePercent).toBe('1');
    // The hold covers the worst accepted price: 0.1 × 51,000 × 1.01, plus the 0.1% fee.
    expect(await balance('USDT')).toMatchObject({ held: '5156.151' });

    await setPrice('BTC-USDT', 52_000, 10);
    expect(await getOrder(stop.id)).toMatchObject({
      status: 'rejected',
      reason: 'Slippage protection: the ask was 52005, 1.97% from 51000, beyond your 1% limit',
    });
    expect(await balance('USDT')).toEqual({ asset: 'USDT', available: '100000', held: '0' });
  });

  it('rejects a market order into a wide spread, and fills within the default 2%', async () => {
    await setPrice('AAPL', 200, 6);
    const tight = await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1', maxSlippagePercent: '1' });
    expect(tight.json()).toMatchObject({ status: 'rejected' });
    const normal = await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1' });
    expect(normal.json()).toMatchObject({ status: 'filled', averageFillPrice: '203', maxSlippagePercent: '2' });
  });

  it('is not used by limit orders', async () => {
    const res = await place({ symbol: 'AAPL', side: 'buy', type: 'limit', quantity: '1', limitPrice: '190', maxSlippagePercent: '1' });
    expect(res.statusCode).toBe(400);
  });
});

describe('pre-trade limits', () => {
  it('refuses limit prices far through the market', async () => {
    const buy = await place({ symbol: 'BTC-USDT', side: 'buy', type: 'limit', quantity: '0.01', limitPrice: '56000' });
    expect(buy.json()).toMatchObject({ error: 'invalid_order', message: expect.stringContaining('looks like a typo') });
    const sell = await place({ symbol: 'BTC-USDT', side: 'sell', type: 'limit', quantity: '0.01', limitPrice: '44000' });
    expect(sell.statusCode).toBe(400);
    const near = await place({ symbol: 'BTC-USDT', side: 'buy', type: 'limit', quantity: '0.01', limitPrice: '54000' });
    expect(near.json()).toMatchObject({ status: 'filled' });
  });

  it('caps order size and the number of open orders', async () => {
    const big = await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '300' });
    expect(big.json()).toMatchObject({ error: 'invalid_order', message: 'Orders are limited to 50,000 USD each' });

    for (let i = 0; i < 3; i++) {
      expect((await place({ symbol: 'AAPL', side: 'buy', type: 'limit', quantity: '1', limitPrice: '150' })).statusCode).toBe(201);
    }
    const fourth = await place({ symbol: 'AAPL', side: 'buy', type: 'limit', quantity: '1', limitPrice: '150' });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error).toBe('too_many_open_orders');
  });
});

describe('circuit breakers', () => {
  it('pauses a symbol after a sudden move, holding its stops until trading resumes', async () => {
    await place({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: '0.1' });
    const stop = (await place({ symbol: 'BTC-USDT', side: 'sell', type: 'stop_loss', quantity: '0.1', triggerPrice: '48000' })).json();

    await setPrice('BTC-USDT', 44_000, 10); // a 12% drop
    expect((await getOrder(stop.id)).status).toBe('open');
    const halted = await place({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: '0.01' });
    expect(halted.statusCode).toBe(503);
    expect(halted.json()).toMatchObject({ error: 'trading_halted', message: expect.stringContaining('fell 12.0% within 5 minutes') });
    const halts = (await ctx.app.inject({ method: 'GET', url: '/halts', headers: auth() })).json();
    expect(halts).toEqual([
      { symbol: 'BTC-USDT', kind: 'automatic', reason: 'The price fell 12.0% within 5 minutes', until: expect.any(String) },
    ]);
    // Other symbols keep trading.
    expect((await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1' })).statusCode).toBe(201);

    await sleep(1100);
    // Trading resumes; the stop triggers, but 44,000 is far below its 48,000 trigger, so
    // slippage protection rejects it rather than selling into the gap.
    await setPrice('BTC-USDT', 44_000, 10);
    expect(await getOrder(stop.id)).toMatchObject({ status: 'rejected', reason: expect.stringContaining('Slippage protection') });
  });

  it('honours manual halts for one symbol or everything', async () => {
    const resting = (await place({ symbol: 'AAPL', side: 'buy', type: 'limit', quantity: '1', limitPrice: '190' })).json();
    await ctx.app.trading.halts.set('AAPL', 'Exchange maintenance');

    const aapl = await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1' });
    expect(aapl.json()).toEqual({ error: 'trading_halted', message: 'Trading in AAPL is paused: Exchange maintenance' });
    expect((await place({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: '0.01' })).statusCode).toBe(201);
    await setPrice('AAPL', 185, 0.02);
    expect((await getOrder(resting.id)).status).toBe('open');

    await ctx.app.trading.halts.set(null, 'Incident');
    const btc = await place({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: '0.01' });
    expect(btc.json()).toEqual({ error: 'trading_halted', message: 'Trading is paused: Incident' });
    // Cancelling still works while halted.
    const cancel = await ctx.app.inject({ method: 'DELETE', url: `/orders/${resting.id}`, headers: auth() });
    expect(cancel.json().status).toBe('cancelled');

    await ctx.app.trading.halts.clear(null);
    await ctx.app.trading.halts.clear('AAPL');
    expect((await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1' })).statusCode).toBe(201);
  });
});

describe('rate limits', () => {
  it('limits order requests per account, not per address', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const cancel = (t: string) => ctx.app.inject({ method: 'DELETE', url: `/orders/${missing}`, headers: { authorization: `Bearer ${t}` } });
    for (let i = 0; i < 60; i++) expect((await cancel(token)).statusCode).toBe(404);
    expect((await cancel(token)).statusCode).toBe(429);
    // Someone else on the same address is unaffected.
    const other = await signUp(ctx.app, 'other@example.com');
    expect((await cancel(other)).statusCode).toBe(404);
  });
});
