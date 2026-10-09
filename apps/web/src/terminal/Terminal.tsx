import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { TIMEFRAMES, type Instrument, type Timeframe } from '@dta/shared';
import { api, errorMessage, marketSocketUrl } from '../api';
import { MarketSocketContext } from '../market/hooks';
import { MarketSocket } from '../market/socket';
import { AccountContext, useAccountState } from './account';
import { AccountPanel } from './AccountPanel';
import { Chart, INDICATORS, type IndicatorId } from './Chart';
import { OrderForm } from './OrderForm';
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

  const select = (symbol: string) => setPrefs((p) => ({ ...p, symbol }));

  return (
    <MarketSocketContext.Provider value={socket}>
      <AccountProvider>
        <div className="terminal">
          <TickerBar instruments={instruments!} instrument={instrument} onSelect={select} />
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
          <div className="entry">
            <OrderForm instrument={instrument} />
          </div>
          <AccountPanel instruments={instruments!} onSelect={select} />
        </div>
      </AccountProvider>
    </MarketSocketContext.Provider>
  );
}

/** Account state needs the market socket, so it lives inside the socket provider. */
function AccountProvider({ children }: { children: ReactNode }) {
  const account = useAccountState();
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}
