import { useEffect, useState } from 'react';
import type { Instrument, Trade } from '@dta/shared';
import { clock, fmt } from '../market/format';
import { useChannel } from '../market/hooks';

const MAX = 40;

export function Trades({ instrument }: { instrument: Instrument }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  useEffect(() => setTrades([]), [instrument.symbol]);
  useChannel(`trades:${instrument.symbol}`, (msg) => {
    if (msg.type === 'trade') setTrades((t) => [msg.data, ...t].slice(0, MAX));
  });

  return (
    <section className="panel trades">
      <h3>Recent trades</h3>
      <div className="book-head muted">
        <span>Price</span>
        <span>Size</span>
        <span>Time</span>
      </div>
      <div className="trade-list">
        {trades.length === 0 && <p className="muted small pad">Waiting for trades…</p>}
        {trades.map((t, i) => (
          <div className="book-row" key={`${t.time}-${i}`}>
            <span className={t.side === 'sell' ? 'down' : t.side === 'buy' ? 'up' : ''}>{fmt(t.price, instrument.pricePrecision)}</span>
            <span>{fmt(t.size, instrument.sizePrecision)}</span>
            <span className="muted">{clock(t.time)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
