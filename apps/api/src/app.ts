import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { ZodError } from 'zod';
import type { ApiError, ApiKeyScope } from '@dta/shared';
import { ApiKeyService, SESSION_PRINCIPAL, isApiKey, type Principal } from './auth/api-keys.js';
import { AuthService, type AccessClaims, type MfaClaims } from './auth/service.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { User } from './db/schema.js';
import { SecretBox } from './lib/crypto.js';
import { HttpError, forbidden, unauthorized } from './lib/errors.js';
import { MarketHub, MarketRegistry, createMarketRegistry } from './market/index.js';
import apiKeyRoutes from './routes/api-keys.js';
import authRoutes from './routes/auth.js';
import tradingRoutes from './routes/trading.js';
import { HaltStore } from './trading/halts.js';
import { TradingService } from './trading/service.js';
import { VolatilityBreaker } from './trading/volatility-breaker.js';
import healthRoutes from './routes/health.js';
import marketWsRoutes from './routes/market-ws.js';
import marketRoutes from './routes/market.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
    redis: Redis;
    auth: AuthService;
    apiKeys: ApiKeyService;
    market: MarketRegistry;
    marketHub: MarketHub;
    trading: TradingService;
    /** Signed-in users only (access token); API keys are refused. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Signed-in users, or API keys that carry `scope`. */
    authorize: (scope: ApiKeyScope) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    principal: Principal;
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
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    trustProxy: config.TRUST_PROXY,
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

  app.decorate('apiKeys', new ApiKeyService(db, app.auth));
  app.decorateRequest('principal', null as unknown as Principal);

  /** An API key from `X-API-Key` or `Authorization: Bearer dta_…`, if one was sent. */
  function presentedApiKey(req: FastifyRequest): string | undefined {
    const header = req.headers['x-api-key'];
    if (typeof header === 'string') return header;
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    return bearer && isApiKey(bearer) ? bearer : undefined;
  }

  async function authenticateSession(req: FastifyRequest): Promise<void> {
    let claims: AccessClaims | MfaClaims;
    try {
      claims = await req.jwtVerify<AccessClaims | MfaClaims>();
    } catch {
      throw unauthorized();
    }
    if (claims.typ !== 'access') throw unauthorized();
    req.user = await app.auth.authenticate(claims);
    req.principal = SESSION_PRINCIPAL;
  }

  app.decorate('authenticate', async (req: FastifyRequest) => {
    if (presentedApiKey(req)) throw forbidden('session_required', 'API keys cannot be used for this; sign in instead');
    await authenticateSession(req);
  });

  app.decorate('authorize', (scope: ApiKeyScope) => async (req: FastifyRequest) => {
    const key = presentedApiKey(req);
    if (!key) return authenticateSession(req);
    const { user, key: row } = await app.apiKeys.authenticate(key);
    if (!row.scopes.includes(scope)) throw forbidden('insufficient_scope', `This API key does not have the ${scope} permission`);
    req.user = user;
    req.principal = { kind: 'api_key', scopes: row.scopes, apiKeyId: row.id };
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
  app.decorate(
    'trading',
    new TradingService(db, registry, app.log, {
      limits: {
        maxOrderNotional: config.MAX_ORDER_NOTIONAL,
        maxOpenOrders: config.MAX_OPEN_ORDERS,
        priceBandPercent: config.PRICE_BAND_PERCENT,
      },
      breaker: new VolatilityBreaker({
        percent: config.CIRCUIT_BREAKER_PERCENT,
        windowMs: config.CIRCUIT_BREAKER_WINDOW_SECONDS * 1000,
        haltMs: config.CIRCUIT_BREAKER_HALT_SECONDS * 1000,
      }),
      halts: new HaltStore(redis),
    }),
  );
  app.addHook('onReady', () => app.trading.start());
  app.addHook('onClose', async () => {
    app.trading.stop();
    app.marketHub.close();
    await registry.close();
  });

  await app.register(websocket, { options: { maxPayload: 4096 } });
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(apiKeyRoutes);
  await app.register(marketRoutes);
  await app.register(marketWsRoutes);
  await app.register(tradingRoutes);

  if (config.WEB_DIST_DIR) {
    const root = resolve(config.WEB_DIST_DIR);
    await app.register(fastifyStatic, { root, wildcard: false, index: 'index.html' });
    // Hashed asset files never change, so browsers may keep them; index.html must stay fresh.
    app.addHook('onSend', async (req, reply) => {
      if (req.url.startsWith('/assets/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
    });
    // Client-side routes load the app; anything else unknown stays a JSON 404.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found', message: 'Not found' } satisfies ApiError);
    });
  }
  return app;
}
