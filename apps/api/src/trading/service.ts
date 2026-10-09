import { EventEmitter } from 'node:events';
import { Decimal } from 'decimal.js';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_MAX_SLIPPAGE_PERCENT,
  type Fill,
  type Instrument,
  type Order,
  type PlaceOrderRequest,
  type Portfolio,
  type Ticker,
  type TradingHalt,
} from '@dta/shared';
import type { Db } from '../db/client.js';
import { fills, ledgerTransactions, orders, positions, type OrderRow } from '../db/schema.js';
import { HttpError, conflict } from '../lib/errors.js';
import type { MarketRegistry } from '../market/registry.js';
import type { HaltStore } from './halts.js';
import type { VolatilityBreaker } from './volatility-breaker.js';
import { InsufficientFundsError, holdPostings, isInsufficientFunds, postLedger, userBalances, type Posting } from './ledger.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Paper account starting balances. */
export const STARTING_BALANCES: Record<string, string> = { USD: '100000', USDT: '100000' };
/** Taker fee rate by asset class. Equities are commission-free, as at most US brokers. */
const FEE_RATE = { crypto: new Decimal('0.001'), equity: new Decimal(0) } as const;
const QUOTE_STALE_MS = 30_000;
const QUOTE_WAIT_MS = 5_000;
const IDLE_UNWATCH_MS = 60_000;
const TRAIL_PERSIST_MS = 1_000;
const MONEY_DP = 8;

const d = (v: Decimal.Value) => new Decimal(v);
const roundUp = (v: Decimal) => v.toDecimalPlaces(MONEY_DP, Decimal.ROUND_UP);
const roundDown = (v: Decimal) => v.toDecimalPlaces(MONEY_DP, Decimal.ROUND_DOWN);
const str = (v: Decimal.Value | null) => (v == null ? null : d(v).toFixed());

export function toOrder(o: OrderRow): Order {
  let trailStopPrice: string | null = null;
  if (o.type === 'trailing_stop' && o.trailReferencePrice && o.trailPercent) {
    const p = d(o.trailPercent).div(100);
    trailStopPrice = d(o.trailReferencePrice)
      .times(o.side === 'sell' ? d(1).minus(p) : d(1).plus(p))
      .toDecimalPlaces(MONEY_DP)
      .toFixed();
  }
  return {
    id: o.id,
    clientOrderId: o.clientOrderId,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    status: o.status,
    quantity: str(o.quantity)!,
    filledQuantity: str(o.filledQuantity)!,
    averageFillPrice: str(o.averageFillPrice),
    limitPrice: str(o.limitPrice),
    triggerPrice: str(o.triggerPrice),
    trailPercent: str(o.trailPercent),
    trailStopPrice,
    maxSlippagePercent: str(o.maxSlippagePercent),
    reason: o.reason,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

function decimalsOf(v: string): number {
  return v.split('.')[1]?.length ?? 0;
}

interface Quote {
  ticker: Ticker;
  at: number;
}

export interface TradingEvents {
  order: [userId: string, order: Order];
}

/** Pre-trade risk limits. */
export interface RiskLimits {
  /** Largest single order, in quote currency. */
  maxOrderNotional: number;
  maxOpenOrders: number;
  /** How far through the market a limit price may be before it is refused as a likely typo. */
  priceBandPercent: number;
}

export interface TradingOptions {
  limits: RiskLimits;
  breaker: VolatilityBreaker;
  halts: HaltStore;
}

export interface PlaceOrderMeta {
  apiKeyId?: string | null;
}

/**
 * Paper-trading order management: places and cancels orders, reserves funds, watches live
 * prices and fills orders when their conditions are met, recording everything in the ledger.
 */
export class TradingService extends EventEmitter<TradingEvents> {
  private readonly quotes = new Map<string, Quote>();
  private readonly watchers = new Map<string, { stop: () => void; idleTimer: NodeJS.Timeout | null }>();
  private readonly quoteWaiters = new Map<string, Set<() => void>>();
  private readonly open = new Map<string, Map<string, OrderRow>>();
  private readonly lastTrailPersist = new Map<string, number>();
  /** Per-symbol queue so price updates are processed one at a time, in order. */
  private readonly queues = new Map<string, Promise<void>>();

  private readonly limits: RiskLimits;
  readonly breaker: VolatilityBreaker;
  readonly halts: HaltStore;

  constructor(
    private readonly db: Db,
    private readonly market: MarketRegistry,
    private readonly log: FastifyBaseLogger,
    opts: TradingOptions,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.limits = opts.limits;
    this.breaker = opts.breaker;
    this.halts = opts.halts;
    // One listener per connected WebSocket.
    this.setMaxListeners(0);
  }

  /** Loads open orders and starts watching their markets. */
  async start(): Promise<void> {
    await this.halts.refresh();
    this.halts.start();
    const rows = await this.db.select().from(orders).where(eq(orders.status, 'open'));
    for (const o of rows) this.track(o);
  }

  stop(): void {
    this.halts.stop();
    for (const w of this.watchers.values()) {
      w.stop();
      if (w.idleTimer) clearTimeout(w.idleTimer);
    }
    this.watchers.clear();
  }

  /** Waits for in-flight price processing (tests use this to observe fills deterministically). */
  async idle(): Promise<void> {
    await Promise.all(this.queues.values());
  }

  // --- Accounts ---

  /** Credits the paper starting balances once per user. */
  async ensureFunded(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'fund:' + userId}))`);
      const [existing] = await tx
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(and(eq(ledgerTransactions.userId, userId), eq(ledgerTransactions.kind, 'deposit')))
        .limit(1);
      if (existing) return;
      const postings: Posting[] = Object.entries(STARTING_BALANCES).flatMap(([asset, amount]) => [
        { kind: 'funding' as const, asset, amount: d(amount).neg() },
        { kind: 'available' as const, userId, asset, amount: d(amount) },
      ]);
      await postLedger(tx, { kind: 'deposit', userId, description: 'Paper trading starting balance' }, postings);
    });
  }

  async portfolio(userId: string): Promise<Portfolio> {
    await this.ensureFunded(userId);
    const rows = await userBalances(this.db, userId);
    const byAsset = new Map<string, { available: Decimal; held: Decimal }>();
    for (const r of rows) {
      const b = byAsset.get(r.asset) ?? { available: d(0), held: d(0) };
      b[r.kind as 'available' | 'held'] = d(r.balance);
      byAsset.set(r.asset, b);
    }
    const pos = await this.db
      .select()
      .from(positions)
      .where(and(eq(positions.userId, userId), ne(positions.quantity, '0')));
    return {
      balances: [...byAsset]
        .filter(([, b]) => !b.available.isZero() || !b.held.isZero())
        .map(([asset, b]) => ({ asset, available: b.available.toFixed(), held: b.held.toFixed() }))
        .sort((a, b) => a.asset.localeCompare(b.asset)),
      positions: pos.map((p) => ({
        symbol: p.symbol,
        quantity: str(p.quantity)!,
        averageCost: str(p.averageCost)!,
        quoteAsset: p.quoteAsset,
        realizedPnl: str(p.realizedPnl)!,
      })),
    };
  }

  async listOrders(userId: string, status: 'open' | 'closed' | 'all', limit: number): Promise<Order[]> {
    const where =
      status === 'open'
        ? and(eq(orders.userId, userId), eq(orders.status, 'open'))
        : status === 'closed'
          ? and(eq(orders.userId, userId), ne(orders.status, 'open'))
          : eq(orders.userId, userId);
    const rows = await this.db.select().from(orders).where(where).orderBy(desc(orders.createdAt)).limit(limit);
    return rows.map(toOrder);
  }

  async listFills(userId: string, limit: number): Promise<Fill[]> {
    const rows = await this.db.select().from(fills).where(eq(fills.userId, userId)).orderBy(desc(fills.createdAt)).limit(limit);
    return rows.map((f) => ({
      id: f.id,
      orderId: f.orderId,
      symbol: f.symbol,
      side: f.side,
      quantity: str(f.quantity)!,
      price: str(f.price)!,
      fee: str(f.fee)!,
      feeAsset: f.feeAsset,
      createdAt: f.createdAt.toISOString(),
    }));
  }

  /** Current trading halts, manual and automatic. */
  async listHalts(): Promise<TradingHalt[]> {
    const manual = await this.halts.refresh();
    return [
      ...manual.map((h) => ({ symbol: h.symbol, kind: 'manual' as const, reason: h.reason, until: null })),
      ...this.breaker.list().map((h) => ({
        symbol: h.symbol,
        kind: 'automatic' as const,
        reason: h.reason,
        until: new Date(h.until).toISOString(),
      })),
    ];
  }

  /** Throws if new orders in `symbol` are paused. */
  private assertNotHalted(symbol: string): void {
    const manual = this.halts.haltFor(symbol);
    if (manual) {
      throw new HttpError(503, 'trading_halted', `Trading ${manual.symbol ? `in ${symbol} ` : ''}is paused: ${manual.reason}`);
    }
    const auto = this.breaker.haltFor(symbol);
    if (auto) {
      const until = new Date(auto.until).toISOString().slice(11, 16);
      throw new HttpError(503, 'trading_halted', `Trading in ${symbol} is paused until ${until} UTC. ${auto.reason}.`);
    }
  }

  private isHalted(symbol: string): boolean {
    return this.halts.haltFor(symbol) !== null || this.breaker.haltFor(symbol) !== null;
  }

  // --- Orders ---

  async placeOrder(userId: string, req: PlaceOrderRequest, meta: PlaceOrderMeta = {}): Promise<Order> {
    const instrument = this.market.instrument(req.symbol);
    if (!instrument) throw new HttpError(404, 'unknown_symbol', `Unknown symbol ${req.symbol}`);
    this.validatePrecision(instrument, req);
    await this.halts.refresh();
    this.assertNotHalted(instrument.symbol);

    if (req.clientOrderId) {
      const [existing] = await this.db
        .select()
        .from(orders)
        .where(and(eq(orders.userId, userId), eq(orders.clientOrderId, req.clientOrderId)));
      if (existing) return toOrder(existing);
    }

    await this.ensureFunded(userId);
    const ticker = await this.quote(req.symbol);
    // The quote may have tripped the breaker.
    this.assertNotHalted(instrument.symbol);
    const snap = (v: number) => d(v).toDecimalPlaces(instrument.pricePrecision);
    const last = snap(ticker.last);
    const qty = d(req.quantity);
    const trigger = req.triggerPrice ? d(req.triggerPrice) : null;
    const slippage = req.type === 'limit' ? null : d(req.maxSlippagePercent ?? DEFAULT_MAX_SLIPPAGE_PERCENT);

    if (req.type === 'stop_loss' && trigger) {
      if (req.side === 'sell' && trigger.gte(last)) throw badOrder('A sell stop-loss must be below the current price');
      if (req.side === 'buy' && trigger.lte(last)) throw badOrder('A buy stop-loss must be above the current price');
    }
    if (req.type === 'take_profit' && trigger) {
      if (req.side === 'sell' && trigger.lte(last)) throw badOrder('A sell take-profit must be above the current price');
      if (req.side === 'buy' && trigger.gte(last)) throw badOrder('A buy take-profit must be below the current price');
    }

    if (req.type === 'limit') {
      // Fat-finger check: a limit far through the market is almost always a typo.
      const limit = d(req.limitPrice!);
      const band = d(this.limits.priceBandPercent).div(100);
      if (req.side === 'buy' && limit.gt(last.times(d(1).plus(band)))) {
        throw badOrder(`A buy limit more than ${this.limits.priceBandPercent}% above the current price looks like a typo`);
      }
      if (req.side === 'sell' && limit.lt(last.times(d(1).minus(band)))) {
        throw badOrder(`A sell limit more than ${this.limits.priceBandPercent}% below the current price looks like a typo`);
      }
    }

    // The price the order is expected to trade near, for size limits.
    const expected = req.type === 'limit' ? d(req.limitPrice!) : trigger ?? last;
    if (qty.times(expected).gt(this.limits.maxOrderNotional)) {
      throw badOrder(`Orders are limited to ${this.limits.maxOrderNotional.toLocaleString('en-US')} ${instrument.quote} each`);
    }

    const fee = FEE_RATE[instrument.assetClass];
    const heldAsset = req.side === 'buy' ? instrument.quote : instrument.base;
    let held: Decimal;
    if (req.side === 'sell') {
      held = qty;
    } else {
      // Reserve the worst price the order can fill at: its limit, or its reference price plus
      // the slippage allowance (worse fills are rejected). A buy trailing stop's level only
      // moves down from where it starts.
      const worst = d(1).plus(slippage?.div(100) ?? 0);
      const ref =
        req.type === 'market'
          ? last.times(worst)
          : req.type === 'limit'
            ? d(req.limitPrice!)
            : req.type === 'trailing_stop'
              ? last.times(d(1).plus(d(req.trailPercent!).div(100))).times(worst)
              : trigger!.times(worst);
      held = roundUp(qty.times(ref).times(d(1).plus(fee)));
    }

    let row: OrderRow;
    try {
      row = await this.db.transaction(async (tx) => {
        // Serialise a user's placements so the open-order cap cannot be raced past.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'orders:' + userId}))`);
        const [open] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(orders)
          .where(and(eq(orders.userId, userId), eq(orders.status, 'open')));
        if ((open?.n ?? 0) >= this.limits.maxOpenOrders) {
          throw conflict('too_many_open_orders', `You can have at most ${this.limits.maxOpenOrders} open orders`);
        }
        const [o] = await tx
          .insert(orders)
          .values({
            userId,
            clientOrderId: req.clientOrderId,
            symbol: instrument.symbol,
            baseAsset: instrument.base,
            quoteAsset: instrument.quote,
            side: req.side,
            type: req.type,
            status: 'open',
            quantity: qty.toFixed(),
            limitPrice: req.limitPrice,
            triggerPrice: req.triggerPrice,
            trailPercent: req.trailPercent,
            trailReferencePrice: req.type === 'trailing_stop' ? last.toFixed() : null,
            maxSlippagePercent: slippage?.toFixed() ?? null,
            apiKeyId: meta.apiKeyId ?? null,
            heldAmount: held.toFixed(),
            heldAsset,
          })
          .returning();
        await postLedger(
          tx,
          { kind: 'hold', userId, orderId: o!.id, description: `Hold for ${req.side} ${req.symbol}` },
          holdPostings(userId, heldAsset, held, 'hold'),
        );
        return o!;
      });
    } catch (err) {
      if (isInsufficientFunds(err)) {
        throw new InsufficientFundsError(
          req.side === 'sell' ? `Not enough ${instrument.base} to sell` : `Not enough ${instrument.quote} for this order`,
        );
      }
      if ((err as { cause?: { code?: string } }).cause?.code === '23505' && req.clientOrderId) {
        // Lost a race with a retry of the same request.
        const [existing] = await this.db
          .select()
          .from(orders)
          .where(and(eq(orders.userId, userId), eq(orders.clientOrderId, req.clientOrderId)));
        if (existing) return toOrder(existing);
      }
      throw err;
    }

    this.emit('order', userId, toOrder(row));
    this.track(row);
    // Market and marketable limit orders fill straight away.
    await this.enqueue(row.symbol, () => this.evaluate(row, ticker));
    const [latest] = await this.db.select().from(orders).where(eq(orders.id, row.id));
    return toOrder(latest!);
  }

  async cancelOrder(userId: string, orderId: string): Promise<Order> {
    const row = await this.db.transaction(async (tx) => {
      const [o] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
        .for('update');
      if (!o) throw new HttpError(404, 'not_found', 'Order not found');
      if (o.status !== 'open') throw conflict('order_not_open', `Order is already ${o.status}`);
      return this.closeOrder(tx, o, 'cancelled', 'Cancelled by you');
    });
    this.untrack(row);
    this.emit('order', userId, toOrder(row));
    return toOrder(row);
  }

  // --- Execution ---

  private validatePrecision(instrument: Instrument, req: PlaceOrderRequest): void {
    if (decimalsOf(req.quantity) > instrument.sizePrecision) {
      throw badOrder(
        instrument.sizePrecision === 0
          ? `${instrument.symbol} trades in whole units`
          : `Quantity can have at most ${instrument.sizePrecision} decimal places`,
      );
    }
    for (const price of [req.limitPrice, req.triggerPrice]) {
      if (price && decimalsOf(price) > instrument.pricePrecision) {
        throw badOrder(`Prices can have at most ${instrument.pricePrecision} decimal places`);
      }
    }
  }

  /** Latest price for a symbol, subscribing and waiting briefly if there is none yet. */
  private async quote(symbol: string): Promise<Ticker> {
    this.watch(symbol);
    const fresh = () => {
      const q = this.quotes.get(symbol);
      return q && this.now() - q.at < QUOTE_STALE_MS ? q.ticker : null;
    };
    const ready = fresh();
    if (ready) return ready;
    await new Promise<void>((resolve) => {
      const waiters = this.quoteWaiters.get(symbol) ?? new Set();
      this.quoteWaiters.set(symbol, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, QUOTE_WAIT_MS);
      waiters.add(done);
    });
    const after = fresh();
    if (!after) throw new HttpError(503, 'no_market_data', `No live price for ${symbol} right now, so the order was not placed`);
    return after;
  }

  private watch(symbol: string): void {
    const existing = this.watchers.get(symbol);
    if (existing) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
      this.scheduleUnwatch(symbol);
      return;
    }
    const provider = this.market.provider(symbol);
    if (!provider) return;
    const stop = provider.subscribe({ kind: 'ticker', symbol }, (ev) => {
      if (ev.type !== 'ticker') return;
      const halt = this.breaker.record(symbol, ev.data.last);
      if (halt) this.log.warn({ symbol, reason: halt.reason, until: new Date(halt.until) }, 'Circuit breaker tripped');
      this.quotes.set(symbol, { ticker: ev.data, at: this.now() });
      for (const w of this.quoteWaiters.get(symbol) ?? []) w();
      if (this.open.get(symbol)?.size) void this.enqueue(symbol, () => this.onTicker(symbol, ev.data));
    });
    this.watchers.set(symbol, { stop, idleTimer: null });
    this.scheduleUnwatch(symbol);
  }

  /** Stops watching a symbol a while after its last use, unless it has open orders. */
  private scheduleUnwatch(symbol: string): void {
    const w = this.watchers.get(symbol);
    if (!w || this.open.get(symbol)?.size) return;
    w.idleTimer = setTimeout(() => {
      if (this.open.get(symbol)?.size) return;
      w.stop();
      this.watchers.delete(symbol);
      this.quotes.delete(symbol);
    }, IDLE_UNWATCH_MS);
    w.idleTimer.unref();
  }

  private track(o: OrderRow): void {
    const m = this.open.get(o.symbol) ?? new Map<string, OrderRow>();
    m.set(o.id, o);
    this.open.set(o.symbol, m);
    this.watch(o.symbol);
  }

  private untrack(o: OrderRow): void {
    this.open.get(o.symbol)?.delete(o.id);
    this.lastTrailPersist.delete(o.id);
    if (!this.open.get(o.symbol)?.size) this.scheduleUnwatch(o.symbol);
  }

  private enqueue(symbol: string, task: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(symbol) ?? Promise.resolve())
      .then(task)
      .catch((err) => this.log.error({ err, symbol }, 'Order processing failed'));
    this.queues.set(symbol, next);
    return next;
  }

  private async onTicker(symbol: string, ticker: Ticker): Promise<void> {
    for (const o of [...(this.open.get(symbol)?.values() ?? [])]) await this.evaluate(o, ticker);
  }

  /** Decides whether an open order should fill at this price, and at what price. */
  private async evaluate(o: OrderRow, t: Ticker): Promise<void> {
    if (!this.open.get(o.symbol)?.has(o.id)) return;
    // While halted, nothing triggers or fills; orders wait for trading to resume.
    if (this.isHalted(o.symbol)) return;
    // Feeds deliver floating-point numbers (220.4 - 0.01 = 220.39000000000001); snap to the tick size.
    const dp = this.market.instrument(o.symbol)?.pricePrecision ?? MONEY_DP;
    const px = (v: number) => d(v).toDecimalPlaces(dp);
    const last = px(t.last);
    const bid = px(t.bid ?? t.last);
    const ask = px(t.ask ?? t.last);
    const buy = o.side === 'buy';
    const marketPrice = buy ? ask : bid;
    let fillAt: Decimal | null = null;
    // What a market-priced fill is measured against for slippage protection.
    let reference: Decimal | null = null;

    switch (o.type) {
      case 'market':
        fillAt = marketPrice;
        reference = last;
        break;
      case 'limit': {
        const limit = d(o.limitPrice!);
        if (buy ? ask.lte(limit) : bid.gte(limit)) fillAt = marketPrice;
        break;
      }
      case 'stop_loss': {
        const trigger = d(o.triggerPrice!);
        if (buy ? last.gte(trigger) : last.lte(trigger)) fillAt = marketPrice;
        reference = trigger;
        break;
      }
      case 'take_profit': {
        const trigger = d(o.triggerPrice!);
        if (buy ? last.lte(trigger) : last.gte(trigger)) fillAt = marketPrice;
        reference = trigger;
        break;
      }
      case 'trailing_stop': {
        const pct = d(o.trailPercent!).div(100);
        let ref = d(o.trailReferencePrice ?? t.last);
        const better = buy ? last.lt(ref) : last.gt(ref);
        if (better) {
          ref = last;
          o.trailReferencePrice = ref.toFixed();
          await this.persistTrail(o);
        }
        const stop = buy ? ref.times(d(1).plus(pct)) : ref.times(d(1).minus(pct));
        if (buy ? last.gte(stop) : last.lte(stop)) fillAt = marketPrice;
        reference = stop;
        break;
      }
    }
    if (!fillAt) return;

    if (reference && o.maxSlippagePercent) {
      const allowed = d(o.maxSlippagePercent).div(100);
      const worst = buy ? reference.times(d(1).plus(allowed)) : reference.times(d(1).minus(allowed));
      if (buy ? fillAt.gt(worst) : fillAt.lt(worst)) {
        const off = fillAt.minus(reference).abs().div(reference).times(100).toDecimalPlaces(2);
        await this.reject(
          o,
          `Slippage protection: the ${buy ? 'ask' : 'bid'} was ${fillAt.toFixed()}, ${off.toFixed()}% from ` +
            `${reference.toFixed()}, beyond your ${d(o.maxSlippagePercent).toFixed()}% limit`,
        );
        return;
      }
    }
    await this.fill(o, fillAt);
  }

  private async reject(o: OrderRow, reason: string): Promise<void> {
    const row = await this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(orders).where(eq(orders.id, o.id)).for('update');
      if (!cur || cur.status !== 'open') return null;
      return this.closeOrder(tx, cur, 'rejected', reason);
    });
    this.untrack(row ?? o);
    if (row) this.emit('order', row.userId, toOrder(row));
  }

  private async persistTrail(o: OrderRow): Promise<void> {
    const at = this.now();
    if (at - (this.lastTrailPersist.get(o.id) ?? 0) < TRAIL_PERSIST_MS) return;
    this.lastTrailPersist.set(o.id, at);
    const [row] = await this.db
      .update(orders)
      .set({ trailReferencePrice: o.trailReferencePrice, updatedAt: new Date(at) })
      .where(and(eq(orders.id, o.id), eq(orders.status, 'open')))
      .returning();
    if (row) this.emit('order', row.userId, toOrder(row));
  }

  private async fill(o: OrderRow, price: Decimal): Promise<void> {
    const instrument = this.market.instrument(o.symbol);
    const feeRate = instrument ? FEE_RATE[instrument.assetClass] : d(0);
    let row: OrderRow | null;
    try {
      row = await this.db.transaction(async (tx) => {
        const [cur] = await tx.select().from(orders).where(eq(orders.id, o.id)).for('update');
        if (!cur || cur.status !== 'open') return null;
        return this.executeFill(tx, cur, price, feeRate);
      });
    } catch (err) {
      if (!isInsufficientFunds(err)) throw err;
      // The price moved past what was reserved and the account cannot cover the difference.
      row = await this.db.transaction(async (tx) => {
        const [cur] = await tx.select().from(orders).where(eq(orders.id, o.id)).for('update');
        if (!cur || cur.status !== 'open') return null;
        return this.closeOrder(tx, cur, 'rejected', 'Not enough funds at the fill price');
      });
    }
    if (!row) {
      this.untrack(o);
      return;
    }
    this.untrack(row);
    this.emit('order', row.userId, toOrder(row));
  }

  private async executeFill(tx: Tx, o: OrderRow, price: Decimal, feeRate: Decimal): Promise<OrderRow> {
    const userId = o.userId;
    const qty = d(o.quantity).minus(o.filledQuantity);
    const cost = qty.times(price);
    const fee = roundUp(cost.times(feeRate));
    const base = o.baseAsset;
    const quote = o.quoteAsset;

    await postLedger(
      tx,
      { kind: 'release', userId, orderId: o.id, description: 'Release hold at fill' },
      holdPostings(userId, o.heldAsset, d(o.heldAmount), 'release'),
    );
    const trade: Posting[] =
      o.side === 'buy'
        ? [
            { kind: 'available', userId, asset: quote, amount: cost.plus(fee).neg() },
            { kind: 'market', asset: quote, amount: cost },
            { kind: 'fees', asset: quote, amount: fee },
            { kind: 'market', asset: base, amount: qty.neg() },
            { kind: 'available', userId, asset: base, amount: qty },
          ]
        : [
            { kind: 'available', userId, asset: base, amount: qty.neg() },
            { kind: 'market', asset: base, amount: qty },
            { kind: 'market', asset: quote, amount: cost.neg() },
            { kind: 'available', userId, asset: quote, amount: cost.minus(fee) },
            { kind: 'fees', asset: quote, amount: fee },
          ];
    const ledgerTransactionId = await postLedger(
      tx,
      { kind: 'trade', userId, orderId: o.id, description: `${o.side} ${qty.toFixed()} ${o.symbol} @ ${price.toFixed()}` },
      trade,
    );
    await tx.insert(fills).values({
      orderId: o.id,
      userId,
      symbol: o.symbol,
      side: o.side,
      quantity: qty.toFixed(),
      price: price.toFixed(),
      fee: fee.toFixed(),
      feeAsset: quote,
      ledgerTransactionId,
    });
    await this.applyToPosition(tx, o, qty, price, fee);
    const [updated] = await tx
      .update(orders)
      .set({
        status: 'filled',
        filledQuantity: o.quantity,
        averageFillPrice: price.toFixed(),
        heldAmount: '0',
        updatedAt: new Date(this.now()),
      })
      .where(eq(orders.id, o.id))
      .returning();
    return updated!;
  }

  /** Average-cost accounting: buys blend into the cost basis, sells realise P&L against it. */
  private async applyToPosition(tx: Tx, o: OrderRow, qty: Decimal, price: Decimal, fee: Decimal): Promise<void> {
    await tx
      .insert(positions)
      .values({ userId: o.userId, symbol: o.symbol, baseAsset: o.baseAsset, quoteAsset: o.quoteAsset })
      .onConflictDoNothing();
    const [p] = await tx
      .select()
      .from(positions)
      .where(and(eq(positions.userId, o.userId), eq(positions.symbol, o.symbol)))
      .for('update');
    const q0 = d(p!.quantity);
    const avg0 = d(p!.averageCost);
    let quantity: Decimal;
    let averageCost: Decimal;
    let realized = d(p!.realizedPnl).minus(fee);
    if (o.side === 'buy') {
      quantity = q0.plus(qty);
      averageCost = q0.times(avg0).plus(qty.times(price)).div(quantity).toDecimalPlaces(18);
    } else {
      quantity = q0.minus(qty);
      averageCost = quantity.isZero() ? d(0) : avg0;
      realized = realized.plus(qty.times(price.minus(avg0)));
    }
    await tx
      .update(positions)
      .set({
        quantity: quantity.toFixed(),
        averageCost: averageCost.toFixed(),
        realizedPnl: roundDown(realized).toFixed(),
        updatedAt: new Date(this.now()),
      })
      .where(and(eq(positions.userId, o.userId), eq(positions.symbol, o.symbol)));
  }

  private async closeOrder(tx: Tx, o: OrderRow, status: 'cancelled' | 'rejected', reason: string): Promise<OrderRow> {
    await postLedger(
      tx,
      { kind: 'release', userId: o.userId, orderId: o.id, description: `Release hold: ${status}` },
      holdPostings(o.userId, o.heldAsset, d(o.heldAmount), 'release'),
    );
    const [updated] = await tx
      .update(orders)
      .set({ status, reason, heldAmount: '0', updatedAt: new Date(this.now()) })
      .where(eq(orders.id, o.id))
      .returning();
    return updated!;
  }

  // --- Integrity ---

  /**
   * Cross-checks the books: every asset nets to zero across all accounts, and each position's
   * quantity equals the user's available plus held balance of that asset.
   */
  async reconcile(): Promise<string[]> {
    const problems: string[] = [];
    const sums = await this.db.execute<{ asset: string; total: string }>(
      sql`select asset, sum(amount)::text as total from ledger_entries group by asset having sum(amount) <> 0`,
    );
    for (const r of sums.rows) problems.push(`Ledger for ${r.asset} does not net to zero (${r.total})`);
    const mismatched = await this.db.execute<{ user_id: string; symbol: string; position: string; ledger: string }>(sql`
      select p.user_id, p.symbol, p.quantity::text as position, coalesce(sum(a.balance), 0)::text as ledger
      from positions p
      left join ledger_accounts a on a.user_id = p.user_id and a.asset = p.base_asset and a.kind in ('available', 'held')
      group by p.user_id, p.symbol, p.quantity
      having p.quantity <> coalesce(sum(a.balance), 0)`);
    for (const r of mismatched.rows) {
      problems.push(`Position ${r.symbol} for user ${r.user_id} is ${r.position} but the ledger holds ${r.ledger}`);
    }
    return problems;
  }
}

function badOrder(message: string): HttpError {
  return new HttpError(400, 'invalid_order', message);
}

