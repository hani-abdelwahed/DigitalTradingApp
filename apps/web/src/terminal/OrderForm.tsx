import { useEffect, useState, type FormEvent } from 'react';
import {
  DEFAULT_MAX_SLIPPAGE_PERCENT,
  ORDER_TYPES,
  type Instrument,
  type OrderSide,
  type OrderType,
  type PlaceOrderRequest,
  type Ticker,
  type TradingHalt,
} from '@dta/shared';
import { api, errorMessage } from '../api';
import { fmt } from '../market/format';
import { useChannel } from '../market/hooks';
import { useAccount } from './account';

export const TYPE_LABEL: Record<OrderType, string> = {
  market: 'Market',
  limit: 'Limit',
  stop_loss: 'Stop-loss',
  take_profit: 'Take-profit',
  trailing_stop: 'Trailing stop',
};

const TYPE_HELP: Record<OrderType, string> = {
  market: 'Fills now at the best available price.',
  limit: 'Fills only at your price or better.',
  stop_loss: 'Becomes a market order if the price moves against you to the trigger.',
  take_profit: 'Becomes a market order once the price reaches your target.',
  trailing_stop: 'A stop that follows the price by a set percentage and fills on a pullback.',
};

const FEE = { crypto: 0.001, equity: 0 } as const;
const HALT_POLL_MS = 15_000;

/** Trading halts that apply to `symbol`, polled while the form is open. */
function useHalt(symbol: string): TradingHalt | null {
  const [halts, setHalts] = useState<TradingHalt[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void api.halts().then((h) => live && setHalts(h)).catch(() => undefined);
    load();
    const t = setInterval(load, HALT_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return halts.find((h) => h.symbol === null) ?? halts.find((h) => h.symbol === symbol) ?? null;
}

/** Trims a number to `dp` decimals without exponent notation or trailing zeros. */
function toInput(v: number, dp: number): string {
  const s = v.toFixed(dp);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function OrderForm({ instrument }: { instrument: Instrument }) {
  const { portfolio, refresh } = useAccount();
  const [side, setSide] = useState<OrderSide>('buy');
  const [type, setType] = useState<OrderType>('market');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [trail, setTrail] = useState('2');
  const [slippage, setSlippage] = useState(DEFAULT_MAX_SLIPPAGE_PERCENT);
  const halt = useHalt(instrument.symbol);
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useChannel(`ticker:${instrument.symbol}`, (m) => m.type === 'ticker' && setTicker(m.data));
  useEffect(() => {
    setTicker(null);
    setQuantity('');
    setPrice('');
    setResult(null);
  }, [instrument.symbol]);

  const t = ticker?.symbol === instrument.symbol ? ticker : null;
  const balance = (asset: string) => Number(portfolio?.balances.find((b) => b.asset === asset)?.available ?? 0);
  const availableQuote = balance(instrument.quote);
  const availableBase = balance(instrument.base);
  const marketPrice = side === 'buy' ? (t?.ask ?? t?.last) : (t?.bid ?? t?.last);
  const needsPrice = type === 'limit' || type === 'stop_loss' || type === 'take_profit';
  const estPrice = needsPrice && Number(price) > 0 ? Number(price) : marketPrice;
  const qty = Number(quantity) || 0;
  const notional = estPrice ? qty * estPrice : null;
  const fee = notional != null ? notional * FEE[instrument.assetClass] : null;

  function fillPercent(pct: number) {
    const dp = instrument.sizePrecision;
    const step = 10 ** -dp;
    const raw =
      side === 'sell'
        ? availableBase * pct
        : estPrice
          ? // The server reserves the worst accepted price, so size the order to fit that.
            (availableQuote * pct) /
            (estPrice *
              (1 + FEE[instrument.assetClass]) *
              (type === 'limit' ? 1 : 1 + (Number(slippage) || 0) / 100) *
              (type === 'trailing_stop' ? 1 + (Number(trail) || 0) / 100 : 1))
          : 0;
    setQuantity(toInput(Math.floor(raw / step) * step, dp));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const body: PlaceOrderRequest = {
      symbol: instrument.symbol,
      side,
      type,
      quantity,
      clientOrderId: crypto.randomUUID(),
      ...(type === 'limit' ? { limitPrice: price } : {}),
      ...(type === 'stop_loss' || type === 'take_profit' ? { triggerPrice: price } : {}),
      ...(type === 'trailing_stop' ? { trailPercent: trail } : {}),
      ...(type !== 'limit' ? { maxSlippagePercent: slippage } : {}),
    };
    try {
      const order = await api.placeOrder(body);
      const p = instrument.pricePrecision;
      setResult({
        ok: true,
        text:
          order.status === 'filled'
            ? `${side === 'buy' ? 'Bought' : 'Sold'} ${order.quantity} ${instrument.base} at ${fmt(Number(order.averageFillPrice), p)}`
            : `${TYPE_LABEL[type]} order placed`,
      });
      setQuantity('');
      refresh();
    } catch (err) {
      setResult({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const priceLabel = type === 'limit' ? 'Limit price' : 'Trigger price';

  return (
    <section className="panel order-form">
      <h3>Place order</h3>
      <form onSubmit={submit}>
        <div className="side-toggle" role="group" aria-label="Side">
          <button type="button" className={side === 'buy' ? 'buy active' : 'buy'} onClick={() => setSide('buy')}>
            Buy
          </button>
          <button type="button" className={side === 'sell' ? 'sell active' : 'sell'} onClick={() => setSide('sell')}>
            Sell
          </button>
        </div>
        <label>
          Order type
          <select value={type} onChange={(e) => setType(e.target.value as OrderType)}>
            {ORDER_TYPES.map((ot) => (
              <option key={ot} value={ot}>
                {TYPE_LABEL[ot]}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">{TYPE_HELP[type]}</p>
        {needsPrice && (
          <label>
            {priceLabel} ({instrument.quote})
            <input
              inputMode="decimal"
              value={price}
              placeholder={marketPrice ? toInput(marketPrice, instrument.pricePrecision) : ''}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
              required
            />
          </label>
        )}
        {type === 'trailing_stop' && (
          <label>
            Trail (%)
            <input inputMode="decimal" value={trail} onChange={(e) => setTrail(e.target.value.replace(/[^\d.]/g, ''))} required />
          </label>
        )}
        {type !== 'limit' && (
          <label title="The order is rejected instead of filling at a price this much worse than expected.">
            Max slippage (%)
            <input inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value.replace(/[^\d.]/g, ''))} required />
          </label>
        )}
        <label>
          Quantity ({instrument.base})
          <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^\d.]/g, ''))} required />
        </label>
        <div className="pct">
          {[0.25, 0.5, 0.75, 1].map((p) => (
            <button type="button" key={p} onClick={() => fillPercent(p)}>
              {p * 100}%
            </button>
          ))}
        </div>
        <dl className="summary">
          <dt>Available</dt>
          <dd>
            {side === 'buy'
              ? `${fmt(availableQuote, 2)} ${instrument.quote}`
              : `${fmt(availableBase, instrument.sizePrecision)} ${instrument.base}`}
          </dd>
          <dt>{side === 'buy' ? 'Est. cost' : 'Est. proceeds'}</dt>
          <dd>{notional != null ? `${fmt(notional, 2)} ${instrument.quote}` : '—'}</dd>
          <dt>Est. fee</dt>
          <dd>{fee != null ? `${fmt(fee, 2)} ${instrument.quote}` : '—'}</dd>
        </dl>
        {halt && (
          <p className="halt-banner">
            Trading {halt.symbol ? `in ${halt.symbol} ` : ''}is paused{halt.until ? ` until ${new Date(halt.until).toLocaleTimeString()}` : ''}:{' '}
            {halt.reason}
          </p>
        )}
        {result && <p className={result.ok ? 'success small' : 'error'}>{result.text}</p>}
        <button className={side === 'buy' ? 'submit buy' : 'submit sell'} disabled={busy || !quantity || !!halt}>
          {side === 'buy' ? 'Buy' : 'Sell'} {instrument.base}
        </button>
        <p className="muted small">Paper trading: no real money is used.</p>
      </form>
    </section>
  );
}
