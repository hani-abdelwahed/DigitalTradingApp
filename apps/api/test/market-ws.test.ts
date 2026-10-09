import type { AddressInfo } from 'node:net';
import type { ServerMessage } from '@dta/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { waitFor } from './fake-ws-server.js';
import { signUp, useTestApp } from './helpers.js';

const ctx = useTestApp();
let url: string;

beforeAll(async () => {
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}/ws/market`;
});

interface Conn {
  ws: WebSocket;
  got: ServerMessage[];
  closed: Promise<number>;
  send(m: unknown): void;
}

async function connect(): Promise<Conn> {
  const ws = new WebSocket(url);
  const got: ServerMessage[] = [];
  ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  await new Promise((r) => ws.once('open', r));
  return { ws, got, closed, send: (m) => ws.send(JSON.stringify(m)) };
}

async function authed(): Promise<Conn> {
  const c = await connect();
  c.send({ type: 'auth', token: await signUp(ctx.app) });
  await waitFor(() => c.got.some((m) => m.type === 'authenticated'));
  return c;
}

describe('market WebSocket', () => {
  it('closes connections that send anything before authenticating', async () => {
    const c = await connect();
    c.send({ type: 'subscribe', channels: ['ticker:AAPL'] });
    expect(await c.closed).toBe(4401);
  });

  it('rejects an invalid token', async () => {
    const c = await connect();
    c.send({ type: 'auth', token: 'nope' });
    expect(await c.closed).toBe(4401);
  });

  it('streams subscribed channels after authentication', async () => {
    const c = await authed();
    c.send({ type: 'subscribe', channels: ['ticker:AAPL', 'book:AAPL', 'candles:AAPL:5m'] });
    await waitFor(() => c.got.find((m) => m.type === 'subscribed'));
    expect(c.got.find((m) => m.type === 'subscribed')).toEqual({
      type: 'subscribed',
      channels: ['ticker:AAPL', 'book:AAPL', 'candles:AAPL:5m'],
    });

    ctx.sim.tick();
    ctx.app.marketHub.flush();
    await waitFor(() => ['ticker', 'book', 'candle'].every((t) => c.got.some((m) => m.type === t)));
    const book = c.got.find((m) => m.type === 'book');
    expect(book?.type === 'book' && book.data.bids.length).toBe(20);

    c.send({ type: 'unsubscribe', channels: ['ticker:AAPL'] });
    await waitFor(() => c.got.find((m) => m.type === 'unsubscribed'));
    c.ws.close();
    await c.closed;
    await waitFor(() => ctx.app.marketHub.channelCount === 0);
  });

  it('reports bad channels and unknown symbols without closing', async () => {
    const c = await authed();
    c.send({ type: 'subscribe', channels: ['ticker:NOPE', 'weird:AAPL', 'candles:AAPL:7m'] });
    await waitFor(() => c.got.filter((m) => m.type === 'error').length === 3);
    expect(c.got.filter((m) => m.type === 'error').map((m) => m.type === 'error' && m.code)).toEqual([
      'unknown_symbol',
      'bad_channel',
      'bad_channel',
    ]);
    c.send({ type: 'ping' });
    await waitFor(() => c.got.some((m) => m.type === 'pong'));
    c.ws.close();
  });

  it('closes clients that flood it with messages', async () => {
    const c = await authed();
    for (let i = 0; i < 40; i++) c.send({ type: 'ping' });
    expect(await c.closed).toBe(4429);
  });
});

describe('market REST', () => {
  it('lists instruments and serves candles', async () => {
    const token = await signUp(ctx.app);
    const headers = { authorization: `Bearer ${token}` };
    const list = await ctx.app.inject({ method: 'GET', url: '/market/instruments', headers });
    expect(list.json().map((i: { symbol: string }) => i.symbol)).toContain('AAPL');

    const res = await ctx.app.inject({ method: 'GET', url: '/market/candles?symbol=AAPL&timeframe=1h&limit=50', headers });
    expect(res.statusCode).toBe(200);
    const candles = res.json();
    expect(candles).toHaveLength(50);
    expect(candles[1].time - candles[0].time).toBe(3600);
    for (const c of candles) expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));

    expect((await ctx.app.inject({ method: 'GET', url: '/market/candles?symbol=AAPL&timeframe=2h', headers })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/market/candles?symbol=ZZZ&timeframe=1h', headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/market/instruments' })).statusCode).toBe(401);
  });
});
