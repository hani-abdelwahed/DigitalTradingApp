import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const CHECK_TIMEOUT_MS = 3_000;

/** Fails a check that hangs, e.g. while a connection is still being retried. */
function within<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS).unref()),
  ]);
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const [db, redis] = await Promise.allSettled([within(app.db.execute(sql`select 1`)), within(app.redis.ping())]);
    const ok = db.status === 'fulfilled' && redis.status === 'fulfilled';
    reply.code(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'degraded',
      checks: { database: db.status === 'fulfilled', redis: redis.status === 'fulfilled' },
    };
  });
}
