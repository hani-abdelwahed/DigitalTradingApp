import { describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import { base32Decode, hotp, stepAt, totp } from '../src/auth/totp.js';
import { refreshCookie, useTestApp } from './helpers.js';

const ctx = useTestApp();
const EMAIL = 'trader@example.com';
const PASSWORD = 'correct horse battery staple';

async function register(email = EMAIL, password = PASSWORD) {
  return ctx.app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('registration and login', () => {
  it('registers, sets an httpOnly refresh cookie, and returns the user', async () => {
    const res = await register();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ email: EMAIL, mfaEnabled: false });
    const cookie = res.cookies.find((c) => c.name === 'dta_refresh');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/auth' });

    const me = await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(body.accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(EMAIL);
  });

  it('normalises email case and rejects duplicates', async () => {
    await register();
    const res = await register('Trader@Example.COM');
    expect(res.statusCode).toBe(409);
  });

  it('rejects short passwords', async () => {
    const res = await register(EMAIL, 'short');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    await register();
    const wrong = await ctx.app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: 'nope' } });
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: 'nope' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('locks an account after 10 failed attempts', async () => {
    await register();
    for (let i = 0; i < 10; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: EMAIL, password: 'wrong' },
        remoteAddress: `10.0.0.${i}`,
      });
    }
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
      remoteAddress: '10.0.1.1',
    });
    expect(res.statusCode).toBe(429);
  });

  it('rate-limits credential endpoints per IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `u${i}@example.com`, password: 'x' },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('rejects requests without a valid access token', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
    const res = await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: bearer('not.a.jwt') });
    expect(res.statusCode).toBe(401);
  });
});

describe('sessions', () => {
  it('rotates the refresh token and revokes every session when an old one is reused', async () => {
    const first = refreshCookie(await register())!;

    const r1 = await ctx.app.inject({ method: 'POST', url: '/auth/refresh', cookies: { dta_refresh: first } });
    expect(r1.statusCode).toBe(200);
    const second = refreshCookie(r1)!;
    expect(second).not.toBe(first);

    // Replaying the rotated-out token looks like theft.
    const replay = await ctx.app.inject({ method: 'POST', url: '/auth/refresh', cookies: { dta_refresh: first } });
    expect(replay.statusCode).toBe(401);

    // ...so the legitimate newer token is revoked too.
    const after = await ctx.app.inject({ method: 'POST', url: '/auth/refresh', cookies: { dta_refresh: second } });
    expect(after.statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(r1.json().accessToken) })).statusCode).toBe(401);
  });

  it('logout ends the session and its access token', async () => {
    const res = await register();
    const token = res.json().accessToken;
    const out = await ctx.app.inject({ method: 'POST', url: '/auth/logout', cookies: { dta_refresh: refreshCookie(res)! } });
    expect(out.statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) })).statusCode).toBe(401);
  });
});

describe('two-factor authentication', () => {
  async function enableMfa() {
    const reg = await register();
    const token = reg.json().accessToken as string;
    const setup = await ctx.app.inject({ method: 'POST', url: '/auth/mfa/setup', headers: bearer(token) });
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUrl } = setup.json();
    expect(otpauthUrl).toContain('otpauth://totp/');

    // Use the previous step so the login below can use the current one without tripping replay protection.
    const prevCode = hotp(base32Decode(secret), stepAt(Date.now()) - 1);
    const enable = await ctx.app.inject({
      method: 'POST',
      url: '/auth/mfa/enable',
      headers: bearer(token),
      payload: { code: prevCode },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().mfaEnabled).toBe(true);
    return { secret, token };
  }

  it('requires a code to sign in once enabled', async () => {
    const { secret } = await enableMfa();

    const login = await ctx.app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } });
    expect(login.json()).toMatchObject({ status: 'mfa_required' });
    expect(refreshCookie(login)).toBeUndefined();
    const { mfaToken } = login.json();

    // The challenge token must not work as an access token.
    expect((await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(mfaToken) })).statusCode).toBe(401);

    const bad = await ctx.app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { mfaToken, code: '000000' } });
    expect(bad.statusCode).toBe(401);

    const ok = await ctx.app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { mfaToken, code: totp(secret) } });
    expect(ok.statusCode).toBe(200);
    expect(refreshCookie(ok)).toBeDefined();
  });

  it('rejects a code that was already used', async () => {
    const { secret } = await enableMfa();
    const code = totp(secret);
    const login = async () =>
      (await ctx.app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } })).json()
        .mfaToken as string;

    const first = await ctx.app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { mfaToken: await login(), code } });
    expect(first.statusCode).toBe(200);
    const again = await ctx.app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { mfaToken: await login(), code } });
    expect(again.statusCode).toBe(401);
  });

  it('stores the MFA secret encrypted', async () => {
    const { secret } = await enableMfa();
    const [row] = await ctx.app.db.select({ enc: users.mfaSecretEnc }).from(users);
    expect(row!.enc).toMatch(/^v1\./);
    expect(row!.enc).not.toContain(secret);
  });

  it('needs the password and a code to turn off', async () => {
    const { secret, token } = await enableMfa();
    const wrongPw = await ctx.app.inject({
      method: 'POST',
      url: '/auth/mfa/disable',
      headers: bearer(token),
      payload: { code: totp(secret), password: 'wrong' },
    });
    expect(wrongPw.statusCode).toBe(401);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/auth/mfa/disable',
      headers: bearer(token),
      payload: { code: totp(secret), password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mfaEnabled).toBe(false);
  });
});

describe('health', () => {
  it('reports database and redis status', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { database: true, redis: true } });
  });
});
