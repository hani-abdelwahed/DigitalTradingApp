/**
 * Operator kill switch for trading.
 *
 *   pnpm --filter @dta/api halt list
 *   pnpm --filter @dta/api halt on all "Exchange incident"
 *   pnpm --filter @dta/api halt on BTC-USDT "Bad prints from the feed"
 *   pnpm --filter @dta/api halt off BTC-USDT
 *
 * A halt blocks new orders and stops open orders from triggering; cancelling still works.
 * Every API instance picks it up within a second.
 */
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { HaltStore } from '../trading/halts.js';

const [command, target, ...reasonWords] = process.argv.slice(2);
const usage = 'Usage: halt list | halt on <SYMBOL|all> <reason> | halt off <SYMBOL|all>';

const config = loadConfig();
const redis = new Redis(config.REDIS_URL);
const { db, pool } = createDb(config.DATABASE_URL);
const halts = new HaltStore(redis);
const symbol = target === 'all' ? null : (target?.toUpperCase() ?? null);

try {
  if (command === 'list') {
    const list = await halts.refresh();
    if (!list.length) console.log('No manual halts.');
    for (const h of list) console.log(`${h.symbol ?? 'ALL'}\t${h.at}\t${h.reason}`);
  } else if (command === 'on' && target && reasonWords.length) {
    const reason = reasonWords.join(' ');
    await halts.set(symbol, reason);
    await db.insert(auditLog).values({ event: 'trading_halted', userId: null, metadata: { symbol, reason } });
    console.log(`Halted ${symbol ?? 'all trading'}: ${reason}`);
  } else if (command === 'off' && target) {
    const removed = await halts.clear(symbol);
    if (removed) await db.insert(auditLog).values({ event: 'trading_resumed', userId: null, metadata: { symbol } });
    console.log(removed ? `Resumed ${symbol ?? 'all trading'}` : `No halt on ${symbol ?? 'all trading'}`);
  } else {
    console.error(usage);
    process.exitCode = 1;
  }
} finally {
  await redis.quit();
  await pool.end();
}
