export class CircuitOpenError extends Error {
  constructor(readonly retryAt: number) {
    super('Circuit open');
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial call is let through. */
  resetMs?: number;
  now?: () => number;
}

/**
 * Classic closed / open / half-open breaker for calls to an upstream service. After repeated
 * failures, calls fail fast instead of piling up behind timeouts; after a pause, one trial
 * call decides whether to close the circuit again.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private readonly threshold: number;
  private readonly resetMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.resetMs = opts.resetMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  get state(): 'closed' | 'open' | 'half_open' {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.resetMs ? 'half_open' : 'open';
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open' || (state === 'half_open' && this.trialInFlight)) {
      throw new CircuitOpenError((this.openedAt ?? this.now()) + this.resetMs);
    }
    const trial = state === 'half_open';
    if (trial) this.trialInFlight = true;
    try {
      const result = await fn();
      this.failures = 0;
      this.openedAt = null;
      return result;
    } catch (err) {
      this.failures += 1;
      if (trial || this.failures >= this.threshold) this.openedAt = this.now();
      throw err;
    } finally {
      if (trial) this.trialInFlight = false;
    }
  }
}
