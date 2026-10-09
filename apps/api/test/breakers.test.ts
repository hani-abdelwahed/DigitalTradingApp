import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/lib/circuit-breaker.js';
import { VolatilityBreaker } from '../src/trading/volatility-breaker.js';

describe('VolatilityBreaker', () => {
  it('trips on a move beyond the threshold within the window, then resets after the halt', () => {
    let now = 0;
    const b = new VolatilityBreaker({ percent: 10, windowMs: 60_000, haltMs: 30_000 }, () => now);
    expect(b.record('X', 100)).toBeNull();
    now = 20_000;
    expect(b.record('X', 109)).toBeNull();
    now = 40_000;
    expect(b.record('X', 111)).toMatchObject({ symbol: 'X', until: 70_000, reason: 'The price rose 11.0% within 1 minute' });
    expect(b.haltFor('X')).not.toBeNull();
    expect(b.list()).toHaveLength(1);
    now = 70_000;
    expect(b.haltFor('X')).toBeNull();
    // History starts again from the resumed price.
    expect(b.record('X', 111)).toBeNull();
  });

  it('only measures moves within the window', () => {
    let now = 0;
    const b = new VolatilityBreaker({ percent: 10, windowMs: 60_000, haltMs: 30_000 }, () => now);
    b.record('X', 100);
    now = 61_000;
    expect(b.record('X', 89)).toBeNull();
  });

  it('can be turned off', () => {
    const b = new VolatilityBreaker({ percent: 0, windowMs: 60_000, haltMs: 30_000 });
    b.record('X', 100);
    expect(b.record('X', 1)).toBeNull();
  });
});

describe('CircuitBreaker', () => {
  it('opens after repeated failures, fails fast, and closes after a successful trial', async () => {
    let now = 0;
    const cb = new CircuitBreaker({ failureThreshold: 2, resetMs: 1_000, now: () => now });
    const fail = () => Promise.reject(new Error('down'));
    let calls = 0;
    const ok = async () => {
      calls++;
      return 'ok';
    };

    await expect(cb.run(fail)).rejects.toThrow('down');
    await expect(cb.run(fail)).rejects.toThrow('down');
    expect(cb.state).toBe('open');
    await expect(cb.run(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(0);

    now = 1_000;
    expect(cb.state).toBe('half_open');
    await expect(cb.run(fail)).rejects.toThrow('down');
    expect(cb.state).toBe('open'); // a failed trial reopens straight away

    now = 2_000;
    await expect(cb.run(ok)).resolves.toBe('ok');
    expect(cb.state).toBe('closed');
  });
});
