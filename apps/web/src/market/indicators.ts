import type { Candle } from '@dta/shared';

export interface Point {
  time: number;
  value: number;
}

/** Simple moving average of closes. */
export function sma(candles: Candle[], period: number): Point[] {
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i]!.close;
    if (i >= period) sum -= candles[i - period]!.close;
    if (i >= period - 1) out.push({ time: candles[i]!.time, value: sum / period });
  }
  return out;
}

/** Exponential moving average of closes, seeded with the SMA of the first `period` bars. */
export function ema(candles: Candle[], period: number): Point[] {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  let value = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  const out: Point[] = [{ time: candles[period - 1]!.time, value }];
  for (let i = period; i < candles.length; i++) {
    value = candles[i]!.close * k + value * (1 - k);
    out.push({ time: candles[i]!.time, value });
  }
  return out;
}

/** Bollinger Bands: SMA ± `mult` population standard deviations. */
export function bollinger(candles: Candle[], period = 20, mult = 2): { upper: Point[]; middle: Point[]; lower: Point[] } {
  const upper: Point[] = [];
  const middle: Point[] = [];
  const lower: Point[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1).map((c) => c.close);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    const time = candles[i]!.time;
    middle.push({ time, value: mean });
    upper.push({ time, value: mean + mult * sd });
    lower.push({ time, value: mean - mult * sd });
  }
  return { upper, middle, lower };
}

/** Relative Strength Index with Wilder's smoothing. */
export function rsi(candles: Candle[], period = 14): Point[] {
  if (candles.length <= period) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  const out: Point[] = [{ time: candles[period]!.time, value: value() }];
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out.push({ time: candles[i]!.time, value: value() });
  }
  return out;
}
