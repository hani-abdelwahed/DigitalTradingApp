import { describe, expect, it } from 'vitest';
import { CandleBuilder, bucketStart } from '../src/market/candles.js';

const t = (iso: string) => Date.parse(iso);

describe('bucketStart', () => {
  it('aligns to UTC bar boundaries', () => {
    expect(bucketStart(t('2026-01-05T15:07:42Z'), '5m')).toBe(t('2026-01-05T15:05:00Z') / 1000);
    expect(bucketStart(t('2026-01-05T15:07:42Z'), '4h')).toBe(t('2026-01-05T12:00:00Z') / 1000);
    expect(bucketStart(t('2026-01-05T23:59:59Z'), '1d')).toBe(t('2026-01-05T00:00:00Z') / 1000);
  });
});

describe('CandleBuilder', () => {
  it('builds OHLCV from trades and starts a new bar at the boundary', () => {
    const b = new CandleBuilder('1m');
    b.addTrade(100, 1, t('2026-01-05T15:00:01Z'));
    b.addTrade(105, 2, t('2026-01-05T15:00:20Z'));
    expect(b.addTrade(98, 3, t('2026-01-05T15:00:59Z'))).toEqual({
      time: t('2026-01-05T15:00:00Z') / 1000,
      open: 100,
      high: 105,
      low: 98,
      close: 98,
      volume: 6,
    });
    expect(b.addTrade(99, 1, t('2026-01-05T15:01:00Z'))).toMatchObject({ open: 99, volume: 1 });
  });

  it('folds 1-minute bars into a larger timeframe', () => {
    const b = new CandleBuilder('5m');
    const min = (m: number, o: number, h: number, l: number, c: number) => ({
      time: t(`2026-01-05T15:0${m}:00Z`) / 1000, open: o, high: h, low: l, close: c, volume: 10,
    });
    b.addBar(min(0, 10, 12, 9, 11));
    expect(b.addBar(min(1, 11, 15, 10, 14))).toEqual({
      time: t('2026-01-05T15:00:00Z') / 1000, open: 10, high: 15, low: 9, close: 14, volume: 20,
    });
  });

  it('continues from a seeded bar and ignores older data', () => {
    const b = new CandleBuilder('1h');
    const time = t('2026-01-05T15:00:00Z') / 1000;
    b.seed({ time, open: 50, high: 60, low: 40, close: 55, volume: 100 });
    expect(b.addTrade(65, 1, t('2026-01-05T15:30:00Z'))).toEqual({ time, open: 50, high: 65, low: 40, close: 65, volume: 101 });
    expect(b.addTrade(1, 1, t('2026-01-05T14:59:00Z'))).toMatchObject({ time, close: 65 });
  });
});
