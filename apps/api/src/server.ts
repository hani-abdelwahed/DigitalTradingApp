import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
// family 0: use whichever address family the host resolves to (private networks may be IPv6).
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, family: 0 });
const app = await buildApp({ config, db, redis });
// ioredis reconnects on its own; log connection problems instead of crashing on them.
let lastRedisError = 0;
redis.on('error', (err) => {
  if (Date.now() - lastRedisError < 30_000) return;
  lastRedisError = Date.now();
  app.log.error({ err }, 'Redis connection error');
});
redis.on('ready', () => app.log.info('Redis connected'));

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
