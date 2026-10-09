import { TIMEFRAME_SECONDS, type Candle, type Timeframe } from '@dta/shared';

/** Open time (Unix seconds, UTC-aligned) of the bar containing `timeMs`. */
export function bucketStart(timeMs: number, timeframe: Timeframe): number {
  const secs = TIMEFRAME_SECONDS[timeframe];
  return Math.floor(timeMs / 1000 / secs) * secs;
}

/** Builds the live bar for one timeframe from trades or smaller bars. */
export class CandleBuilder {
  private current: Candle | null = null;

  constructor(readonly timeframe: Timeframe) {}

  /** Starts from a bar fetched over REST so the live bar keeps what happened before the stream began. */
  seed(candle: Candle | undefined): void {
    if (candle && (!this.current || candle.time >= this.current.time)) this.current = { ...candle };
  }

  addTrade(price: number, size: number, timeMs: number): Candle {
    return this.merge({ time: bucketStart(timeMs, this.timeframe), open: price, high: price, low: price, close: price, volume: size });
  }

  /** Folds a completed smaller bar (e.g. a 1-minute bar) into this timeframe's bar. */
  addBar(bar: Candle): Candle {
    return this.merge({ ...bar, time: bucketStart(bar.time * 1000, this.timeframe) });
  }

  private merge(part: Candle): Candle {
    const c = this.current;
    if (!c || part.time > c.time) {
      this.current = { ...part };
    } else if (part.time === c.time) {
      c.high = Math.max(c.high, part.high);
      c.low = Math.min(c.low, part.low);
      c.close = part.close;
      c.volume += part.volume;
    }
    // Older data than the current bar is ignored.
    return { ...this.current! };
  }
}
