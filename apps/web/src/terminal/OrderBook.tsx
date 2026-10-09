import { useState } from 'react';
import type { Instrument, OrderBook as Book } from '@dta/shared';
import { fmt } from '../market/format';
import { useChannel } from '../market/hooks';

const ROWS = 10;

export function OrderBook({ instrument }: { instrument: Instrument }) {
  const [book, setBook] = useState<Book | null>(null);
  const channel = `book:${instrument.symbol}`;
  useChannel(channel, (msg) => msg.type === 'book' && setBook(msg.data));
  const current = book?.symbol === instrument.symbol ? book : null;

  const p = instrument.pricePrecision;
  const s = instrument.sizePrecision;
  const asks = (current?.asks ?? []).slice(0, ROWS);
  const bids = (current?.bids ?? []).slice(0, ROWS);
  const cum = (levels: [number, number][]) => {
    let t = 0;
    return levels.map(([, size]) => (t += size));
  };
  const askCum = cum(asks);
  const bidCum = cum(bids);
  const max = Math.max(askCum.at(-1) ?? 0, bidCum.at(-1) ?? 0) || 1;
  const spread = asks[0] && bids[0] ? asks[0][0] - bids[0][0] : null;
  const mid = asks[0] && bids[0] ? (asks[0][0] + bids[0][0]) / 2 : null;

  const row = (side: 'ask' | 'bid', [price, size]: [number, number], total: number) => (
    <div className={`book-row ${side}`} key={`${side}${price}`}>
      <div className="depth" style={{ width: `${(total / max) * 100}%` }} />
      <span className="price">{fmt(price, p)}</span>
      <span>{fmt(size, s)}</span>
      <span className="muted">{fmt(total, s)}</span>
    </div>
  );

  return (
    <section className="panel book">
      <h3>Order book</h3>
      <div className="book-head muted">
        <span>Price</span>
        <span>Size</span>
        <span>Total</span>
      </div>
      {!current && <p className="muted small pad">Waiting for data…</p>}
      <div className="book-side asks">{asks.map((l, i) => row('ask', l, askCum[i]!)).reverse()}</div>
      {current && (
        <div className="book-spread">
          <strong>{fmt(mid, p)}</strong>
          <span className="muted small">
            Spread {fmt(spread, p)} ({mid ? fmt(((spread ?? 0) / mid) * 10_000, 1) : '—'} bps)
          </span>
        </div>
      )}
      <div className="book-side">{bids.map((l, i) => row('bid', l, bidCum[i]!))}</div>
      {current && asks.length === 1 && <p className="muted small pad">Top of book only for this feed.</p>}
    </section>
  );
}
