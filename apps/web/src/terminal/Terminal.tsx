import { useEffect, useMemo, useState } from 'react';
import { TIMEFRAMES, type Instrument, type Timeframe } from '@dta/shared';
import { api, errorMessage, marketSocketUrl } from '../api';
import { MarketSocketContext } from '../market/hooks';
import { MarketSocket } from '../market/socket';
import { Chart, INDICATORS, type IndicatorId } from './Chart';
import { OrderBook } from './OrderBook';
import { TickerBar } from './TickerBar';
import { Trades } from './Trades';

const PREFS_KEY = 'dta.terminal';

interface Prefs {
  symbol: string;
  timeframe: Timeframe;
  indicators: IndicatorId[];
}

function loadPrefs(): Prefs {
  const defaults: Prefs = { symbol: 'BTC-USDT', timeframe: '15m', indicators: ['sma20'] };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

export function Terminal() {
  const [socket, setSocket] = useState<MarketSocket | null>(null);
  const [instruments, setInstruments] = useState<Instrument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState(loadPrefs);

  useEffect(() => {
    const s = new MarketSocket(marketSocketUrl());
    setSocket(s);
    return () => s.close();
  }, []);

  useEffect(() => {
    api.instruments().then(setInstruments, (err) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Storage can be unavailable (private mode); preferences then last only for this visit.
    }
  }, [prefs]);

  const indicators = useMemo(() => new Set(prefs.indicators), [prefs.indicators]);
  const instrument = instruments?.find((i) => i.symbol === prefs.symbol) ?? instruments?.[0];

  if (error) return <p className="error pad">{error}</p>;
  if (!socket || !instrument) return <p className="muted pad">Loading markets…</p>;

  const toggle = (id: IndicatorId) =>
    setPrefs((p) => ({
      ...p,
      indicators: p.indicators.includes(id) ? p.indicators.filter((x) => x !== id) : [...p.indicators, id],
    }));

  return (
    <MarketSocketContext.Provider value={socket}>
      <div className="terminal">
        <TickerBar instruments={instruments!} instrument={instrument} onSelect={(symbol) => setPrefs((p) => ({ ...p, symbol }))} />
        <section className="panel chart-panel">
          <div className="toolbar">
            <div className="seg" role="group" aria-label="Timeframe">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  className={tf === prefs.timeframe ? 'active' : ''}
                  onClick={() => setPrefs((p) => ({ ...p, timeframe: tf }))}
                >
                  {tf}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Indicators">
              {INDICATORS.map((ind) => (
                <button key={ind.id} className={indicators.has(ind.id) ? 'active' : ''} onClick={() => toggle(ind.id)}>
                  {ind.label}
                </button>
              ))}
            </div>
          </div>
          <Chart instrument={instrument} timeframe={prefs.timeframe} indicators={indicators} />
        </section>
        <div className="side">
          <OrderBook instrument={instrument} />
          <Trades instrument={instrument} />
        </div>
        <section className="panel order-entry">
          <h3>Order entry</h3>
          <p className="muted small">Buy and sell orders arrive in step 3.</p>
        </section>
      </div>
    </MarketSocketContext.Provider>
  );
}
