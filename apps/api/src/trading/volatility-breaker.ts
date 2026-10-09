export interface BreakerOptions {
  /** Price move, in percent, that trips the breaker. 0 turns it off. */
  percent: number;
  /** How far back the move is measured. */
  windowMs: number;
  /** How long trading in the symbol stays paused once tripped. */
  haltMs: number;
}

export interface AutomaticHalt {
  symbol: string;
  until: number;
  reason: string;
}

interface Bucket {
  second: number;
  min: number;
  max: number;
}

/**
 * Volatility circuit breaker, in the spirit of exchange limit-up/limit-down rules: when a
 * symbol's price moves more than `percent` within the window, trading in it pauses for a while
 * so stops do not fire into a crash and market orders do not chase a spike.
 */
export class VolatilityBreaker {
  // Per-second high and low, so memory stays bounded however busy the feed is.
  private readonly windows = new Map<string, Bucket[]>();
  private readonly halts = new Map<string, AutomaticHalt>();

  constructor(
    private readonly opts: BreakerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a price. Returns the new halt if this price tripped the breaker. */
  record(symbol: string, price: number): AutomaticHalt | null {
    if (!this.opts.percent || !(price > 0)) return null;
    const at = this.now();
    if (this.haltFor(symbol)) return null;

    const second = Math.floor(at / 1000);
    const from = Math.floor((at - this.opts.windowMs) / 1000);
    const buckets = (this.windows.get(symbol) ?? []).filter((b) => b.second > from);
    let min = price;
    let max = price;
    for (const b of buckets) {
      if (b.min < min) min = b.min;
      if (b.max > max) max = b.max;
    }
    const rise = ((price - min) / min) * 100;
    const fall = ((max - price) / max) * 100;
    if (rise > this.opts.percent || fall > this.opts.percent) {
      const move = rise > fall ? `rose ${rise.toFixed(1)}%` : `fell ${fall.toFixed(1)}%`;
      const halt: AutomaticHalt = {
        symbol,
        until: at + this.opts.haltMs,
        reason: `The price ${move} within ${duration(this.opts.windowMs)}`,
      };
      this.halts.set(symbol, halt);
      // Measure afresh from the price trading resumes at.
      this.windows.delete(symbol);
      return halt;
    }

    const last = buckets.at(-1);
    if (last?.second === second) {
      last.min = Math.min(last.min, price);
      last.max = Math.max(last.max, price);
    } else {
      buckets.push({ second, min: price, max: price });
    }
    this.windows.set(symbol, buckets);
    return null;
  }

  haltFor(symbol: string): AutomaticHalt | null {
    const h = this.halts.get(symbol);
    if (!h) return null;
    if (h.until > this.now()) return h;
    this.halts.delete(symbol);
    return null;
  }

  list(): AutomaticHalt[] {
    return [...this.halts.keys()].map((s) => this.haltFor(s)).filter((h): h is AutomaticHalt => h !== null);
  }

  /** Forgets all history and halts (tests use this between cases). */
  reset(): void {
    this.windows.clear();
    this.halts.clear();
  }
}

function duration(ms: number): string {
  if (ms % 60_000 === 0) return ms === 60_000 ? '1 minute' : `${ms / 60_000} minutes`;
  return `${Math.round(ms / 1000)} seconds`;
}
