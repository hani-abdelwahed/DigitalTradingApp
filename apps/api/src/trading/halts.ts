import type { Redis } from 'ioredis';

const KEY = 'trading:halts';
/** Hash field for a halt on everything. */
const ALL = '*';
const REFRESH_MS = 1_000;

export interface ManualHalt {
  /** null when all trading is halted. */
  symbol: string | null;
  reason: string;
  at: string;
}

/**
 * Operator-controlled trading halts ("kill switch"), kept in Redis so every API instance
 * honours them. Checks on the hot path read a copy refreshed every second.
 */
export class HaltStore {
  private cache = new Map<string, ManualHalt>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly redis: Redis) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh().catch(() => {}), REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<ManualHalt[]> {
    const raw = await this.redis.hgetall(KEY);
    const next = new Map<string, ManualHalt>();
    for (const [field, value] of Object.entries(raw)) {
      try {
        next.set(field, JSON.parse(value) as ManualHalt);
      } catch {
        // Ignore a malformed entry rather than halting the check.
      }
    }
    this.cache = next;
    return [...next.values()];
  }

  /** The halt that applies to `symbol` (its own, or a halt on everything), from the cached copy. */
  haltFor(symbol: string): ManualHalt | null {
    return this.cache.get(ALL) ?? this.cache.get(symbol) ?? null;
  }

  async set(symbol: string | null, reason: string): Promise<ManualHalt> {
    const halt: ManualHalt = { symbol, reason, at: new Date().toISOString() };
    await this.redis.hset(KEY, symbol ?? ALL, JSON.stringify(halt));
    await this.refresh();
    return halt;
  }

  async clear(symbol: string | null): Promise<boolean> {
    const removed = await this.redis.hdel(KEY, symbol ?? ALL);
    await this.refresh();
    return removed > 0;
  }
}
