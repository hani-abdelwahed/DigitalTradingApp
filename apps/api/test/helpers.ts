import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { MarketRegistry } from '../src/market/registry.js';
import { SimulatedProvider } from '../src/market/simulated.js';

/** Builds the app against the test database and Redis, resetting both before each test. */
export function useTestApp(): { readonly app: FastifyInstance; readonly sim: SimulatedProvider } {
  // Market data comes from a hand-ticked simulated provider so tests never touch the network.
  const sim = new SimulatedProvider({ autoTick: false, now: () => Date.UTC(2026, 0, 5, 15, 0, 0) });
  const ctx = { sim } as { app: FastifyInstance; sim: SimulatedProvider };
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL);

  beforeAll(async () => {
    await runMigrations(config.DATABASE_URL);
    ctx.app = await buildApp({ config, db, redis, logger: false, market: new MarketRegistry([sim]) });
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

/** Registers a user and returns their access token. */
export async function signUp(app: FastifyInstance, email = 'trader@example.com'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: 'correct horse battery staple' },
  });
  return res.json().accessToken as string;
}
