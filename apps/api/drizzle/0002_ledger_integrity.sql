-- Every ledger transaction must balance: for each asset its entries sum to zero.
-- Checked at commit (deferred), after all of a transaction's entries are written.
CREATE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE transaction_id = NEW.transaction_id
    GROUP BY asset
    HAVING sum(amount) <> 0
  ) THEN
    RAISE EXCEPTION 'ledger transaction % does not balance', NEW.transaction_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
--> statement-breakpoint
-- Ledger entries and transactions are append-only: corrections are new, reversing entries.
CREATE FUNCTION ledger_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();
--> statement-breakpoint
-- An account's stored balance must always equal the sum of its entries. Balances can
-- only change in the same transaction as the entries, so check that at commit too.
CREATE FUNCTION ledger_check_account_balance() RETURNS trigger AS $$
DECLARE
  entries_total numeric;
  current_balance numeric;
BEGIN
  -- Deferred, so NEW may be an intermediate value: compare the committed-to-be balance.
  SELECT balance INTO current_balance FROM ledger_accounts WHERE id = NEW.id;
  SELECT coalesce(sum(amount), 0) INTO entries_total FROM ledger_entries WHERE account_id = NEW.id;
  IF entries_total <> current_balance THEN
    RAISE EXCEPTION 'ledger account % balance % does not match its entries %', NEW.code, current_balance, entries_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_accounts_balance_matches
  AFTER UPDATE OF balance ON ledger_accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_account_balance();
