import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { waitFor } from './fake-ws-server.js';
import { signUp, useTestApp } from './helpers.js';
import { ManualProvider } from './manual-provider.js';

const market = new ManualProvider();
// These tests jump prices around freely; the circuit breaker has its own tests.
const ctx = useTestApp({ providers: [market], env: { CIRCUIT_BREAKER_PERCENT: '0' } });
let token: string;

const auth = () => ({ authorization: `Bearer ${token}` });

async function place(body: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/orders', headers: auth(), payload: body });
}

async function portfolio() {
  const res = await ctx.app.inject({ method: 'GET', url: '/portfolio', headers: auth() });
  const p = res.json();
  const bal = (asset: string) => p.balances.find((b: { asset: string }) => b.asset === asset) ?? { available: '0', held: '0' };
  const pos = (symbol: string) => p.positions.find((x: { symbol: string }) => x.symbol === symbol);
  return { bal, pos, raw: p };
}

async function setPrice(symbol: string, last: number, spread = 0) {
  market.setPrice(symbol, last, spread);
  await ctx.app.trading.idle();
}

async function getOrder(id: string) {
  const res = await ctx.app.inject({ method: 'GET', url: '/orders?status=all', headers: auth() });
  return res.json().find((o: { id: string }) => o.id === id);
}

beforeEach(async () => {
  token = await signUp(ctx.app);
  market.setPrice('BTC-USDT', 50_000, 10);
  market.setPrice('AAPL', 200, 0.02);
});

describe('paper account', () => {
  it('starts with 100,000 USD and USDT, credited once', async () => {
    await portfolio();
    const { raw } = await portfolio();
    expect(raw.balances).toEqual([
      { asset: 'USD', available: '100000', held: '0' },
      { asset: 'USDT', available: '100000', held: '0' },
    ]);
    const deposits = await ctx.app.db.execute(sql`select count(*)::int as n from ledger_transactions where kind = 'deposit'`);
    expect(deposits.rows[0]).toEqual({ n: 1 });
  });
});

describe('market orders', () => {
  it('buys at the ask, charges the fee, and records the position', async () => {
    const res = await place({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: '0.5' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'filled', filledQuantity: '0.5', averageFillPrice: '50005' });

    const { bal, pos } = await portfolio();
    // 0.5 × 50,005 = 25,002.5, plus a 0.1% fee of 25.0025.
    expect(bal('USDT')).toEqual({ asset: 'USDT', available: '74972.4975', held: '0' });
    expect(bal('BTC')).toEqual({ asset: 'BTC', available: '0.5', held: '0' });
    expect(pos('BTC-USDT')).toMatchObject({ quantity: '0.5', averageCost: '50005', realizedPnl: '-25.0025' });

    const fills = (await ctx.app.inject({ method: 'GET', url: '/fills', headers: auth() })).json();
    expect(fills[0]).toMatchObject({ side: 'buy', quantity: '0.5', price: '50005', fee: '25.0025', feeAsset: 'USDT' });
  });

  it('sells at the bid and realises P&L against the average cost', async () => {
    await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '10' });
    await setPrice('AAPL', 210, 0.02);
    const res = await place({ symbol: 'AAPL', side: 'sell', type: 'market', quantity: '4' });
    expect(res.json()).toMatchObject({ status: 'filled', averageFillPrice: '209.99' });
    const { pos, bal } = await portfolio();
    // Bought at 200.01; 4 × (209.99 − 200.01) = 39.92. Equities have no fee.
    expect(pos('AAPL')).toMatchObject({ quantity: '6', averageCost: '200.01', realizedPnl: '39.92' });
    // 100,000 − 10 × 200.01 + 4 × 209.99
    expect(bal('USD').available).toBe('98839.86');
  });
});

describe('resting orders', () => {
  it('holds funds for a limit buy, fills when the ask reaches the limit, and releases the excess', async () => {
    const res = await place({ symbol: 'BTC-USDT', side: 'buy', type: 'limit', quantity: '1', limitPrice: '49000' });
    const order = res.json();
    expect(order.status).toBe('open');
    // 49,000 plus the 0.1% fee is reserved.
    expect((await portfolio()).bal('USDT')).toMatchObject({ available: '50951', held: '49049' });

    await setPrice('BTC-USDT', 49_200, 10);
    expect((await getOrder(order.id)).status).toBe('open');
    await setPrice('BTC-USDT', 48_990, 10);
    expect(await getOrder(order.id)).toMatchObject({ status: 'filled', averageFillPrice: '48995' });
    const { bal } = await portfolio();
    // 100,000 − 48,995 − 0.1% fee (48.995); the rest of the hold is released.
    expect(bal('USDT')).toEqual({ asset: 'USDT', available: '50956.005', held: '0' });
    expect(bal('BTC').available).toBe('1');
  });

  it('releases the hold when an order is cancelled, and refuses to cancel twice', async () => {
    const order = (await place({ symbol: 'AAPL', side: 'buy', type: 'limit', quantity: '100', limitPrice: '150' })).json();
    expect((await portfolio()).bal('USD').held).toBe('15000');
    const cancel = await ctx.app.inject({ method: 'DELETE', url: `/orders/${order.id}`, headers: auth() });
    expect(cancel.json()).toMatchObject({ status: 'cancelled' });
    expect((await portfolio()).bal('USD')).toMatchObject({ available: '100000', held: '0' });
    const again = await ctx.app.inject({ method: 'DELETE', url: `/orders/${order.id}`, headers: auth() });
    expect(again.statusCode).toBe(409);
  });

  it('triggers a stop-loss when the price falls to it', async () => {
    await place({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: '1' });
    const bad = await place({ symbol: 'BTC-USDT', side: 'sell', type: 'stop_loss', quantity: '1', triggerPrice: '51000' });
    expect(bad.json()).toMatchObject({ error: 'invalid_order' });

    const stop = (await place({ symbol: 'BTC-USDT', side: 'sell', type: 'stop_loss', quantity: '1', triggerPrice: '48000' })).json();
    expect((await portfolio()).bal('BTC')).toMatchObject({ available: '0', held: '1' });
    await setPrice('BTC-USDT', 48_500, 10);
    expect((await getOrder(stop.id)).status).toBe('open');
    await setPrice('BTC-USDT', 47_900, 10);
    expect(await getOrder(stop.id)).toMatchObject({ status: 'filled', averageFillPrice: '47895' });
  });

  it('triggers a take-profit when the price rises to it', async () => {
    await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '5' });
    const tp = (await place({ symbol: 'AAPL', side: 'sell', type: 'take_profit', quantity: '5', triggerPrice: '220' })).json();
    await setPrice('AAPL', 219.5, 0.02);
    expect((await getOrder(tp.id)).status).toBe('open');
    await setPrice('AAPL', 220.4, 0.02);
    expect(await getOrder(tp.id)).toMatchObject({ status: 'filled', averageFillPrice: '220.39' });
    expect((await portfolio()).pos('AAPL')).toBeUndefined();
  });

  it('moves a trailing stop up with the price and fills on the pullback', async () => {
    await setPrice('AAPL', 100, 0);
    await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '10' });
    const trail = (await place({ symbol: 'AAPL', side: 'sell', type: 'trailing_stop', quantity: '10', trailPercent: '5' })).json();
    expect(trail.trailStopPrice).toBe('95');

    await setPrice('AAPL', 110, 0);
    await new Promise((r) => setTimeout(r, 1100)); // trail updates are persisted at most once a second
    await setPrice('AAPL', 108, 0);
    expect(await getOrder(trail.id)).toMatchObject({ status: 'open', trailStopPrice: '104.5' });
    await setPrice('AAPL', 104.6, 0);
    expect((await getOrder(trail.id)).status).toBe('open');
    await setPrice('AAPL', 104.4, 0);
    expect(await getOrder(trail.id)).toMatchObject({ status: 'filled', averageFillPrice: '104.4' });
  });
});

describe('validation', () => {
  it('refuses orders the account cannot pay for or deliver', async () => {
    const buy = await place({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: '3' });
    expect(buy.json()).toMatchObject({ error: 'insufficient_funds' });
    const sell = await place({ symbol: 'AAPL', side: 'sell', type: 'market', quantity: '1' });
    expect(sell.json()).toMatchObject({ error: 'insufficient_funds', message: 'Not enough AAPL to sell' });
    expect((await ctx.app.inject({ method: 'GET', url: '/orders', headers: auth() })).json()).toEqual([]);
  });

  it('checks fields, precision and symbols', async () => {
    expect((await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1.5' })).json().message).toBe(
      'AAPL trades in whole units',
    );
    expect((await place({ symbol: 'AAPL', side: 'buy', type: 'limit', quantity: '1' })).statusCode).toBe(400);
    expect((await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1', limitPrice: '5' })).statusCode).toBe(400);
    expect((await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '-1' })).statusCode).toBe(400);
    expect((await place({ symbol: 'AAPL', side: 'buy', type: 'limit', quantity: '1', limitPrice: '1.001' })).statusCode).toBe(400);
    expect((await place({ symbol: 'NOPE', side: 'buy', type: 'market', quantity: '1' })).statusCode).toBe(404);
  });

  it('returns the original order when a client order id is reused', async () => {
    const body = { symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1', clientOrderId: 'abc-123' };
    const [a, b] = await Promise.all([place(body), place(body)]);
    expect(a.json().id).toBe(b.json().id);
    expect((await portfolio()).pos('AAPL').quantity).toBe('1');
  });
});

describe('ledger integrity', () => {
  it('keeps the books balanced and positions matching the ledger', async () => {
    await place({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: '0.3' });
    await place({ symbol: 'BTC-USDT', side: 'sell', type: 'limit', quantity: '0.1', limitPrice: '51000' });
    await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '7' });
    await setPrice('BTC-USDT', 51_100, 10);
    await place({ symbol: 'AAPL', side: 'sell', type: 'market', quantity: '2' });
    expect(await ctx.app.trading.reconcile()).toEqual([]);
  });

  it('rejects unbalanced transactions and edits to posted entries', async () => {
    await portfolio();
    const unbalanced = ctx.app.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`insert into ledger_transactions (kind) values ('deposit') returning id`);
      const { rows: acct } = await tx.execute<{ id: string }>(sql`select id from ledger_accounts limit 1`);
      await tx.execute(sql`insert into ledger_entries (transaction_id, account_id, asset, amount) values (${rows[0]!.id}, ${acct[0]!.id}, 'USD', 5)`);
    });
    await expect(unbalanced).rejects.toThrow();
    await expect(ctx.app.db.execute(sql`update ledger_entries set amount = amount * 2`)).rejects.toThrow();
    await expect(ctx.app.db.execute(sql`delete from ledger_entries`)).rejects.toThrow();
    // A balance that drifts from its entries is caught at commit.
    await expect(ctx.app.db.execute(sql`update ledger_accounts set balance = balance + 1 where kind = 'available'`)).rejects.toThrow();
  });

  it('fills or cancels exactly once when both race', async () => {
    const order = (await place({ symbol: 'BTC-USDT', side: 'buy', type: 'limit', quantity: '1', limitPrice: '49000' })).json();
    market.setPrice('BTC-USDT', 48_000, 10);
    const cancel = await ctx.app.inject({ method: 'DELETE', url: `/orders/${order.id}`, headers: auth() });
    await ctx.app.trading.idle();
    const final = await getOrder(order.id);
    expect(['filled', 'cancelled']).toContain(final.status);
    expect(cancel.statusCode).toBe(final.status === 'cancelled' ? 200 : 409);
    expect((await portfolio()).bal('USDT').held).toBe('0');
    expect(await ctx.app.trading.reconcile()).toEqual([]);
  });
});

describe('order updates over WebSocket', () => {
  it('pushes your own order changes on the orders channel', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`ws://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}/ws/market`);
    const got: { type: string; data?: { status: string } }[] = [];
    ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'auth', token }));
    await waitFor(() => got.some((m) => m.type === 'authenticated'));
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['orders'] }));
    await waitFor(() => got.some((m) => m.type === 'subscribed'));

    // Another user's order must not appear.
    const other = await signUp(ctx.app, 'other@example.com');
    await ctx.app.inject({ method: 'POST', url: '/orders', headers: { authorization: `Bearer ${other}` }, payload: { symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1' } });
    await place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1' });

    await waitFor(() => got.filter((m) => m.type === 'order').length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.filter((m) => m.type === 'order').map((m) => m.data!.status)).toEqual(['open', 'filled']);
    ws.close();
  });
});
