import { useState } from 'react';
import type { Instrument, Order, Position } from '@dta/shared';
import { api, errorMessage } from '../api';
import { fmt } from '../market/format';
import { useChannel } from '../market/hooks';
import { useAccount } from './account';
import { TYPE_LABEL } from './OrderForm';

type Tab = 'positions' | 'open' | 'history' | 'fills' | 'balances';

interface Props {
  instruments: Instrument[];
  onSelect: (symbol: string) => void;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function AccountPanel({ instruments, onSelect }: Props) {
  const { portfolio, orders, fills } = useAccount();
  const [tab, setTab] = useState<Tab>('positions');
  const [error, setError] = useState<string | null>(null);
  const inst = (symbol: string) => instruments.find((i) => i.symbol === symbol);
  const dp = (symbol: string) => inst(symbol)?.pricePrecision ?? 2;
  const open = orders.filter((o) => o.status === 'open');
  const closed = orders.filter((o) => o.status !== 'open');

  const cancel = async (o: Order) => {
    setError(null);
    try {
      await api.cancelOrder(o.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const orderPrice = (o: Order) =>
    o.type === 'limit'
      ? `Limit ${fmt(Number(o.limitPrice), dp(o.symbol))}`
      : o.type === 'trailing_stop'
        ? `${o.trailPercent}% trail · stop ${fmt(Number(o.trailStopPrice), dp(o.symbol))}`
        : o.triggerPrice
          ? `Trigger ${fmt(Number(o.triggerPrice), dp(o.symbol))}`
          : 'Market';

  const tabs: [Tab, string][] = [
    ['positions', `Positions (${portfolio?.positions.length ?? 0})`],
    ['open', `Open orders (${open.length})`],
    ['history', 'Order history'],
    ['fills', 'Trades'],
    ['balances', 'Balances'],
  ];

  return (
    <section className="panel account">
      <div className="toolbar">
        <div className="seg" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="error pad">{error}</p>}
      <div className="table-wrap">
        {tab === 'positions' && (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Quantity</th>
                <th>Avg cost</th>
                <th>Last</th>
                <th>Market value</th>
                <th>Unrealised P&amp;L</th>
                <th>Realised P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {portfolio?.positions.map((p) => (
                <PositionRow key={p.symbol} position={p} instrument={inst(p.symbol)} onSelect={onSelect} />
              ))}
            </tbody>
          </table>
        )}
        {tab === 'open' && (
          <table>
            <thead>
              <tr>
                <th>Placed</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Type</th>
                <th>Quantity</th>
                <th>Price</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {open.map((o) => (
                <tr key={o.id}>
                  <td className="muted">{when(o.createdAt)}</td>
                  <td>{o.symbol}</td>
                  <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side}</td>
                  <td>{TYPE_LABEL[o.type]}</td>
                  <td>{o.quantity}</td>
                  <td>{orderPrice(o)}</td>
                  <td>
                    <button className="link small" onClick={() => cancel(o)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'history' && (
          <table>
            <thead>
              <tr>
                <th>Updated</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Type</th>
                <th>Quantity</th>
                <th>Fill price</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((o) => (
                <tr key={o.id}>
                  <td className="muted">{when(o.updatedAt)}</td>
                  <td>{o.symbol}</td>
                  <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side}</td>
                  <td>{TYPE_LABEL[o.type]}</td>
                  <td>{o.quantity}</td>
                  <td>{o.averageFillPrice ? fmt(Number(o.averageFillPrice), dp(o.symbol)) : '—'}</td>
                  <td title={o.reason ?? undefined}>
                    {o.status}
                    {o.reason && o.status === 'rejected' ? `: ${o.reason}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'fills' && (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Quantity</th>
                <th>Price</th>
                <th>Fee</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id}>
                  <td className="muted">{when(f.createdAt)}</td>
                  <td>{f.symbol}</td>
                  <td className={f.side === 'buy' ? 'up' : 'down'}>{f.side}</td>
                  <td>{f.quantity}</td>
                  <td>{fmt(Number(f.price), dp(f.symbol))}</td>
                  <td>
                    {f.fee} {f.feeAsset}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'balances' && (
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Available</th>
                <th>Held by open orders</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {portfolio?.balances.map((b) => (
                <tr key={b.asset}>
                  <td>{b.asset}</td>
                  <td>{b.available}</td>
                  <td>{b.held}</td>
                  <td>{(Number(b.available) + Number(b.held)).toLocaleString('en-US', { maximumFractionDigits: 8 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {((tab === 'positions' && !portfolio?.positions.length) ||
          (tab === 'open' && !open.length) ||
          (tab === 'history' && !closed.length) ||
          (tab === 'fills' && !fills.length)) && <p className="muted small pad">Nothing here yet.</p>}
      </div>
    </section>
  );
}

function PositionRow({ position: p, instrument, onSelect }: { position: Position; instrument?: Instrument; onSelect: (s: string) => void }) {
  const [last, setLast] = useState<number | null>(null);
  useChannel(`ticker:${p.symbol}`, (m) => m.type === 'ticker' && setLast(m.data.last));
  const dp = instrument?.pricePrecision ?? 2;
  const qty = Number(p.quantity);
  const value = last != null ? qty * last : null;
  const unrealized = last != null ? qty * (last - Number(p.averageCost)) : null;
  const realized = Number(p.realizedPnl);
  const cls = (v: number | null) => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');
  return (
    <tr>
      <td>
        <button className="link" onClick={() => onSelect(p.symbol)}>
          {p.symbol}
        </button>
      </td>
      <td>{p.quantity}</td>
      <td>{fmt(Number(p.averageCost), dp)}</td>
      <td>{fmt(last, dp)}</td>
      <td>
        {fmt(value, 2)} {p.quoteAsset}
      </td>
      <td className={cls(unrealized)}>{fmt(unrealized, 2)}</td>
      <td className={cls(realized)}>{fmt(realized, 2)}</td>
    </tr>
  );
}
