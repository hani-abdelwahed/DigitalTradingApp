import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  inet,
  check,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    // AES-256-GCM ciphertext of the base32 TOTP secret; set during setup, before it is enabled.
    mfaSecretEnc: text('mfa_secret_enc'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    // Last accepted TOTP time step, so a code cannot be replayed within its window.
    mfaLastStep: bigint('mfa_last_step', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

// One row per signed-in device. The refresh token itself is never stored, only its SHA-256.
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sessions_refresh_token_hash_key').on(t.refreshTokenHash),
    index('sessions_user_id_idx').on(t.userId),
  ],
);

// Append-only record of security-relevant events.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    event: text('event').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_user_id_created_at_idx').on(t.userId, t.createdAt)],
);

/**
 * Long-lived credentials for programs. Keys look like `dta_<prefix>_<secret>`; only the
 * SHA-256 of the whole key is stored, and the prefix is kept to find the row and to tell keys apart.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes', { enum: ['read', 'trade'] }).array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('api_keys_prefix_key').on(t.prefix), index('api_keys_user_id_idx').on(t.userId)],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;

// --- Trading: double-entry ledger, orders, fills ---

const amount = (name: string) => numeric(name, { precision: 38, scale: 18 });

/**
 * One account per (owner, purpose, asset). User accounts are `available` funds and `held`
 * funds reserved by open orders; both are kept non-negative by a check constraint, so the
 * database itself refuses to overspend. System accounts (`funding`, `market`, `fees`) are
 * the other side of deposits, trades and fees and may go negative.
 */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: ['available', 'held', 'funding', 'market', 'fees'] }).notNull(),
    asset: text('asset').notNull(),
    balance: amount('balance').notNull().default('0'),
    allowNegative: boolean('allow_negative').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ledger_accounts_code_key').on(t.code),
    index('ledger_accounts_user_id_idx').on(t.userId),
    check('ledger_accounts_non_negative', sql`${t.allowNegative} OR ${t.balance} >= 0`),
  ],
);

/** A balanced set of entries: for every asset, the entries sum to zero (enforced by a trigger). */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: ['deposit', 'hold', 'release', 'trade'] }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id'),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ledger_transactions_user_id_idx').on(t.userId, t.createdAt)],
);

/** Append-only: a trigger rejects updates and deletes. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    asset: text('asset').notNull(),
    amount: amount('amount').notNull(),
  },
  (t) => [
    index('ledger_entries_transaction_id_idx').on(t.transactionId),
    index('ledger_entries_account_id_idx').on(t.accountId),
    check('ledger_entries_non_zero', sql`${t.amount} <> 0`),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    clientOrderId: text('client_order_id'),
    symbol: text('symbol').notNull(),
    baseAsset: text('base_asset').notNull(),
    quoteAsset: text('quote_asset').notNull(),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    type: text('type', { enum: ['market', 'limit', 'stop_loss', 'take_profit', 'trailing_stop'] }).notNull(),
    status: text('status', { enum: ['open', 'filled', 'cancelled', 'rejected'] }).notNull(),
    quantity: amount('quantity').notNull(),
    filledQuantity: amount('filled_quantity').notNull().default('0'),
    averageFillPrice: amount('average_fill_price'),
    limitPrice: amount('limit_price'),
    triggerPrice: amount('trigger_price'),
    trailPercent: numeric('trail_percent', { precision: 5, scale: 2 }),
    /** Trailing stops: best price seen since placement (highest for sells, lowest for buys). */
    trailReferencePrice: amount('trail_reference_price'),
    /** Reject instead of filling if the fill price is this many percent worse than the reference. */
    maxSlippagePercent: numeric('max_slippage_percent', { precision: 4, scale: 2 }),
    /** Set when the order came in through an API key rather than the web app. */
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    /** Funds reserved for this order (quote asset for buys, base asset for sells). */
    heldAmount: amount('held_amount').notNull().default('0'),
    heldAsset: text('held_asset').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_user_client_order_id_key').on(t.userId, t.clientOrderId),
    index('orders_user_id_created_at_idx').on(t.userId, t.createdAt),
    index('orders_open_idx').on(t.symbol).where(sql`${t.status} = 'open'`),
    check('orders_quantity_positive', sql`${t.quantity} > 0`),
    check('orders_filled_within_quantity', sql`${t.filledQuantity} >= 0 AND ${t.filledQuantity} <= ${t.quantity}`),
  ],
);

export const fills = pgTable(
  'fills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    symbol: text('symbol').notNull(),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    quantity: amount('quantity').notNull(),
    price: amount('price').notNull(),
    fee: amount('fee').notNull(),
    feeAsset: text('fee_asset').notNull(),
    ledgerTransactionId: uuid('ledger_transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('fills_user_id_created_at_idx').on(t.userId, t.createdAt)],
);

/**
 * Average-cost projection of each holding, updated with every fill. Quantities must always
 * match the ledger (available + held of the base asset); a reconciliation check verifies it.
 */
export const positions = pgTable(
  'positions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    symbol: text('symbol').notNull(),
    baseAsset: text('base_asset').notNull(),
    quoteAsset: text('quote_asset').notNull(),
    quantity: amount('quantity').notNull().default('0'),
    averageCost: amount('average_cost').notNull().default('0'),
    realizedPnl: amount('realized_pnl').notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('positions_user_symbol_key').on(t.userId, t.symbol)],
);

export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type FillRow = typeof fills.$inferSelect;
