import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

/** Builds the app against the test database and Redis, resetting both before each test. */
export function useTestApp(): { readonly app: FastifyInstance } {
  const ctx = {} as { app: FastifyInstance };
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL);

  beforeAll(async () => {
    await runMigrations(config.DATABASE_URL);
    ctx.app = await buildApp({ config, db, redis, logger: false });
    await ctx.app.ready();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table audit_log, sessions, users cascade`);
    await redis.flushdb();
  });

  afterAll(async () => {
    await ctx.app?.close();
    await pool.end();
    await redis.quit();
  });

  return ctx;
}

export function refreshCookie(res: { cookies: { name: string; value: string }[] }): string | undefined {
  return res.cookies.find((c) => c.name === 'dta_refresh')?.value;
}
