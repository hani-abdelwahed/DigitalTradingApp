import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const [db, redis] = await Promise.allSettled([app.db.execute(sql`select 1`), app.redis.ping()]);
    const ok = db.status === 'fulfilled' && redis.status === 'fulfilled';
    reply.code(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'degraded',
      checks: { database: db.status === 'fulfilled', redis: redis.status === 'fulfilled' },
    };
  });
}
