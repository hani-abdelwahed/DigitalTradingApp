import { Decimal } from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../db/schema.js';
import { HttpError } from '../lib/errors.js';

export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Parameters<Parameters<Db['transaction']>[0]>[0];

export type UserAccountKind = 'available' | 'held';
export type SystemAccountKind = 'funding' | 'market' | 'fees';

export type Posting =
  | { kind: UserAccountKind; userId: string; asset: string; amount: Decimal }
  | { kind: SystemAccountKind; asset: string; amount: Decimal };

export class InsufficientFundsError extends HttpError {
  constructor(message = 'Not enough funds for this order') {
    super(400, 'insufficient_funds', message);
  }
}

export function accountCode(p: Posting): string {
  return p.kind === 'available' || p.kind === 'held'
    ? `user:${p.userId}:${p.kind}:${p.asset}`
    : `system:${p.kind}:${p.asset}`;
}

/** True when a database error is the check that keeps user balances non-negative. */
export function isInsufficientFunds(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { constraint?: string }).constraint === 'ledger_accounts_non_negative') return true;
  }
  return false;
}

/**
 * Records one balanced ledger transaction and applies it to account balances. Must run inside
 * a database transaction. Entries for each asset must sum to zero; the database checks this
 * again at commit, along with non-negative user balances and balances matching their entries.
 */
export async function postLedger(
  tx: Executor,
  meta: { kind: 'deposit' | 'hold' | 'release' | 'trade'; userId?: string; orderId?: string; description?: string },
  postings: Posting[],
): Promise<string> {
  const lines = postings.filter((p) => !p.amount.isZero());
  const totals = new Map<string, Decimal>();
  for (const p of lines) totals.set(p.asset, (totals.get(p.asset) ?? new Decimal(0)).plus(p.amount));
  for (const [asset, total] of totals) {
    if (!total.isZero()) throw new Error(`Unbalanced ledger posting for ${asset}: ${total.toFixed()}`);
  }

  const codes = [...new Set(lines.map(accountCode))];
  await tx
    .insert(ledgerAccounts)
    .values(
      lines.map((p) => ({
        code: accountCode(p),
        kind: p.kind,
        asset: p.asset,
        userId: 'userId' in p ? p.userId : null,
        allowNegative: !('userId' in p),
      })),
    )
    .onConflictDoNothing({ target: ledgerAccounts.code });
  const accounts = await tx
    .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
    .from(ledgerAccounts)
    .where(inArray(ledgerAccounts.code, codes));
  const idByCode = new Map(accounts.map((a) => [a.code, a.id]));

  const [txn] = await tx
    .insert(ledgerTransactions)
    .values({ kind: meta.kind, userId: meta.userId, orderId: meta.orderId, description: meta.description })
    .returning({ id: ledgerTransactions.id });
  await tx.insert(ledgerEntries).values(
    lines.map((p) => ({ transactionId: txn!.id, accountId: idByCode.get(accountCode(p))!, asset: p.asset, amount: p.amount.toFixed() })),
  );

  // Update balances in a fixed (id) order so concurrent transactions cannot deadlock.
  const deltas = new Map<string, Decimal>();
  for (const p of lines) {
    const id = idByCode.get(accountCode(p))!;
    deltas.set(id, (deltas.get(id) ?? new Decimal(0)).plus(p.amount));
  }
  for (const id of [...deltas.keys()].sort()) {
    await tx
      .update(ledgerAccounts)
      .set({ balance: sql`${ledgerAccounts.balance} + ${deltas.get(id)!.toFixed()}` })
      .where(eq(ledgerAccounts.id, id));
  }
  return txn!.id;
}

/** Moves `amount` between a user's available and held balances. */
export function holdPostings(userId: string, asset: string, amount: Decimal, direction: 'hold' | 'release'): Posting[] {
  const sign = direction === 'hold' ? 1 : -1;
  return [
    { kind: 'available', userId, asset, amount: amount.times(-sign) },
    { kind: 'held', userId, asset, amount: amount.times(sign) },
  ];
}

export async function userBalances(db: DbOrTx, userId: string) {
  return db
    .select({ kind: ledgerAccounts.kind, asset: ledgerAccounts.asset, balance: ledgerAccounts.balance })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.userId, userId), inArray(ledgerAccounts.kind, ['available', 'held'])));
}
