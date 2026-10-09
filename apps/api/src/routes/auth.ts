import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  loginRequest,
  mfaDisableRequest,
  mfaEnableRequest,
  mfaVerifyRequest,
  registerRequest,
  type LoginResponse,
  type MfaSetupResponse,
  type TokenResponse,
} from '@dta/shared';
import { toPublicUser, type IssuedTokens, type MfaClaims, type RequestContext } from '../auth/service.js';
import { unauthorized } from '../lib/errors.js';

export const REFRESH_COOKIE = 'dta_refresh';
const COOKIE_PATH = '/auth';

// Tighter per-IP limit for endpoints that take credentials or codes.
const credentialLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

function ctx(req: FastifyRequest): RequestContext {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const { auth, config } = app;
  const secureCookies = config.NODE_ENV === 'production';

  function sendTokens(reply: FastifyReply, tokens: IssuedTokens): TokenResponse {
    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: tokens.refreshExpiresAt,
    });
    return { status: 'ok', accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user: tokens.user };
  }

  function clearRefresh(reply: FastifyReply): void {
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH, sameSite: 'strict', secure: secureCookies, httpOnly: true });
  }

  app.post('/auth/register', { config: credentialLimit }, async (req, reply) => {
    const body = registerRequest.parse(req.body);
    const tokens = await auth.register(body.email, body.password, ctx(req));
    reply.code(201);
    return sendTokens(reply, tokens);
  });

  app.post('/auth/login', { config: credentialLimit }, async (req, reply): Promise<LoginResponse> => {
    const body = loginRequest.parse(req.body);
    const result = await auth.login(body.email, body.password, ctx(req));
    if (result.status === 'mfa_required') return result;
    return sendTokens(reply, result);
  });

  app.post('/auth/mfa/verify', { config: credentialLimit }, async (req, reply) => {
    const body = mfaVerifyRequest.parse(req.body);
    let claims: MfaClaims;
    try {
      claims = app.jwt.verify<MfaClaims>(body.mfaToken);
    } catch {
      throw unauthorized('invalid_mfa_token', 'Sign-in expired, start again');
    }
    if (claims.typ !== 'mfa') throw unauthorized('invalid_mfa_token', 'Sign-in expired, start again');
    return sendTokens(reply, await auth.completeMfaLogin(claims, body.code, ctx(req)));
  });

  app.post('/auth/refresh', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized('invalid_session', 'Session expired, sign in again');
    try {
      return sendTokens(reply, await auth.refresh(token, ctx(req)));
    } catch (err) {
      clearRefresh(reply);
      throw err;
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) await auth.logout(token, ctx(req));
    clearRefresh(reply);
    reply.code(204);
  });

  app.get('/auth/me', { onRequest: app.authenticate }, async (req) => toPublicUser(req.user));

  app.post('/auth/mfa/setup', { onRequest: app.authenticate }, async (req): Promise<MfaSetupResponse> =>
    auth.beginMfaSetup(req.user, ctx(req)),
  );

  app.post('/auth/mfa/enable', { onRequest: app.authenticate, config: credentialLimit }, async (req) => {
    const body = mfaEnableRequest.parse(req.body);
    return toPublicUser(await auth.enableMfa(req.user, body.code, ctx(req)));
  });

  app.post('/auth/mfa/disable', { onRequest: app.authenticate, config: credentialLimit }, async (req) => {
    const body = mfaDisableRequest.parse(req.body);
    return toPublicUser(await auth.disableMfa(req.user, body.code, body.password, ctx(req)));
  });
}
