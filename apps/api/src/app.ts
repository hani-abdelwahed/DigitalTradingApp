import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { ZodError } from 'zod';
import type { ApiError } from '@dta/shared';
import { AuthService, type AccessClaims, type MfaClaims } from './auth/service.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { User } from './db/schema.js';
import { SecretBox } from './lib/crypto.js';
import { HttpError, unauthorized } from './lib/errors.js';
import { MarketHub, MarketRegistry, createMarketRegistry } from './market/index.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import marketWsRoutes from './routes/market-ws.js';
import marketRoutes from './routes/market.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
    redis: Redis;
    auth: AuthService;
    market: MarketRegistry;
    marketHub: MarketHub;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessClaims | MfaClaims;
    user: User;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
  /** Defaults to the providers the config enables. */
  market?: MarketRegistry;
  logger?: boolean;
}

export async function buildApp({ config, db, redis, market, logger = true }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger && {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    trustProxy: config.NODE_ENV === 'production',
    bodyLimit: 64 * 1024,
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);

  await app.register(helmet);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', redis, nameSpace: 'rl:' });

  const signer = { sign: (payload: AccessClaims | MfaClaims, expiresIn: number) => app.jwt.sign(payload, { expiresIn }) };
  app.decorate('auth', new AuthService(db, redis, config, new SecretBox(config.ENCRYPTION_KEY), signer));

  app.decorate('authenticate', async (req: FastifyRequest) => {
    let claims: AccessClaims | MfaClaims;
    try {
      claims = await req.jwtVerify<AccessClaims | MfaClaims>();
    } catch {
      throw unauthorized();
    }
    if (claims.typ !== 'access') throw unauthorized();
    req.user = await app.auth.authenticate(claims);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const body: ApiError = { error: 'validation_error', message: 'Invalid request', details: err.issues };
      return reply.code(400).send(body);
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message } satisfies ApiError);
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'Unhandled error');
      return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' } satisfies ApiError);
    }
    const code = status === 429 ? 'too_many_requests' : 'bad_request';
    return reply.code(status).send({ error: code, message: (err as Error).message } satisfies ApiError);
  });

  const registry = market ?? createMarketRegistry(config, app.log);
  app.decorate('market', registry);
  app.decorate('marketHub', new MarketHub(registry));
  app.addHook('onClose', async () => {
    app.marketHub.close();
    await registry.close();
  });

  await app.register(websocket, { options: { maxPayload: 4096 } });
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(marketRoutes);
  await app.register(marketWsRoutes);
  return app;
}
