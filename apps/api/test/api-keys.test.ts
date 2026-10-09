import { eq } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { base32Decode, hotp, stepAt, totp } from '../src/auth/totp.js';
import { orders } from '../src/db/schema.js';
import { waitFor } from './fake-ws-server.js';
import { signUp, useTestApp } from './helpers.js';
import { ManualProvider } from './manual-provider.js';

const market = new ManualProvider();
const ctx = useTestApp({ providers: [market] });
const PASSWORD = 'correct horse battery staple';
let token: string;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function createKey(body: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/api-keys', headers: bearer(token), payload: { password: PASSWORD, ...body } });
}

async function enableMfa(): Promise<string> {
  const { secret } = (await ctx.app.inject({ method: 'POST', url: '/auth/mfa/setup', headers: bearer(token) })).json();
  // The previous step, so the current one is still free for the next request.
  const code = hotp(base32Decode(secret), stepAt(Date.now()) - 1);
  const res = await ctx.app.inject({ method: 'POST', url: '/auth/mfa/enable', headers: bearer(token), payload: { code } });
  expect(res.statusCode).toBe(200);
  return secret;
}

beforeEach(async () => {
  token = await signUp(ctx.app);
  market.setPrice('AAPL', 200, 0.02);
});

describe('creating keys', () => {
  it('shows the key once and lists only its prefix', async () => {
    const res = await createKey({ name: 'Bot', scopes: ['read'] });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.key).toMatch(/^dta_[0-9a-f]{12}_[\w-]{43}$/);
    expect(created).toMatchObject({ name: 'Bot', scopes: ['read'], prefix: created.key.slice(0, 16) });
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);

    const list = (await ctx.app.inject({ method: 'GET', url: '/api-keys', headers: bearer(token) })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('key');
    expect(JSON.stringify(list)).not.toContain(created.key);
  });

  it('asks for the password, and for two-factor before a key can trade', async () => {
    expect((await createKey({ name: 'Bot', scopes: ['read'], password: 'wrong password' })).statusCode).toBe(401);
    const noMfa = await createKey({ name: 'Bot', scopes: ['trade'] });
    expect(noMfa.statusCode).toBe(403);
    expect(noMfa.json().error).toBe('mfa_required');

    const secret = await enableMfa();
    expect((await createKey({ name: 'Bot', scopes: ['trade'] })).json().error).toBe('mfa_code_required');
    const ok = await createKey({ name: 'Bot', scopes: ['trade'], code: totp(secret) });
    expect(ok.statusCode).toBe(201);
    // Trading includes reading.
    expect(ok.json().scopes).toEqual(['read', 'trade']);
  });
});

describe('using keys', () => {
  it('limits a key to its scopes and never to account management', async () => {
    const { key } = (await createKey({ name: 'Reader', scopes: ['read'] })).json();
    const viaHeader = await ctx.app.inject({ method: 'GET', url: '/portfolio', headers: { 'x-api-key': key } });
    expect(viaHeader.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/market/instruments', headers: bearer(key) })).statusCode).toBe(200);

    const order = await ctx.app.inject({
      method: 'POST',
      url: '/orders',
      headers: bearer(key),
      payload: { symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1' },
    });
    expect(order.statusCode).toBe(403);
    expect(order.json().error).toBe('insufficient_scope');

    for (const [method, url] of [['GET', '/api-keys'], ['GET', '/auth/me'], ['POST', '/auth/mfa/setup']] as const) {
      const res = await ctx.app.inject({ method, url, headers: bearer(key) });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('places orders with a trading key and records which key placed them', async () => {
    const secret = await enableMfa();
    const { key, id } = (await createKey({ name: 'Trader', scopes: ['trade'], code: totp(secret) })).json();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'x-api-key': key },
      payload: { symbol: 'AAPL', side: 'buy', type: 'market', quantity: '1' },
    });
    expect(res.json()).toMatchObject({ status: 'filled' });
    const [row] = await ctx.app.db.select().from(orders).where(eq(orders.id, res.json().id));
    expect(row!.apiKeyId).toBe(id);
  });

  it('stops working once revoked, and rejects made-up keys', async () => {
    const { key, id } = (await createKey({ name: 'Bot', scopes: ['read'] })).json();
    const revoke = await ctx.app.inject({ method: 'DELETE', url: `/api-keys/${id}`, headers: bearer(token) });
    expect(revoke.statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/portfolio', headers: bearer(key) })).statusCode).toBe(401);

    const forged = `${key.slice(0, 17)}${'A'.repeat(43)}`;
    expect((await ctx.app.inject({ method: 'GET', url: '/portfolio', headers: { 'x-api-key': forged } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/portfolio', headers: { 'x-api-key': 'dta_nope' } })).statusCode).toBe(401);
  });

  it('revokes all keys when two-factor is turned off', async () => {
    const secret = await enableMfa();
    const { key } = (await createKey({ name: 'Trader', scopes: ['trade'], code: totp(secret) })).json();
    const off = await ctx.app.inject({
      method: 'POST',
      url: '/auth/mfa/disable',
      headers: bearer(token),
      payload: { password: PASSWORD, code: hotp(base32Decode(secret), stepAt(Date.now()) + 1) },
    });
    expect(off.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/portfolio', headers: bearer(key) })).statusCode).toBe(401);
  });

  it('authenticates the market stream', async () => {
    const { key } = (await createKey({ name: 'Bot', scopes: ['read'] })).json();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/market`);
    const got: { type: string }[] = [];
    ws.on('message', (m) => got.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: key }));
    await waitFor(() => got.some((m) => m.type === 'authenticated'));
    ws.close();
  });
});
