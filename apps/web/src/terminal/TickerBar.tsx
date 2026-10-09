import { useState } from 'react';
import type { Instrument, Ticker } from '@dta/shared';
import { compact, fmt } from '../market/format';
import { useChannel, useSocketStatus } from '../market/hooks';

interface Props {
  instruments: Instrument[];
  instrument: Instrument;
  onSelect: (symbol: string) => void;
}

const VENUE_LABEL = { binance: 'Binance', alpaca: 'Alpaca (IEX)', simulated: 'Simulated prices' } as const;

export function TickerBar({ instruments, instrument, onSelect }: Props) {
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const status = useSocketStatus();
  useChannel(`ticker:${instrument.symbol}`, (msg) => msg.type === 'ticker' && setTicker(msg.data));
  const t = ticker?.symbol === instrument.symbol ? ticker : null;
  const p = instrument.pricePrecision;
  const dir = t?.change24h == null ? '' : t.change24h >= 0 ? 'up' : 'down';

  return (
    <div className="tickerbar">
      <select value={instrument.symbol} onChange={(e) => onSelect(e.target.value)} aria-label="Instrument">
        {(['crypto', 'equity'] as const).map((cls) => (
          <optgroup key={cls} label={cls === 'crypto' ? 'Crypto' : 'Stocks & ETFs'}>
            {instruments
              .filter((i) => i.assetClass === cls)
              .map((i) => (
                <option key={i.symbol} value={i.symbol}>
                  {i.symbol} · {i.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <div className="stat">
        <span className={`last ${dir}`}>{fmt(t?.last, p)}</span>
      </div>
      <div className="stat">
        <span className="muted small">Change</span>
        <span className={dir}>
          {fmt(t?.change24h, p)} ({fmt(t?.changePct24h, 2)}%)
        </span>
      </div>
      <div className="stat">
        <span className="muted small">High</span>
        <span>{fmt(t?.high24h, p)}</span>
      </div>
      <div className="stat">
        <span className="muted small">Low</span>
        <span>{fmt(t?.low24h, p)}</span>
      </div>
      <div className="stat">
        <span className="muted small">Volume</span>
        <span>{compact(t?.volume24h)}</span>
      </div>
      <div className="stat venue">
        <span className={`badge ${instrument.venue === 'simulated' ? 'warn' : 'off'}`}>{VENUE_LABEL[instrument.venue]}</span>
        <span className={`dot ${status}`} title={status === 'live' ? 'Live' : 'Reconnecting'} />
      </div>
    </div>
  );
}
