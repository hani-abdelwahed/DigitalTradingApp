import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, Instrument, Timeframe } from '@dta/shared';
import { api, errorMessage } from '../api';
import { bollinger, ema, rsi, sma, type Point } from '../market/indicators';
import { useChannel } from '../market/hooks';

export type IndicatorId = 'sma20' | 'ema50' | 'bb20' | 'rsi14';

export const INDICATORS: { id: IndicatorId; label: string }[] = [
  { id: 'sma20', label: 'SMA 20' },
  { id: 'ema50', label: 'EMA 50' },
  { id: 'bb20', label: 'Bollinger 20' },
  { id: 'rsi14', label: 'RSI 14' },
];

const COLORS = { up: '#26a69a', down: '#ef5350', sma: '#f7c948', ema: '#7e57c2', bb: '#4fc3f7', rsi: '#ffa726' };

type LineSeriesApi = ISeriesApi<'Line'>;

interface Props {
  instrument: Instrument;
  timeframe: Timeframe;
  indicators: Set<IndicatorId>;
}

const toTime = (t: number) => t as UTCTimestamp;

// Some environments report locales Intl rejects (e.g. `en-US@posix`), which would crash the chart.
function chartLocale(): string {
  try {
    Intl.NumberFormat(navigator.language);
    return navigator.language;
  } catch {
    return 'en-US';
  }
}
const line = (pts: Point[]) => pts.map((p) => ({ time: toTime(p.time), value: p.value }));

export function Chart({ instrument, timeframe, indicators }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const indicatorSeries = useRef(new Map<IndicatorId, LineSeriesApi[]>());
  const candles = useRef<Candle[]>([]);
  const loaded = useRef(false);
  const buffered = useRef<Candle[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Create the chart once.
  useEffect(() => {
    const c = createChart(container.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#8a8f9c',
        panes: { separatorColor: '#2a2e39' },
      },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { locale: chartLocale() },
    });
    candleSeries.current = c.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });
    volumeSeries.current = c.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
    volumeSeries.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      indicatorSeries.current.clear();
    };
  }, []);

  const redrawIndicators = () => {
    const data = candles.current;
    for (const [id, series] of indicatorSeries.current) {
      if (id === 'sma20') series[0]!.setData(line(sma(data, 20)));
      if (id === 'ema50') series[0]!.setData(line(ema(data, 50)));
      if (id === 'rsi14') series[0]!.setData(line(rsi(data, 14)));
      if (id === 'bb20') {
        const bb = bollinger(data, 20, 2);
        series[0]!.setData(line(bb.upper));
        series[1]!.setData(line(bb.middle));
        series[2]!.setData(line(bb.lower));
      }
    }
  };

  // Add and remove indicator series as toggles change.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const map = indicatorSeries.current;
    for (const [id, series] of map) {
      if (indicators.has(id)) continue;
      for (const s of series) c.removeSeries(s);
      map.delete(id);
    }
    const opts = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    for (const id of indicators) {
      if (map.has(id)) continue;
      if (id === 'sma20') map.set(id, [c.addSeries(LineSeries, { ...opts, color: COLORS.sma })]);
      if (id === 'ema50') map.set(id, [c.addSeries(LineSeries, { ...opts, color: COLORS.ema })]);
      if (id === 'bb20') {
        map.set(id, [
          c.addSeries(LineSeries, { ...opts, color: COLORS.bb }),
          c.addSeries(LineSeries, { ...opts, color: COLORS.bb, lineStyle: 2 }),
          c.addSeries(LineSeries, { ...opts, color: COLORS.bb }),
        ]);
      }
      if (id === 'rsi14') {
        const s = c.addSeries(LineSeries, { ...opts, color: COLORS.rsi, lastValueVisible: true }, 1);
        s.createPriceLine({ price: 70, color: '#555', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: '' });
        s.createPriceLine({ price: 30, color: '#555', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: '' });
        c.panes()[1]?.setHeight(120);
        map.set(id, [s]);
      }
    }
    redrawIndicators();
  }, [indicators]);

  const volumeBar = (c: Candle) => ({
    time: toTime(c.time),
    value: c.volume,
    color: c.close >= c.open ? 'rgba(38,166,154,0.4)' : 'rgba(239,83,80,0.4)',
  });

  const applyLive = (c: Candle) => {
    const data = candles.current;
    const last = data[data.length - 1];
    if (last && c.time < last.time) return;
    if (last && c.time === last.time) data[data.length - 1] = c;
    else data.push(c);
    candleSeries.current!.update({ ...c, time: toTime(c.time) });
    volumeSeries.current!.update(volumeBar(c));
    redrawIndicators();
  };

  // Load history whenever the instrument or timeframe changes.
  useEffect(() => {
    let cancelled = false;
    loaded.current = false;
    buffered.current = [];
    candles.current = [];
    setError(null);
    const p = instrument.pricePrecision;
    candleSeries.current!.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: 10 ** -p } });
    candleSeries.current!.setData([]);
    volumeSeries.current!.setData([]);
    api
      .candles(instrument.symbol, timeframe)
      .then((data) => {
        if (cancelled) return;
        candles.current = data;
        candleSeries.current!.setData(data.map((c) => ({ ...c, time: toTime(c.time) })));
        volumeSeries.current!.setData(data.map(volumeBar));
        loaded.current = true;
        // Live candles that arrived while history was loading.
        for (const c of buffered.current) applyLive(c);
        buffered.current = [];
        redrawIndicators();
        chart.current!.timeScale().scrollToRealTime();
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [instrument, timeframe]);

  useChannel(`candles:${instrument.symbol}:${timeframe}`, (msg) => {
    if (msg.type !== 'candle') return;
    if (loaded.current) applyLive(msg.data);
    else buffered.current.push(msg.data);
  });

  return (
    <div className="chart">
      <div ref={container} className="chart-canvas" />
      {error && <div className="chart-error">{error}</div>}
    </div>
  );
}
