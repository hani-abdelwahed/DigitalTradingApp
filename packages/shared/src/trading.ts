import { z } from 'zod';

// Quantities and prices travel as decimal strings so no precision is lost to floating point.
const decimal = z
  .string()
  .regex(/^\d{1,20}(\.\d{1,18})?$/, 'Must be a positive decimal number')
  .refine((v) => Number(v) > 0, 'Must be greater than zero');

export const DEFAULT_MAX_SLIPPAGE_PERCENT = '2';

export const ORDER_TYPES = ['market', 'limit', 'stop_loss', 'take_profit', 'trailing_stop'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'rejected';

export const placeOrderRequest = z
  .object({
    symbol: z.string().min(1).max(25),
    side: z.enum(['buy', 'sell']),
    type: z.enum(ORDER_TYPES),
    quantity: decimal,
    /** Limit orders: the worst price you accept. */
    limitPrice: decimal.optional(),
    /** Stop-loss and take-profit: the price that triggers a market order. */
    triggerPrice: decimal.optional(),
    /** Trailing stop: distance from the best price since placement, in percent. */
    trailPercent: z
      .string()
      .regex(/^\d{1,2}(\.\d{1,2})?$/)
      .refine((v) => Number(v) >= 0.1 && Number(v) <= 50, 'Trail must be between 0.1% and 50%')
      .optional(),
    /**
     * Slippage protection for orders that fill at the market price (all but limit orders):
     * the order is rejected rather than filled if the price is worse than the reference by
     * more than this percentage. The reference is the quote at placement for market orders,
     * and the trigger or stop level for the others. Defaults to DEFAULT_MAX_SLIPPAGE_PERCENT.
     */
    maxSlippagePercent: z
      .string()
      .regex(/^\d{1,2}(\.\d{1,2})?$/)
      .refine((v) => Number(v) >= 0.01 && Number(v) <= 10, 'Slippage limit must be between 0.01% and 10%')
      .optional(),
    /** Optional idempotency key: resending the same key returns the original order. */
    clientOrderId: z.string().min(1).max(64).regex(/^[\w-]+$/).optional(),
  })
  .superRefine((o, ctx) => {
    const need = (field: 'limitPrice' | 'triggerPrice' | 'trailPercent', label: string) => {
      if (!o[field]) ctx.addIssue({ code: 'custom', path: [field], message: `${label} is required` });
    };
    const forbid = (field: 'limitPrice' | 'triggerPrice' | 'trailPercent') => {
      if (o[field]) ctx.addIssue({ code: 'custom', path: [field], message: `Not used by ${o.type} orders` });
    };
    if (o.type === 'limit') need('limitPrice', 'Limit price');
    else forbid('limitPrice');
    if (o.type === 'stop_loss' || o.type === 'take_profit') need('triggerPrice', 'Trigger price');
    else forbid('triggerPrice');
    if (o.type === 'trailing_stop') need('trailPercent', 'Trail percent');
    else forbid('trailPercent');
    // A limit price already caps the fill price.
    if (o.type === 'limit' && o.maxSlippagePercent) {
      ctx.addIssue({ code: 'custom', path: ['maxSlippagePercent'], message: 'Not used by limit orders' });
    }
  });
export type PlaceOrderRequest = z.infer<typeof placeOrderRequest>;

export interface Order {
  id: string;
  clientOrderId: string | null;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  quantity: string;
  filledQuantity: string;
  averageFillPrice: string | null;
  limitPrice: string | null;
  triggerPrice: string | null;
  trailPercent: string | null;
  /** Trailing stops: the current stop level, which moves with the market. */
  trailStopPrice: string | null;
  /** Slippage limit in percent; null for limit orders. */
  maxSlippagePercent: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: string;
  price: string;
  fee: string;
  feeAsset: string;
  createdAt: string;
}

export interface Balance {
  asset: string;
  available: string;
  /** Reserved by open orders. */
  held: string;
}

export interface Position {
  symbol: string;
  quantity: string;
  averageCost: string;
  quoteAsset: string;
  realizedPnl: string;
}

export interface Portfolio {
  balances: Balance[];
  positions: Position[];
}

export const ordersQuery = z.object({
  status: z.enum(['open', 'closed', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** A pause on new orders and order triggers, for one symbol or (symbol null) everything. */
export interface TradingHalt {
  symbol: string | null;
  /** `automatic` halts come from the volatility circuit breaker; `manual` ones from an operator. */
  kind: 'automatic' | 'manual';
  reason: string;
  /** When trading resumes; null until an operator lifts it. */
  until: string | null;
}
