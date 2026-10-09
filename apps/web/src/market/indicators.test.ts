import type { Candle } from '@dta/shared';
import { describe, expect, it } from 'vitest';
import { bollinger, ema, rsi, sma } from './indicators';

const bars = (closes: number[]): Candle[] =>
  closes.map((close, i) => ({ time: i * 60, open: close, high: close, low: close, close, volume: 1 }));

describe('indicators', () => {
  it('sma', () => {
    expect(sma(bars([1, 2, 3, 4, 5]), 3).map((p) => p.value)).toEqual([2, 3, 4]);
  });

  it('ema seeds with the sma and then smooths', () => {
    const out = ema(bars([1, 2, 3, 4, 5]), 3).map((p) => p.value);
    expect(out[0]).toBe(2);
    expect(out[1]).toBeCloseTo(3); // 4*0.5 + 2*0.5
    expect(out[2]).toBeCloseTo(4); // 5*0.5 + 3*0.5
  });

  it('bollinger bands are symmetric around the sma', () => {
    const { upper, middle, lower } = bollinger(bars([2, 4, 4, 4, 5, 5, 7, 9]), 8, 2);
    expect(middle[0]!.value).toBe(5);
    expect(upper[0]!.value).toBe(9); // population sd = 2
    expect(lower[0]!.value).toBe(1);
  });

  it('rsi is 100 for only gains, 0 for only losses, and matches a reference series', () => {
    expect(rsi(bars([1, 2, 3, 4, 5, 6]), 3).every((p) => p.value === 100)).toBe(true);
    expect(rsi(bars([6, 5, 4, 3, 2, 1]), 3).every((p) => p.value === 0)).toBe(true);
    // StockCharts' RSI worked example: first 14-period RSI = 70.53.
    const closes = [
      44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614,
      46.282, 46.282,
    ];
    expect(rsi(bars(closes), 14)[0]!.value).toBeCloseTo(70.53, 1);
  });
});
